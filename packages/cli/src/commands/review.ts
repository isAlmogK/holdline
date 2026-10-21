import { createInterface } from 'node:readline'
import { approve, reject } from '@holdline/core'
import { UsageError, type Io } from '../io.js'
import { approver, loadPending, loadRules, savePending, saveRules, today } from '../workspace.js'
import { writeTests } from './approve.js'

export async function reviewCommand(io: Io): Promise<number> {
  if (!io.stdin) throw new UsageError('review needs an interactive terminal')
  let pending = await loadPending(io.cwd)
  let file = await loadRules(io.cwd)
  if (pending.rules.length === 0) {
    io.stdout('Nothing to review. Propose rules first: holdline infer --prompt | <your agent> > proposals.json && holdline propose proposals.json\n')
    return 0
  }
  const rl = createInterface({ input: io.stdin, terminal: false })
  const answers = rl[Symbol.asyncIterator]()
  try {
    for (const p of [...pending.rules]) {
      io.stdout(`\n${p.key} ${p.classification === 'broken' ? '? looks broken today' : '✓ holds today'}\n  ${p.rule.text}\n`)
      for (const v of p.violations) io.stdout(`  ${v}\n`)
      if (p.rule.evidence.length > 0) io.stdout(`  evidence: ${p.rule.evidence.join(', ')}\n`)
      let answer = ''
      for (;;) {
        io.stdout('[a]pprove  [r]eject  [s]kip  [q]uit > ')
        const next = await answers.next()
        answer = next.done ? 'q' : String(next.value).trim().toLowerCase()
        if (['a', 'r', 's', 'q'].includes(answer)) break
        io.stdout('answer a, r, s or q\n')
      }
      if (answer === 'q') break
      if (answer === 'a') {
        let out: ReturnType<typeof approve>
        try {
          out = approve(file, pending, [p.key], { by: approver(io), at: today(io) })
        } catch (e) {
          throw new UsageError((e as Error).message)
        }
        file = out.file
        pending = out.pending
        await saveRules(io.cwd, file)
        await savePending(io.cwd, pending)
        await writeTests(io.cwd, file, [out.approved[0]!.id])
        io.stdout(`Approved ${p.key} as ${out.approved[0]!.id}\n`)
      } else if (answer === 'r') {
        try {
          pending = reject(pending, [p.key])
        } catch (e) {
          throw new UsageError((e as Error).message)
        }
        await savePending(io.cwd, pending)
        io.stdout(`Rejected ${p.key}\n`)
      }
    }
  } finally {
    rl.close()
  }
  return 0
}
