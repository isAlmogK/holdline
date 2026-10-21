import { formatExpr } from '../format.js'
import { implies } from '../logic.js'
import type { AccessRule, ProposedRule } from '../rules.js'
import type { CheckContext, CheckOutcome, Violation } from './types.js'

type Access = Extract<AccessRule | ProposedRule, { type: 'access' }>

export function checkAccess(rule: Access, { index, vocab }: CheckContext): CheckOutcome {
  if ('symbol' in rule.target) {
    const id = rule.target.symbol
    if (!index.hasId(id)) return { stale: `symbol ${id} not found` }
    const result = implies({ and: index.guardsAt(id).map(g => g.requires) }, rule.requires, vocab)
    if (result.ok) return { violations: [] }
    const missing = formatExpr(result.unproven)
    return { violations: [{ message: `${id} does not check ${missing}`, at: index.at(id), unproven: result.unproven, fix: `Check ${missing} before ${id} does any work.` }] }
  }
  const routes = index.routesMatching(rule.target.routes)
  if (routes.length === 0) return { stale: `no routes match ${rule.target.routes}` }
  const violations = routes.flatMap((route): Violation[] => {
    const result = implies({ and: index.guardChain(route).map(g => g.requires) }, rule.requires, vocab)
    if (result.ok) return []
    const missing = formatExpr(result.unproven)
    const name = `${route.method} ${route.path}`
    return [{
      message: `${name} does not check ${missing}`,
      at: index.at(route.handler),
      unproven: result.unproven,
      fix: `Add a check for ${missing} to ${name}, as middleware or before its first data access.`,
    }]
  })
  return { violations }
}
