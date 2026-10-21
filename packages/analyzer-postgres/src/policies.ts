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
const ANONYMOUS: Expr = { not: SIGNED_IN }
const TRUE_ = (): Normalized => ({ expr: { and: [] }, functions: [] })

// Which modeled callers a policy's roles cover. Plain: any role other than public may be the caller's ('some').
type Cover = 'both' | 'signed-in' | 'anonymous' | 'some' | 'none'

function coverOf(roles: readonly string[], dialect: Dialect): Cover {
  if (roles.includes('public')) return 'both'
  if (dialect === 'plain') return 'some'
  const [signed, anon] = [roles.includes('authenticated'), roles.includes('anon')]
  return signed && anon ? 'both' : signed ? 'signed-in' : anon ? 'anonymous' : 'none'
}

// A permissive condition holds for the callers its roles cover; a signed-in caller has the authenticated role.
function wrapPermissive(c: Expr, cover: Cover): Expr {
  return cover === 'signed-in' ? { and: [SIGNED_IN, c] } : cover === 'anonymous' ? { and: [ANONYMOUS, c] } : c
}
// A restrictive condition binds only the callers its roles cover; dropping one only weakens.
function wrapRestrictive(c: Expr, cover: Cover): Expr | undefined {
  if (cover === 'both') return c
  return cover === 'signed-in' ? { or: [ANONYMOUS, c] } : cover === 'anonymous' ? { or: [SIGNED_IN, c] } : undefined
}

// USING applies to the existing row, WITH CHECK (defaulting to USING) to the incoming one.
function clauses(row: PolicyRow, condition: ConditionOf) {
  const table = `${row.schema}.${row.table}`
  return {
    using: (): Normalized => (row.using === null ? TRUE_() : condition(row.using, table, 'resource')),
    check: (): Normalized => {
      const sql = row.check ?? row.using
      return sql === null ? TRUE_() : condition(sql, table, 'incoming')
    },
  }
}

function opCondition(row: PolicyRow, op: Op, condition: ConditionOf): Normalized {
  const { using, check } = clauses(row, condition)
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
  const coverage = new Map<PolicyRow, Cover>()
  for (const row of rows) {
    const cover = coverOf(row.roles, dialect)
    coverage.set(row, cover)
    if (cover === 'none') {
      diagnostics.push({
        analyzer: 'postgres', file: location(row)?.file ?? '', severity: 'warning',
        message: `policy "${row.name}" on ${row.schema}.${row.table} applies only to roles ${row.roles.join(', ')}; Holdline models the anon and authenticated roles, so it was skipped`,
      })
    }
  }
  const tableOf = (row: PolicyRow) => `${row.schema}.${row.table}`
  const permissive = rows.filter(r => r.permissive && coverage.get(r) !== 'none')

  const restrictions = new Map<string, Normalized[]>()
  for (const row of rows.filter(r => !r.permissive)) {
    for (const op of OPS[row.cmd]) {
      const c = opCondition(row, op, condition)
      const expr = wrapRestrictive(c.expr, coverage.get(row)!)
      if (expr === undefined) continue
      const key = `${tableOf(row)}#${op}`
      restrictions.set(key, [...(restrictions.get(key) ?? []), { ...c, expr }])
    }
  }

  // Postgres ORs the WITH CHECK clauses of all permissive UPDATE policies apart from their USING clauses.
  const updateChecks = new Map<string, Normalized[]>()
  for (const row of permissive.filter(r => OPS[r.cmd].includes('update'))) {
    const c = clauses(row, condition).check()
    updateChecks.set(tableOf(row), [...(updateChecks.get(tableOf(row)) ?? []), { ...c, expr: wrapPermissive(c.expr, coverage.get(row)!) }])
  }

  const policies: Policy[] = []
  for (const row of permissive) {
    const table = tableOf(row)
    const cover = coverage.get(row)!
    for (const op of OPS[row.cmd]) {
      let own: Normalized
      if (op === 'update') {
        const u = clauses(row, condition).using()
        const checks = updateChecks.get(table)!
        const check: Expr = checks.length === 1 ? checks[0]!.expr : { or: checks.map(x => x.expr) }
        own = { expr: { and: [wrapPermissive(u.expr, cover), check] }, functions: [...u.functions, ...checks.flatMap(x => x.functions)] }
      } else {
        const c = opCondition(row, op, condition)
        own = { ...c, expr: wrapPermissive(c.expr, cover) }
      }
      const extra = restrictions.get(`${table}#${op}`) ?? []
      const evidence = location(row)
      policies.push({
        id: `pg:${table}#policy:${row.name}`,
        store: 'pg-rls',
        target: table,
        ops: [op],
        condition: requireSignIn(extra.length > 0 ? { and: [own.expr, ...extra.map(x => x.expr)] } : own.expr),
        functions: [...new Set([...own.functions, ...extra.flatMap(x => x.functions)])].sort(),
        ...(evidence ? { evidence } : {}),
      })
    }
  }
  return { policies, diagnostics }
}
