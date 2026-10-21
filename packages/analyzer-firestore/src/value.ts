import { OPERAND_PATTERN, type Literal } from '@holdline/core'
import type { Node } from './ast.js'
import type { Env } from './scope.js'

export type Value =
  | { kind: 'operand'; operand: string; auth: boolean; fallback?: { value: Literal } } // fallback: from x.get('f', d)
  | { kind: 'literal'; value: Literal }
  | { kind: 'object'; name: 'request' | 'request.auth' | 'request.resource' | 'resource' | 'firestore' }
  | { kind: 'map'; prefix: string; auth: boolean } // fields are operands `${prefix}.${field}`
  | { kind: 'doc'; path: string; auth: boolean } // a get(P) result; `.data` gives map `doc(P)`
  | { kind: 'path'; path: string; auth: boolean } // a document path in P' form

export interface NormalizeContext {
  store: 'firestore' | 'storage'
  src: string // the file's source, for opaque text
  recognizers: ReadonlyMap<string, string> // zero-parameter function name -> vocabulary id
  functionsUsed: Set<string>
}

// One field name. A dot would read a nested field in the model but a top-level key in Firestore.
const FIELD = /^[A-Za-z0-9_]+$/

const literal = (value: Literal): Value => ({ kind: 'literal', value })

function operand(text: string, auth: boolean, fallback?: { value: Literal }): Value | undefined {
  if (!OPERAND_PATTERN.test(text)) return undefined
  return fallback ? { kind: 'operand', operand: text, auth, fallback } : { kind: 'operand', operand: text, auth }
}

/** The map a store's `.data` (Firestore) or `.metadata` (Storage) member gives. */
function storeMap(ctx: NormalizeContext, name: string, prefix: string): Value | undefined {
  const member = ctx.store === 'firestore' ? 'data' : 'metadata'
  return name === member ? { kind: 'map', prefix, auth: false } : undefined
}

/** `v.name` or `v['name']`. */
function field(v: Value | undefined, name: string, ctx: NormalizeContext): Value | undefined {
  if (!v) return undefined
  if (v.kind === 'object') {
    switch (v.name) {
      case 'request':
        if (name === 'auth') return { kind: 'object', name: 'request.auth' }
        if (name === 'resource') return { kind: 'object', name: 'request.resource' }
        return undefined
      case 'request.auth':
        if (name === 'uid') return operand('actor.uid', true)
        if (name === 'token') return { kind: 'map', prefix: 'actor.claim', auth: true }
        return undefined
      case 'request.resource': return storeMap(ctx, name, 'incoming')
      case 'resource': return storeMap(ctx, name, 'resource')
      default: return undefined
    }
  }
  if (!FIELD.test(name)) return undefined
  if (v.kind === 'map') return operand(`${v.prefix}.${name}`, v.auth)
  if (v.kind === 'operand' && !v.fallback) return operand(`${v.operand}.${name}`, v.auth)
  return undefined
}

function stringLiteral(node: Node, env: Env, ctx: NormalizeContext): string | undefined {
  const v = resolveValue(node, env, ctx)
  return v?.kind === 'literal' && typeof v.value === 'string' ? v.value : undefined
}

/** `x.get('f', d)` on a map or a fallback-free operand, with a literal `d`. Other calls are not values yet. */
function resolveCall(node: Extract<Node, { type: 'call' }>, env: Env, ctx: NormalizeContext): Value | undefined {
  const { callee, args } = node
  if (callee.type !== 'member' || callee.property !== 'get' || args.length !== 2) return undefined
  const x = resolveValue(callee.object, env, ctx)
  if (!x || !(x.kind === 'map' || (x.kind === 'operand' && !x.fallback))) return undefined
  const key = stringLiteral(args[0]!, env, ctx)
  const d = resolveValue(args[1]!, env, ctx)
  if (key === undefined || d?.kind !== 'literal' || !FIELD.test(key)) return undefined
  const prefix = x.kind === 'map' ? x.prefix : x.operand
  return operand(`${prefix}.${key}`, x.auth, { value: d.value })
}

function resolveIdent(name: string, env: Env, ctx: NormalizeContext): Value | undefined {
  const binding = env.bindings.get(name)
  if (binding) return resolveValue(binding.node, binding.env, ctx)
  if (env.scope.isWildcard(name)) {
    // A rest wildcard holds a path; comparing it as a string would not be exact.
    return env.scope.isRestWildcard(name) ? undefined : operand(`param.${name}`, false)
  }
  if (name === 'request' || name === 'resource') return { kind: 'object', name }
  return undefined
}

/** The value a rules expression denotes, or undefined when Holdline cannot represent it exactly. */
export function resolveValue(node: Node, env: Env, ctx: NormalizeContext): Value | undefined {
  switch (node.type) {
    case 'string':
    case 'int':
    case 'float':
    case 'bool':
      return literal(node.value)
    case 'null':
      return literal(null)
    case 'unary': {
      if (node.op !== '-') return undefined
      const v = resolveValue(node.operand, env, ctx)
      return v?.kind === 'literal' && typeof v.value === 'number' ? literal(-v.value) : undefined
    }
    case 'list': {
      const items: (string | number)[] = []
      for (const item of node.items) {
        const v = resolveValue(item, env, ctx)
        if (v?.kind !== 'literal' || (typeof v.value !== 'string' && typeof v.value !== 'number')) return undefined
        items.push(v.value)
      }
      return literal(items)
    }
    case 'ident':
      return resolveIdent(node.name, env, ctx)
    case 'member':
      return field(resolveValue(node.object, env, ctx), node.property, ctx)
    case 'index': {
      const key = stringLiteral(node.index, env, ctx)
      return key === undefined ? undefined : field(resolveValue(node.object, env, ctx), key, ctx)
    }
    case 'call':
      return resolveCall(node, env, ctx)
    default:
      return undefined
  }
}
