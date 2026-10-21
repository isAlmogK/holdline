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
  const answers = createInterface({ input: io.stdin, terminal: false })[Symbol.asyncIterator]()
  const approvedIds: string[] = []
  for (const p of [...pending.rules]) {
    io.stdout(`\n${p.key} ${p.classification === 'broken' ? '? looks broken today' : '✓ holds today'}\n  ${p.rule.text}\n`)
    for (const v of p.violations) io.stdout(`  ${v}\n`)
    if (p.rule.evidence.length > 0) io.stdout(`  evidence: ${p.rule.evidence.join(', ')}\n`)
    io.stdout('[a]pprove  [r]eject  [s]kip  [q]uit > ')
    const next = await answers.next()
    const answer = next.done ? 'q' : String(next.value).trim().toLowerCase()
    if (answer === 'q') break
    if (answer === 'a') {
      const out = approve(file, pending, [p.key], { by: approver(io), at: today(io) })
      file = out.file
      pending = out.pending
      approvedIds.push(out.approved[0]!.id)
      io.stdout(`Approved ${p.key} as ${out.approved[0]!.id}\n`)
    } else if (answer === 'r') {
      pending = reject(pending, [p.key])
      io.stdout(`Rejected ${p.key}\n`)
    }
  }
  await saveRules(io.cwd, file)
  await savePending(io.cwd, pending)
  await writeTests(io.cwd, file, approvedIds)
  return 0
}
