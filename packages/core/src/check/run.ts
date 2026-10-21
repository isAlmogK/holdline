import { FactIndex } from '../fact-index.js'
import type { Facts } from '../facts.js'
import { hashRule } from '../hash.js'
import { vocabularyMap, type ProposedRule, type Rule, type RulesFile } from '../rules.js'
import { describeTarget, type Result } from '../results.js'
import { checkAccess } from './access.js'
import { checkDataAccess } from './data-access.js'
import { checkFlow } from './flow.js'
import { checkInvariant } from './invariant.js'
import type { CheckContext, CheckOutcome } from './types.js'
import { unreadableReason } from './unreadable.js'
import { checkVisibility } from './visibility.js'

export function evaluateRule(rule: Rule | ProposedRule, ctx: CheckContext): CheckOutcome {
  switch (rule.type) {
    case 'access': return checkAccess(rule, ctx)
    case 'data-access': return checkDataAccess(rule, ctx)
    case 'visibility': return checkVisibility(rule, ctx)
    case 'flow': return checkFlow(rule, ctx)
    case 'invariant': return checkInvariant(rule, ctx)
  }
}

export function checkRule(rule: Rule, ctx: CheckContext): Result[] {
  const target = describeTarget(rule)
  if (!rule.approved || rule.approved.hash !== hashRule(rule, ctx.vocab)) {
    return [{ rule: rule.id, status: 'unapproved-edit', target, message: `"${rule.text}" was changed without approval. Approve it with \`holdline approve ${rule.id}\`, or restore it.` }]
  }
  const reason = unreadableReason(rule, ctx)
  if (reason) return [{ rule: rule.id, status: 'unknown', target, message: reason }]
  const outcome = evaluateRule(rule, ctx)
  if ('stale' in outcome) return [{ rule: rule.id, status: 'stale', target, message: outcome.stale }]
  if (outcome.violations.length === 0) return [{ rule: rule.id, status: 'pass', target, message: rule.text }]
  return outcome.violations.map(v => ({ rule: rule.id, status: 'violation' as const, target, ...v }))
}

export function runChecks(facts: Facts, file: RulesFile, opts: { only?: string[] } = {}): { results: Result[]; muted: number } {
  const ctx: CheckContext = { index: new FactIndex(facts), vocab: vocabularyMap(file) }
  const results: Result[] = []
  let muted = 0
  for (const rule of file.rules) {
    if (opts.only && !opts.only.includes(rule.id)) continue
    if (rule.status === 'muted') { muted++; continue }
    if (rule.status === 'pending') continue
    results.push(...checkRule(rule, ctx))
  }
  return { results, muted }
}
