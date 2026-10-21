import { TRUE } from '../expr.js'
import { formatExpr } from '../format.js'
import { implies } from '../logic.js'
import type { ProposedRule, VisibilityRule } from '../rules.js'
import { describeTarget } from '../results.js'
import type { CheckContext, CheckOutcome, Violation } from './types.js'

type Visibility = Extract<VisibilityRule | ProposedRule, { type: 'visibility' }>

export function checkVisibility(rule: Visibility, { index, vocab }: CheckContext): CheckOutcome {
  const name = describeTarget(rule)
  const reads = index.dataOps(rule.target, ['read', 'list'])
  if (reads.length === 0 && !index.targetExists(rule.target)) return { stale: `nothing matches ${name}` }
  const violations = reads
    .filter(op => !index.coveredBy(op.in, rule.via))
    .flatMap((op): Violation[] => {
      const result = implies(op.filters ?? TRUE, rule.requires, vocab)
      if (result.ok) return []
      const missing = formatExpr(result.unproven)
      const through = rule.via.length > 0 ? `, or route it through ${rule.via.join(' or ')}` : ''
      return [{
        message: `${op.op} of ${name} in ${op.in} does not filter by ${missing}`,
        at: { symbol: op.in, file: op.evidence?.file, line: op.evidence?.line },
        unproven: result.unproven,
        fix: `Add a filter for ${missing} to this query${through}.`,
      }]
    })
  return { violations }
}
