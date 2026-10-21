import { formatExpr, type Result, type Summary } from '@holdline/core'
import { where } from './where.js'

export function formatAgent(results: Result[], summary: Summary, texts: Map<string, string>): string {
  const failing = results.filter(r => r.status === 'violation' || r.status === 'unapproved-edit')
  if (failing.length === 0) {
    const n = summary.pass
    const extra = summary.stale + summary.unknown > 0 ? ` (${summary.stale} stale, ${summary.unknown} unknown; run holdline check for details)` : ''
    return `Holdline: all ${n} approved ${n === 1 ? 'rule passes' : 'rules pass'}.${extra}\n`
  }
  const rules = new Set(failing.map(r => r.rule)).size
  const lines = [
    `Holdline: ${rules} approved ${rules === 1 ? 'rule is' : 'rules are'} broken. Fix the code so the rules hold again. Do not edit holdline.rules.`,
  ]
  for (const r of failing) {
    if (r.status === 'unapproved-edit') {
      lines.push(`- ${r.rule} "${texts.get(r.rule) ?? ''}": this rule was changed in holdline.rules without approval. Undo your change to it; only the user approves rule changes (they can run holdline approve ${r.rule}).`)
      continue
    }
    const loc = where(r) ? ` at ${where(r)}` : ''
    const missing = r.unproven ? ` Missing: ${formatExpr(r.unproven)}.` : ''
    const fix = r.fix ? ` Fix: ${r.fix}` : ''
    lines.push(`- ${r.rule} "${texts.get(r.rule) ?? ''}"${loc}: ${r.message.replace(/\.$/, '')}.${missing}${fix}`)
  }
  lines.push('If this behavior change is intended, stop and ask the user to approve a rule change (holdline propose, then holdline approve).')
  return `${lines.join('\n')}\n`
}
