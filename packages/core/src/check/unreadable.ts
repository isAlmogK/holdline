import type { ProposedRule, Rule } from '../rules.js'
import type { CheckContext } from './types.js'

// A reason the rule cannot be judged, or undefined when everything it depends on was read.
// Only an access rule on one symbol is judged file by file. Every other rule quantifies over a set
// (matching routes, policies, data ops, tables) that a parse failure anywhere can shrink, so any
// error diagnostic makes it unknown. Conservative for Phase 0; refine per store later.
export function unreadableReason(rule: Rule | ProposedRule, ctx: CheckContext): string | undefined {
  const errors = ctx.index.facts.diagnostics.filter(d => d.severity === 'error')
  if (errors.length === 0) return undefined
  const t = rule.target
  if (!('symbol' in t)) {
    const first = errors[0]!
    const more = errors.length > 1 ? ` (+${errors.length - 1} more)` : ''
    return `analyzer errors make this result unreliable: ${first.file || first.analyzer}: ${first.message}${more}`
  }
  const crashed = errors.find(d => d.file === '')
  if (crashed) return `The ${crashed.analyzer} analyzer failed (${crashed.message}), so facts are missing and this rule cannot be checked.`
  const evidence = 'evidence' in rule ? rule.evidence : []
  const unresolved = evidence.find(id => !ctx.index.hasId(id))
  if (unresolved) return `Evidence ${unresolved} was not found and an analyzer reported errors, so this rule cannot be checked.`
  const deps = new Set<string>()
  for (const id of [t.symbol, ...evidence]) {
    const file = ctx.index.fileOf(id)
    if (file) deps.add(file)
  }
  const bad = errors.find(d => deps.has(d.file))
  return bad ? `${bad.file} could not be read (${bad.message}), so this rule cannot be checked.` : undefined
}
