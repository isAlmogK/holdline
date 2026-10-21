import type { Expr } from '../expr.js'
import { formatExpr } from '../format.js'
import { implies, renameParams } from '../logic.js'
import { alignParams } from '../paths.js'
import type { DataAccessRule, ProposedRule } from '../rules.js'
import { describeTarget } from '../results.js'
import type { CheckContext, CheckOutcome, Violation } from './types.js'

type DataAccess = Extract<DataAccessRule | ProposedRule, { type: 'data-access' }>

export function checkDataAccess(rule: DataAccess, { index, vocab }: CheckContext): CheckOutcome {
  const t = rule.target
  const name = describeTarget(rule)
  if (t.store === 'postgres') {
    const table = index.table(t.table)
    if (!table) return { stale: `table ${t.table} not found` }
    if (!table.rlsEnabled) {
      return { violations: [{
        message: `Row level security is not enabled on ${table.name}, so no policy limits access`,
        at: index.at(table.id),
        fix: `ALTER TABLE ${table.name} ENABLE ROW LEVEL SECURITY; then add policies that require ${formatExpr(rule.requires)}.`,
      }] }
    }
  } else if (!index.targetExists(t)) {
    return { stale: `nothing matches ${name}` }
  }
  const violations = rule.ops.flatMap((op): Violation[] => {
    const conditions = index.policies(t, op).map(p => ({
      policy: p,
      condition: t.store === 'postgres' ? p.condition : renameParams(p.condition, alignParams(p.target, t.path)),
    }))
    const result = implies({ or: conditions.map(c => c.condition) } satisfies Expr, rule.requires, vocab)
    if (result.ok) return []
    const culprit = conditions.find(c => !implies(c.condition, rule.requires, vocab).ok)
    const missing = formatExpr(result.unproven)
    return [{
      message: `${op} on ${name} is allowed without ${missing}`,
      at: culprit ? index.at(culprit.policy.id) : undefined,
      unproven: result.unproven,
      fix: `Make every policy that allows ${op} on ${name} require ${missing}.`,
    }]
  })
  return { violations }
}
