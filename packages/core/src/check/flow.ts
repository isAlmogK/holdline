import type { FlowRule, ProposedRule } from '../rules.js'
import { describeTarget } from '../results.js'
import type { CheckContext, CheckOutcome } from './types.js'

type Flow = Extract<FlowRule | ProposedRule, { type: 'flow' }>

export function checkFlow(rule: Flow, { index }: CheckContext): CheckOutcome {
  const name = describeTarget(rule)
  const ops = index.dataOps(rule.target, rule.ops)
  if (ops.length === 0 && !index.targetExists(rule.target)) return { stale: `nothing matches ${name}` }
  const via = rule.via.join(' or ')
  return {
    violations: ops.filter(op => !index.coveredBy(op.in, rule.via)).map(op => ({
      message: `${op.op} of ${name} in ${op.in} does not go through ${via}`,
      at: { symbol: op.in, file: op.evidence?.file, line: op.evidence?.line },
      fix: `Call ${via} instead of writing to ${name} directly.`,
    })),
  }
}
