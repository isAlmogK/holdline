import type { Diagnostic, Expr, Location, Op, Policy } from '@holdline/core'
import { requireSignIn } from './anon.js'
import type { PolicyRow } from './catalog.js'
import type { Dialect } from './detect.js'
import type { Normalized } from './normalize.js'
import type { Side } from './scope.js'

export type ConditionOf = (sql: string, table: string, side: Side) => Normalized

const OPS: Record<PolicyRow['cmd'], Op[]> = {
  r: ['read', 'list'], a: ['create'], w: ['update'], d: ['delete'], '*': ['read', 'list', 'create', 'update', 'delete'],
}
const SIGNED_IN: Expr = { atom: { op: 'authenticated' } }
const TRUE_ = (): Normalized => ({ expr: { and: [] }, functions: [] })

type Applies = 'everyone' | 'anonymous' | 'skipped' | 'some-role'

function appliesTo(roles: readonly string[], dialect: Dialect): Applies {
  if (roles.includes('public')) return 'everyone'
  if (dialect === 'plain') return 'some-role'
  if (roles.includes('authenticated')) return 'everyone'
  return roles.includes('anon') ? 'anonymous' : 'skipped'
}

// SELECT and DELETE use USING, INSERT uses WITH CHECK, UPDATE both; WITH CHECK defaults to USING.
function opCondition(row: PolicyRow, op: Op, condition: ConditionOf): Normalized {
  const table = `${row.schema}.${row.table}`
  const using = () => (row.using === null ? TRUE_() : condition(row.using, table, 'resource'))
  const check = () => {
    const sql = row.check ?? row.using
    return sql === null ? TRUE_() : condition(sql, table, 'incoming')
  }
  if (op === 'create') return check()
  if (op !== 'update') return using()
  const [u, c] = [using(), check()]
  return { expr: { and: [u.expr, c.expr] }, functions: [...u.functions, ...c.functions] }
}

export function buildPolicies(
  rows: readonly PolicyRow[],
  dialect: Dialect,
  condition: ConditionOf,
  location: (row: PolicyRow) => Location | undefined,
): { policies: Policy[]; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = []
  const applies = (row: PolicyRow): Applies => {
    const a = appliesTo(row.roles, dialect)
    if (a === 'skipped') {
      diagnostics.push({
        analyzer: 'postgres', file: location(row)?.file ?? '', severity: 'warning',
        message: `policy "${row.name}" on ${row.schema}.${row.table} applies only to roles ${row.roles.join(', ')}; Holdline models the anon and authenticated roles, so it was skipped`,
      })
    }
    return a
  }
  const restrictions = new Map<string, Normalized[]>()
  for (const row of rows.filter(r => !r.permissive)) {
    const a = applies(row)
    if (a !== 'everyone' && a !== 'anonymous') continue
    for (const op of OPS[row.cmd]) {
      const c = opCondition(row, op, condition)
      const key = `${row.schema}.${row.table}#${op}`
      restrictions.set(key, [...(restrictions.get(key) ?? []), { ...c, expr: a === 'anonymous' ? { or: [SIGNED_IN, c.expr] } : c.expr }])
    }
  }
  const policies: Policy[] = []
  for (const row of rows.filter(r => r.permissive)) {
    const a = applies(row)
    if (a === 'skipped') continue
    const table = `${row.schema}.${row.table}`
    for (const op of OPS[row.cmd]) {
      const c = opCondition(row, op, condition)
      const base = a === 'anonymous' ? { and: [{ not: SIGNED_IN }, c.expr] } : c.expr
      const extra = restrictions.get(`${table}#${op}`) ?? []
      const evidence = location(row)
      policies.push({
        id: `pg:${table}#policy:${row.name}`,
        store: 'pg-rls',
        target: table,
        ops: [op],
        condition: requireSignIn(extra.length > 0 ? { and: [base, ...extra.map(x => x.expr)] } : base),
        functions: [...new Set([...c.functions, ...extra.flatMap(x => x.functions)])].sort(),
        ...(evidence ? { evidence } : {}),
      })
    }
  }
  return { policies, diagnostics }
}
