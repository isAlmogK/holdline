import { formatExpr, type MutedRule, type Result, type Summary } from '@holdline/core'
import { where } from './where.js'

const MARK: Record<Result['status'], string> = { pass: '✓', violation: '✗', stale: '!', unknown: '?', 'unapproved-edit': '✗' }

export function formatHuman(results: Result[], summary: Summary, texts: Map<string, string>, mutedRules: MutedRule[] = []): string {
  const lines: string[] = []
  for (const r of results.filter(x => x.status !== 'pass')) {
    lines.push(`${MARK[r.status]} ${r.rule} ${texts.get(r.rule) ?? ''}  [${r.status}]`)
    lines.push(`    ${r.message}`)
    if (where(r)) lines.push(`    at ${where(r)}`)
    if (r.unproven) lines.push(`    missing: ${formatExpr(r.unproven)}`)
    if (r.fix) lines.push(`    fix: ${r.fix}`)
  }
  const failing = summary.rules - summary.pass
  if (failing === 0) {
    lines.push(`✓ ${summary.pass} ${summary.pass === 1 ? 'rule passes' : 'rules pass'}${summary.muted ? ` (${summary.muted} muted)` : ''}`)
  } else {
    lines.push(`${summary.rules} rules: ${summary.pass} pass, ${summary.violation} violation, ${summary.stale} stale, ${summary.unknown} unknown, ${summary['unapproved-edit']} unapproved edit, ${summary.muted} muted`)
  }
  for (const m of mutedRules) lines.push(`- ${m.id} muted by ${m.by} on ${m.at}: ${m.reason}`)
  return `${lines.join('\n')}\n`
}
