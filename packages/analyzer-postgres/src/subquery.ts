import type { Expr } from '@holdline/core'
import { isAnonKeyOperand } from './atoms.js'
import type { NormalizeEnv } from './normalize.js'
import { operand } from './operand.js'
import { PLAIN_NAME, subqueryScope, type Scope } from './scope.js'
import { constant, kindOf, nameList, type SqlNode } from './sql-ast.js'

// An outer operand an exists doc can hold. Not a claim: SQL compares its text (`->>`) with the column, while its
// JSON value may be a number or a boolean. Not the role or an anon-key claim: an exists doc with {actor.…} is false
// for anonymous callers, but those are set for them (role 'anon', the key's claims).
const placeholder = (o: unknown): o is string =>
  typeof o === 'string' && (o === 'actor.uid' || !o.startsWith('actor.')) && !isAnonKeyOperand(o)

interface Query { table: string; scope: Scope; select: SqlNode; conditions: [string, string][] }

// EXISTS (SELECT … FROM t WHERE t.a = <x> AND t.b = <y>) → exists(pg:<schema>.t?a={x}&b={y}).
// Only in positive position: under RLS on t the subquery may see fewer rows, which makes `exists` too weak
// to negate.
export function existsSubquery(select: SqlNode, env: NormalizeEnv): Expr | undefined {
  const q = env.positive ? singleTableQuery(select, env) : undefined
  return q && plainTargets(q.select) ? existsAtom(q.table, q.conditions) : undefined
}

// <x> IN (SELECT t.a FROM t WHERE …) → the same exists with a={x}.
export function inSubquery(sublink: SqlNode, env: NormalizeEnv): Expr | undefined {
  const op = nameList(sublink.operName)
  if (op.length > 1 || (op.length === 1 && op[0] !== '=')) return undefined
  if (!env.positive) return undefined
  const left = operand(sublink.testexpr, env)
  const q = singleTableQuery(sublink.subselect, env)
  if (!placeholder(left) || !q) return undefined
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
  if (!rv || rv.inh !== true || rv.alias?.colnames) return undefined // ONLY, or `t m(a, b)` renaming columns
  const table = resolveRelation(rv, env)
  const columns = table === undefined ? undefined : env.catalog.relations.get(table)
  if (!table || !columns) return undefined
  const scope = subqueryScope(table, rv.alias?.aliasname ?? rv.relname, columns, env.scope)
  const conditions: [string, string][] = []
  for (const c of conjuncts(s.whereClause)) {
    const pair = equality(c, { ...env, scope })
    if (!pair) return undefined
    conditions.push(pair)
  }
  return { table, scope, select: s, conditions }
}

function resolveRelation(rv: SqlNode, env: NormalizeEnv): string | undefined {
  if (rv.schemaname) return `${rv.schemaname}.${rv.relname}`
  return env.searchPath.map(schema => `${schema}.${rv.relname}`).find(t => env.catalog.relations.has(t))
}

// `SELECT count(*)` returns a row even with no match, so only constants, `*` and plain columns are safe targets.
function plainTargets(s: SqlNode): boolean {
  return ((s.targetList as SqlNode[] | undefined) ?? []).every(t => {
    const v = t.ResTarget?.val as SqlNode | undefined
    const k = kindOf(v)
    return k?.[0] === 'ColumnRef' || (k?.[0] === 'A_Const' && constant(v) !== undefined)
  })
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
    return placeholder(o) ? [col, o] : undefined
  }
  return undefined
}

function innerColumn(node: SqlNode | undefined, scope: Scope): string | undefined {
  const k = kindOf(node)
  if (k?.[0] !== 'ColumnRef') return undefined
  const r = scope.column(nameList(k[1].fields))
  return r && 'inner' in r ? r.inner : undefined
}

// Columns sorted by name: two exists atoms match only when their docs are string-equal. Schema, table and column
// names are plain (`&`, `=`, `?`, `{`, `}` would make the doc ambiguous).
function existsAtom(table: string, conditions: [string, string][]): Expr | undefined {
  if (conditions.length === 0 || [...table.split('.'), ...conditions.map(([c]) => c)].some(n => !PLAIN_NAME.test(n))) return undefined
  const byColumn = new Map<string, string>()
  for (const [col, o] of conditions) {
    if (byColumn.has(col) && byColumn.get(col) !== o) return undefined
    byColumn.set(col, o)
  }
  const query = [...byColumn].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([c, o]) => `${c}={${o}}`).join('&')
  return { atom: { op: 'exists', doc: `pg:${table}?${query}` } }
}
