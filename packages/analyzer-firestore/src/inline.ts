import type { Node } from './ast.js'
import type { Binding, Env } from './scope.js'
import type { NormalizeContext } from './value.js'

/** Firestore's own call-depth limit for rules functions. */
export const MAX_INLINE_DEPTH = 20

/**
 * Global functions Firestore provides. A user function with one of these names is never inlined: which one
 * Firestore would call is not modelled, so the call stays opaque (see `lookupArg` for the lookups).
 */
export const BUILTIN_FUNCTIONS: ReadonlySet<string> = new Set([
  'get', 'exists', 'getAfter', 'existsAfter', 'debug', 'bool', 'bytes', 'float', 'int', 'string', 'path',
])

export type InlineResult =
  | { kind: 'inline'; node: Node; env: Env; name: string }
  | { kind: 'ref'; id: string; name: string }
  | { kind: 'too-deep' } // past the depth limit, a recursive call, or the condition's inlining budget is spent
  | { kind: 'unknown' }

/**
 * Resolves a call to a user-defined function: the function's return node and the env to read it in, with
 * params bound to the call's arguments (in the caller's env) and lets bound in order. In condition position a
 * zero-parameter function an approved recognizer names is a vocabulary `ref`, but only when the file declares
 * that name once: otherwise the name may resolve to a different body than the one the vocabulary describes.
 * In value position it is inlined.
 */
export function inlineCall(
  call: Extract<Node, { type: 'call' }>, env: Env, ctx: NormalizeContext, position: 'condition' | 'value',
): InlineResult {
  const { callee, args } = call
  if (callee.type !== 'ident' || BUILTIN_FUNCTIONS.has(callee.name)) return { kind: 'unknown' }
  const name = callee.name
  const def = env.scope.findFunction(name)
  if (!def || def.decl.params.length !== args.length) return { kind: 'unknown' }
  const id = ctx.recognizers.get(name)
  if (position === 'condition' && args.length === 0 && id !== undefined && ctx.functionCounts.get(name) === 1) {
    ctx.functionsUsed.add(name)
    return { kind: 'ref', id, name }
  }
  if (env.depth + 1 > MAX_INLINE_DEPTH || env.active.has(def) || env.budget.inlines <= 0) return { kind: 'too-deep' }
  env.budget.inlines--
  ctx.functionsUsed.add(name)
  // Bindings shadow wildcards and globals; each binding is read in the env it was written in.
  const bindings = new Map<string, Binding>(def.decl.params.map((param, i) => [param, { node: args[i]!, env }]))
  let inner: Env = { scope: def.scope, bindings, depth: env.depth + 1, active: new Set(env.active).add(def), budget: env.budget }
  for (const decl of def.decl.lets) {
    inner = { ...inner, bindings: new Map(inner.bindings).set(decl.name, { node: decl.value, env: inner }) }
  }
  return { kind: 'inline', node: def.decl.returns, env: inner, name }
}
