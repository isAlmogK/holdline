import type { Expr, Operand } from '@holdline/core'
import { toExpr, type NormalizeEnv } from './normalize.js'
import { operand } from './operand.js'
import { functionScope } from './scope.js'
import { bareSelectTarget, nameList, type SqlNode } from './sql-ast.js'

const MAX_DEPTH = 10

// A call to a SQL helper (LANGUAGE sql, STABLE or IMMUTABLE, body `SELECT <expr>`) is replaced by its body.
export function inlineCall(call: SqlNode, env: NormalizeEnv): Expr | undefined {
  const names = nameList(call.funcname)
  const key = names.length === 1 ? `public.${names[0]}` : names.length === 2 ? names.join('.') : undefined
  const args = (call.args as SqlNode[] | undefined) ?? []
  const fn = key === undefined ? undefined : env.catalog.functions.get(`${key}/${args.length}`)
  if (!fn || fn.language !== 'sql' || (fn.volatility !== 's' && fn.volatility !== 'i') || env.depth >= MAX_DEPTH) return undefined
  if (call.agg_star || call.agg_distinct || call.over || call.func_variadic || call.agg_filter || call.agg_order) return undefined
  const operands = args.map(a => operand(a, env))
  if (operands.some(o => o === undefined)) return undefined
  let stmts
  try { stmts = env.parse(fn.body).stmts } catch { return undefined }
  const body = stmts.length === 1 ? bareSelectTarget(stmts[0]!.stmt) : undefined
  if (!body) return undefined
  env.functions.add(key!)
  return toExpr(body, { ...env, source: fn.body, scope: functionScope(fn.argNames, operands as Operand[]), depth: env.depth + 1 })
}
