import type { Expr } from '@holdline/core'
import type { NormalizeEnv } from './normalize.js'
import { operand } from './operand.js'
import { subqueryScope, type Scope } from './scope.js'
import { kindOf, nameList, type SqlNode } from './sql-ast.js'

interface Query { table: string; scope: Scope; select: SqlNode; conditions: [string, string][] }

// EXISTS (SELECT … FROM t WHERE t.a = <x> AND t.b = <y>) → exists(pg:<schema>.t?a={x}&b={y}).
export function existsSubquery(select: SqlNode, env: NormalizeEnv): Expr | undefined {
  const q = singleTableQuery(select, env)
  return q && existsAtom(q.table, q.conditions)
}

// <x> IN (SELECT t.a FROM t WHERE …) → the same exists with a={x}.
export function inSubquery(sublink: SqlNode, env: NormalizeEnv): Expr | undefined {
  const op = nameList(sublink.operName)
  if (op.length > 1 || (op.length === 1 && op[0] !== '=')) return undefined
  const left = operand(sublink.testexpr, env)
  const q = singleTableQuery(sublink.subselect, env)
  if (typeof left !== 'string' || !q) return undefined
  const targets = (q.select.targetList as SqlNode[] | undefined) ?? []
  const col = targets.length === 1 ? innerColumn(targets[0]!.ResTarget?.val, q.scope) : undefined
  return col === undefined ? undefined : existsAtom(q.table, [...q.conditions, [col, left]])
}

function singleTableQuery(select: SqlNode | undefined, env: NormalizeEnv): Query | undefined {
  const s = select?.SelectStmt as SqlNode | undefined
  if (!s || s.groupClause || s.havingClause || s.withClause || s.distinctClause || s.limitCount || s.limitOffset
    || s.valuesLists || s.sortClause || s.lockingClause || s.windowClause || (s.op && s.op !== 'SETOP_NONE')) return undefined
  const from = s.fromClause as SqlNode[] | undefined
  const rv = from?.length === 1 ? (from[0]!.RangeVar as SqlNode | undefined) : undefined
  if (!rv || rv.inh === false) return undefined
  const table = `${rv.schemaname ?? 'public'}.${rv.relname}`
  const columns = env.catalog.relations.get(table)
  if (!columns) return undefined
  const scope = subqueryScope(table, rv.alias?.aliasname ?? rv.relname, columns, env.scope)
  const conditions: [string, string][] = []
  for (const c of conjuncts(s.whereClause)) {
    const pair = equality(c, { ...env, scope })
    if (!pair) return undefined
    conditions.push(pair)
  }
  return { table, scope, select: s, conditions }
}

function conjuncts(where: SqlNode | undefined): SqlNode[] {
  if (!where) return []
  const k = kindOf(where)
  return k?.[0] === 'BoolExpr' && k[1].boolop === 'AND_EXPR' ? (k[1].args as SqlNode[]).flatMap(conjuncts) : [where]
}

// `inner_column = outer_operand`, in either order. The operand must be a string (a literal is not a placeholder).
function equality(node: SqlNode, env: NormalizeEnv): [string, string] | undefined {
  const k = kindOf(node)
  if (k?.[0] !== 'A_Expr' || k[1].kind !== 'AEXPR_OP' || nameList(k[1].name).join() !== '=') return undefined
  const { lexpr, rexpr } = k[1]
  for (const [a, b] of [[lexpr, rexpr], [rexpr, lexpr]] as const) {
    const col = innerColumn(a, env.scope)
    if (col === undefined) continue
    if (innerColumn(b, env.scope) !== undefined) return undefined
    const o = operand(b, env)
    return typeof o === 'string' ? [col, o] : undefined
  }
  return undefined
}

function innerColumn(node: SqlNode | undefined, scope: Scope): string | undefined {
  const k = kindOf(node)
  if (k?.[0] !== 'ColumnRef') return undefined
  const r = scope.column(nameList(k[1].fields))
  return r && 'inner' in r ? r.inner : undefined
}

// Columns sorted by name: two exists atoms match only when their docs are string-equal.
function existsAtom(table: string, conditions: [string, string][]): Expr | undefined {
  if (conditions.length === 0) return undefined
  const byColumn = new Map<string, string>()
  for (const [col, o] of conditions) {
    if (byColumn.has(col) && byColumn.get(col) !== o) return undefined
    byColumn.set(col, o)
  }
  const query = [...byColumn].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([c, o]) => `${c}={${o}}`).join('&')
  return { atom: { op: 'exists', doc: `pg:${table}?${query}` } }
}
