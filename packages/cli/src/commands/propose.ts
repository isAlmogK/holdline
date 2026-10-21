import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { addToPending, validateProposals } from '@holdline/core'
import { UsageError, type Io } from '../io.js'
import { loadFacts, loadPending, loadRules, savePending } from '../workspace.js'

async function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  let text = ''
  for await (const chunk of stream) text += String(chunk)
  return text
}

export async function proposeCommand(source: string, opts: { facts?: string; limit?: string }, io: Io): Promise<number> {
  let text: string
  if (source === '-') {
    if (!io.stdin) throw new UsageError('no stdin to read proposals from')
    text = await readStream(io.stdin)
  } else {
    text = await readFile(isAbsolute(source) ? source : join(io.cwd, source), 'utf8')
  }
  let json: unknown
  try {
    json = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''))
  } catch (e) {
    throw new UsageError(`proposals are not valid JSON: ${(e as Error).message}`)
  }
  const file = await loadRules(io.cwd)
  const facts = await loadFacts(io.cwd, opts.facts)
  const report = validateProposals(json, facts, file, { limit: opts.limit ? Number(opts.limit) : undefined })
  const { pending, added, conflicts } = addToPending(await loadPending(io.cwd), report)
  await savePending(io.cwd, pending)

  const lines: string[] = []
  for (const p of added) {
    lines.push(`${p.key} ${p.classification === 'broken' ? 'broken' : 'holds '}  ${p.rule.text}`)
    for (const v of p.violations) lines.push(`      ${v}`)
  }
  for (const r of report.rules.filter(o => o.classification === 'rejected')) {
    lines.push(`rejected  ${r.rule?.text ?? 'invalid proposal'}: ${r.reason}`)
  }
  for (const c of conflicts) lines.push(`skipped  ${c.text}: ${c.reason}`)
  for (const v of report.vocabulary.filter(x => !x.accepted)) lines.push(`rejected vocabulary: ${v.reason}`)
  if (report.dropped > 0) lines.push(`${report.dropped} lower-ranked proposals dropped (limit ${opts.limit ?? 25})`)
  lines.push(`Review with \`holdline review\`, or \`holdline approve <keys>\` / \`holdline approve --all\`.`)
  io.stdout(`${lines.join('\n')}\n`)
  return 0
}
