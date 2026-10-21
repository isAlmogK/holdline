import { parseLookup } from '@holdline/core'
import type { Node, PathPart } from './ast.js'
import type { Env } from './scope.js'
import { resolveValue, type NormalizeContext } from './value.js'

type Call = Extract<Node, { type: 'call' }>
type PathNode = Extract<Node, { type: 'path' }>

// A segment Holdline keeps as text: nothing the `doc(...)` path grammar reads as structure.
const SEGMENT_TEXT = /^[^(){}/\s]+$/
// An operand core accepts as a `{...}` path placeholder (stored-record and incoming one field deep).
const PLACEHOLDER = /^(?:actor\.uid|actor\.claim\.[A-Za-z0-9_.]+|resource\.[A-Za-z0-9_]+|incoming\.[A-Za-z0-9_]+|param\.[A-Za-z0-9_]+)$/

/** True when `node` is an integer literal (possibly negated or bound): a float like `1.0` may not print as `1` in a path. */
function isIntegerSyntax(node: Node, env: Env): boolean {
  if (node.type === 'int') return true
  if (node.type === 'unary') return node.op === '-' && isIntegerSyntax(node.operand, env)
  if (node.type !== 'ident') return false
  const binding = env.bindings.get(node.name)
  return binding !== undefined && isIntegerSyntax(binding.node, binding.env)
}

/** One segment after the database prefix: its text in P' form and whether it reads the caller. */
function segment(parts: PathPart[], env: Env, ctx: NormalizeContext): { text: string; auth: boolean } | undefined {
  if (parts.length !== 1) return undefined
  const part = parts[0]!
  if (part.kind === 'text') return SEGMENT_TEXT.test(part.value) ? { text: part.value, auth: false } : undefined
  const v = resolveValue(part.expr, env, ctx)
  if (v?.kind === 'operand') {
    return !v.fallback && PLACEHOLDER.test(v.operand) ? { text: `{${v.operand}}`, auth: v.auth } : undefined
  }
  if (v?.kind !== 'literal') return undefined
  const text = typeof v.value === 'string' ? v.value
    : typeof v.value === 'number' && Number.isSafeInteger(v.value) && isIntegerSyntax(part.expr, env) ? String(v.value)
    : undefined
  return text !== undefined && SEGMENT_TEXT.test(text) ? { text, auth: false } : undefined
}

/** `/databases/<db>/documents/<rest>` → P' (`/<rest>` with placeholders), or undefined when not exact. */
function translate(node: PathNode, env: Env, ctx: NormalizeContext): { path: string; auth: boolean } | undefined {
  const [databases, , documents, ...rest] = node.segments
  const isText = (parts: PathPart[] | undefined, value: string) =>
    parts?.length === 1 && parts[0]!.kind === 'text' && parts[0]!.value === value
  // The database segment is not read: rules can only look up documents in their own database.
  if (!isText(databases, 'databases') || !isText(documents, 'documents') || rest.length === 0) return undefined
  let path = ''
  let auth = false
  for (const parts of rest) {
    const s = segment(parts, env, ctx)
    if (!s) return undefined
    path += `/${s.text}`
    auth ||= s.auth
  }
  return parseLookup(`doc(${path}).x`) ? { path, auth } : undefined
}

// P' for a document path node (a path literal, or anything resolving to one: a let, a param).
export function lookupPath(node: Node, env: Env, ctx: NormalizeContext): { path: string; auth: boolean } | undefined {
  if (node.type === 'path') return translate(node, env, ctx)
  const v = resolveValue(node, env, ctx)
  return v?.kind === 'path' ? { path: v.path, auth: v.auth } : undefined
}

/**
 * The path argument when `call` is the built-in lookup `name`: `get(P)` / `exists(P)` in Firestore,
 * `firestore.get(P)` / `firestore.exists(P)` in Storage. Matched by callee shape, never a user function.
 */
export function lookupArg(call: Call, name: 'get' | 'exists', env: Env, ctx: NormalizeContext): Node | undefined {
  const { callee, args } = call
  if (args.length !== 1) return undefined
  if (ctx.store === 'firestore') {
    // A user function of the same name: which one Firestore calls is not modelled, so the call stays opaque.
    if (callee.type !== 'ident' || callee.name !== name || env.scope.findFunction(name)) return undefined
    return args[0]
  }
  if (callee.type !== 'member' || callee.property !== name) return undefined
  const object = resolveValue(callee.object, env, ctx)
  return object?.kind === 'object' && object.name === 'firestore' ? args[0] : undefined
}
