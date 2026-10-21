import type { Atom, Expr, Operand } from '@holdline/core'
import type { CatalogIndex } from './catalog.js'
import { operand } from './operand.js'
import type { SqlParse } from './pgparse.js'
import { tableScope, type Scope, type Side } from './scope.js'
import { bareSelectTarget, constant, kindOf, nameList, nodeText, type SqlNode } from './sql-ast.js'

export interface NormalizeEnv {
  source: string // the text the nodes were parsed from, for opaque conditions
  scope: Scope
  catalog: CatalogIndex
  parse: SqlParse
  supabase: boolean // auth.uid(), auth.jwt() and auth.role() are Supabase's
  depth: number // helper function inlining depth
  functions: Set<string> // helper functions inlined so far, 'schema.name'
}

export interface Normalized { expr: Expr; functions: string[] }

const COMPARISON: Record<string, 'eq' | 'ne' | 'lt' | 'gt'> = { '=': 'eq', '<>': 'ne', '<': 'lt', '>': 'gt' }
const SIGNED_IN: Expr = { atom: { op: 'authenticated' } }

// A policy expression as pg_get_expr prints it, for the policy's table and side.
export function normalizeCondition(
  sql: string,
  ctx: { table: string; side: Side; catalog: CatalogIndex; parse: SqlParse; supabase: boolean },
): Normalized {
  const source = `SELECT ${sql}`
  let node: SqlNode | undefined
  try { node = bareSelectTarget(ctx.parse(source).stmts[0]?.stmt) } catch { node = undefined }
  if (!node) return { expr: { opaque: sql }, functions: [] }
  const functions = new Set<string>()
  const scope = tableScope(ctx.table, ctx.catalog.relations.get(ctx.table) ?? new Set(), ctx.side)
  const expr = toExpr(node, { source, scope, catalog: ctx.catalog, parse: ctx.parse, supabase: ctx.supabase, depth: 0, functions })
  return { expr, functions: [...functions].sort() }
}

export function toExpr(node: SqlNode, env: NormalizeEnv): Expr {
  const opaque = (): Expr => ({ opaque: nodeText(env.source, node) })
  const k = kindOf(node)
  if (!k) return opaque()
  const [kind, f] = k
  switch (kind) {
    case 'BoolExpr': {
      const args = (f.args as SqlNode[]).map(a => toExpr(a, env))
      return f.boolop === 'AND_EXPR' ? { and: args } : f.boolop === 'OR_EXPR' ? { or: args } : { not: args[0]! }
    }
    case 'A_Const': {
      const c = constant(node)?.value
      return c === true ? { and: [] } : c === false ? { or: [] } : opaque()
    }
    case 'A_Expr': return comparison(f, env) ?? opaque()
    case 'NullTest': return nullTest(f, env) ?? opaque()
    case 'SubLink': {
      if (f.subLinkType === 'EXPR_SUBLINK') {
        const inner = bareSelectTarget(f.subselect)
        return inner ? toExpr(inner, env) : opaque()
      }
      return opaque() // Task 6: EXISTS and IN subqueries
    }
    case 'FuncCall': return opaque() // Task 6: helper function inlining
    default: return opaque()
  }
}

function comparison(f: SqlNode, env: NormalizeEnv): Expr | undefined {
  const name = nameList(f.name)
  if (name.length !== 1) return undefined
  const op = name[0]!
  if (f.kind === 'AEXPR_OP' && op in COMPARISON) {
    const left = operand(f.lexpr, env)
    const right = operand(f.rexpr, env)
    return left === undefined || right === undefined ? undefined : atomExpr({ op: COMPARISON[op]!, left, right })
  }
  const items: SqlNode[] | undefined = op !== '=' ? undefined
    : f.kind === 'AEXPR_OP_ANY' ? arrayItems(f.rexpr)
    : f.kind === 'AEXPR_IN' ? (f.rexpr?.List?.items as SqlNode[] | undefined) : undefined
  if (!items) return undefined
  const left = operand(f.lexpr, env)
  const values = items.map(i => constant(i)?.value)
  if (left === undefined || values.some(v => typeof v !== 'string' && typeof v !== 'number')) return undefined
  return atomExpr({ op: 'in', left, right: { literal: values as (string | number)[] } })
}

function arrayItems(node: SqlNode | undefined): SqlNode[] | undefined {
  const k = kindOf(node)
  if (k?.[0] === 'TypeCast') return arrayItems(k[1].arg)
  return k?.[0] === 'A_ArrayExpr' ? ((k[1].elements as SqlNode[] | undefined) ?? []) : undefined
}

// The facts' actor model has no anonymous role: an anonymous caller is "no actor".
function atomExpr(a: Extract<Atom, { left: Operand }>): Expr | undefined {
  const sides = [a.left, a.right]
  const role = sides.some(o => o === 'actor.role' || o === 'actor.claim.role')
  const anon = sides.some(o => typeof o === 'object' && o !== null && 'literal' in o
    && (o.literal === 'anon' || (Array.isArray(o.literal) && o.literal.includes('anon'))))
  if (role && anon) return a.op === 'eq' ? { not: SIGNED_IN } : undefined
  return { atom: a }
}

function nullTest(f: SqlNode, env: NormalizeEnv): Expr | undefined {
  const o = operand(f.arg, env)
  if (typeof o !== 'string') return undefined
  const isNull = f.nulltesttype === 'IS_NULL'
  if (o === 'actor.uid') return isNull ? { not: SIGNED_IN } : SIGNED_IN
  if (o.startsWith('actor.')) return undefined
  const atom: Expr = { atom: { op: 'isNull', operand: o } }
  return isNull ? atom : { not: atom }
}
