import { formatExpr, type Result, type Summary } from '@holdline/core'
import { where } from './human.js'

export function formatAgent(results: Result[], summary: Summary, texts: Map<string, string>): string {
  const failing = results.filter(r => r.status === 'violation' || r.status === 'unapproved-edit')
  if (failing.length === 0) return `Holdline: all ${summary.pass} approved rules pass.\n`
  const rules = new Set(failing.map(r => r.rule)).size
  const lines = [
    `Holdline: ${rules} approved ${rules === 1 ? 'rule is' : 'rules are'} broken. Fix the code so the rules hold again. Do not edit holdline.rules.`,
  ]
  for (const r of failing) {
    const loc = where(r) ? ` at ${where(r)}` : ''
    const missing = r.unproven ? ` Missing: ${formatExpr(r.unproven)}.` : ''
    const fix = r.fix ? ` Fix: ${r.fix}` : ''
    lines.push(`- ${r.rule} "${texts.get(r.rule) ?? ''}"${loc}: ${r.message}.${missing}${fix}`)
  }
  lines.push('If this behavior change is intended, stop and ask the user to approve a rule change (holdline propose, then holdline approve).')
  return `${lines.join('\n')}\n`
}
