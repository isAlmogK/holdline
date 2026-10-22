import type { Allow, Block, FunctionDecl, Node } from '../../src/ast.js'
import { parseRules } from '../../src/parser.js'
import { rulesSource, type Row } from './rows.js'
import { documentAt, ERROR, member, Members, Namespace, PathValue, segmentText, type V } from './rules-values.js'
import { isMap, sameValue, type World } from './world.js'

/**
 * A rules interpreter with Firestore semantics, independent of the normalizer: it shares only the parser's AST.
 * Reading a missing field, a member of null (`request.auth` when anonymous, `get` of a missing document), a type
 * mismatch in an ordering or `in`, and a non-boolean where a boolean is needed are errors. `&&`/`||` absorb
 * errors as Firestore does (false && error = false, true || error = true); everything else with an error operand
 * is an error. A top-level error denies. Forms outside the subset the rows use (nodes, members of `request` and
 * `resource`, key types) throw: a bug in the row list, not a pass.
 */

/** A function param or let: evaluated lazily, so an unused failing argument does not fail the call (the most permissive reading). */
class Thunk {
  private value: V | undefined
  private done = false
  constructor(private readonly node: Node, private readonly env: Env) {}
  force(): V {
    if (!this.done) { this.value = evaluate(this.node, this.env); this.done = true }
    return this.value
  }
}

interface Ctx { store: Row['store']; world: World; functions: ReadonlyMap<string, FunctionDecl>; wildcards: ReadonlySet<string> }
interface Env { ctx: Ctx; bindings: ReadonlyMap<string, Thunk>; depth: number }

type Located = { allow: Allow; functions: Map<string, FunctionDecl>; wildcards: Set<string> }
const located = new WeakMap<Row, Located>()

/** The allow on `match /things/{thingId}`, the functions in scope there and the wildcards of its match path. */
function locate(row: Row): Located {
  const hit = located.get(row)
  if (hit) return hit
  const parsed = parseRules(rulesSource(row))
  if (!parsed.ok) throw new Error(`${row.name}: ${parsed.error.message}`)
  const functions = new Map<string, FunctionDecl>()
  const wildcards = new Set<string>()
  const walk = (block: Block): Allow | undefined => {
    for (const fn of block.functions) functions.set(fn.name, fn)
    if (block.allows[0]) return block.allows[0]
    for (const m of block.matches) {
      for (const s of m.path) if (s.kind === 'wildcard') wildcards.add(s.name)
      const found = walk(m.body)
      if (found) return found
    }
    return undefined
  }
  const allow = walk(parsed.ast.services[0]!.body)
  if (!allow?.condition) throw new Error(`${row.name}: no conditional allow`)
  const out = { allow, functions, wildcards }
  located.set(row, out)
  return out
}

const DEFAULT_WILDCARDS: Record<string, string> = { database: '(default)', bucket: 'bucket' }

function ident(name: string, env: Env): V {
  const binding = env.bindings.get(name)
  if (binding) return binding.force()
  const { world, store, wildcards } = env.ctx
  if (wildcards.has(name)) {
    const v = world.params[name] ?? DEFAULT_WILDCARDS[name]
    if (v === undefined) throw new Error(`no value for wildcard ${name}`)
    return v
  }
  const storeKey = store === 'firestore' ? 'data' : 'metadata'
  const record = (what: string, data: Record<string, unknown> | undefined) => data === undefined ? null : new Members(what, { [storeKey]: data })
  if (name === 'request') {
    const auth = world.actor ? { uid: world.actor.uid, token: world.actor.claims } : null
    return new Members('request', { auth, resource: record('request.resource', world.incoming) })
  }
  if (name === 'resource') return record('resource', world.resource)
  if (name === 'firestore' && store === 'storage') return new Namespace('firestore')
  throw new Error(`unsupported identifier ${name}`)
}

function call(node: Extract<Node, { type: 'call' }>, env: Env): V {
  const { callee, args } = node
  const { store, functions } = env.ctx
  if (callee.type === 'ident' && functions.has(callee.name)) {
    const fn = functions.get(callee.name)!
    if (fn.params.length !== args.length) throw new Error(`${callee.name} called with ${args.length} arguments`)
    if (env.depth >= 20) return ERROR
    const bindings = new Map<string, Thunk>(fn.params.map((p, i) => [p, new Thunk(args[i]!, env)]))
    let inner: Env = { ctx: env.ctx, bindings, depth: env.depth + 1 }
    for (const decl of fn.lets) inner = { ...inner, bindings: new Map(inner.bindings).set(decl.name, new Thunk(decl.value, inner)) }
    return evaluate(fn.returns, inner)
  }
  const builtin = callee.type === 'ident' && store === 'firestore' ? callee.name
    : callee.type === 'member' && evaluate(callee.object, env) instanceof Namespace ? callee.property
    : undefined
  if ((builtin === 'get' || builtin === 'exists') && args.length === 1) {
    const doc = documentAt(evaluate(args[0]!, env), env.ctx.world.docs)
    if (doc === ERROR) return ERROR
    return builtin === 'exists' ? doc !== null : doc
  }
  if (callee.type === 'member' && callee.property === 'get' && args.length === 2) {
    const map = evaluate(callee.object, env)
    const key = evaluate(args[0]!, env)
    const fallback = evaluate(args[1]!, env)
    if (Array.isArray(key) || map instanceof Members) throw new Error(`unsupported get at line ${node.line}`)
    if (!isMap(map) || typeof key !== 'string' || fallback === ERROR) return ERROR
    return Object.hasOwn(map, key) ? map[key] : fallback
  }
  throw new Error(`unsupported call at line ${node.line}`)
}

function compare(op: string, l: V, r: V): V {
  if (l === ERROR || r === ERROR) return ERROR
  switch (op) {
    case '==': return sameValue(l, r)
    case '!=': return !sameValue(l, r)
    case '<': case '<=': case '>': case '>=': {
      const ordered = (typeof l === 'number' && typeof r === 'number') || (typeof l === 'string' && typeof r === 'string')
      if (!ordered) return ERROR
      const a = l as number | string
      const b = r as number | string
      return op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : a >= b
    }
    case 'in':
      if (Array.isArray(r)) return r.some(x => sameValue(x, l))
      if (isMap(r)) return typeof l === 'string' && Object.hasOwn(r, l)
      return ERROR
  }
  throw new Error(`unsupported operator ${op}`)
}

function evaluate(node: Node, env: Env): V {
  switch (node.type) {
    case 'string': case 'int': case 'float': case 'bool': return node.value
    case 'null': return null
    case 'list': {
      const items = node.items.map(item => evaluate(item, env))
      return items.includes(ERROR) ? ERROR : items
    }
    case 'path': {
      const segments: string[] = []
      for (const parts of node.segments) {
        const text = segmentText(parts.map(part => (part.kind === 'text' ? part.value : evaluate(part.expr, env))))
        if (text === ERROR) return ERROR
        segments.push(text)
      }
      return new PathValue(segments)
    }
    case 'ident': return ident(node.name, env)
    case 'member': return member(evaluate(node.object, env), node.property)
    case 'index': {
      const key = evaluate(node.index, env)
      if (key === ERROR) return ERROR
      if (typeof key !== 'string') throw new Error(`unsupported index key at line ${node.line}`)
      return member(evaluate(node.object, env), key)
    }
    case 'call': return call(node, env)
    case 'unary': {
      const v = evaluate(node.operand, env)
      if (node.op === '!') return typeof v === 'boolean' ? !v : ERROR
      return typeof v === 'number' ? -v : ERROR
    }
    case 'ternary': {
      const test = evaluate(node.test, env)
      return typeof test === 'boolean' ? evaluate(test ? node.then : node.else, env) : ERROR
    }
    case 'binary': {
      if (node.op === '&&' || node.op === '||') {
        const absorbing = node.op === '||' // true absorbs ||, false absorbs &&
        const l = evaluate(node.left, env)
        if (l === absorbing) return absorbing
        const r = evaluate(node.right, env)
        if (r === absorbing) return absorbing
        return typeof l === 'boolean' && typeof r === 'boolean' ? !absorbing : ERROR
      }
      return compare(node.op, evaluate(node.left, env), evaluate(node.right, env))
    }
    default:
      throw new Error(`unsupported node ${node.type} at line ${node.line}`)
  }
}

/** What Firestore decides for the row's condition in world `w`: true (allow), false or 'error' (both deny). */
export function interpret(row: Row, w: World): boolean | 'error' {
  const { allow, functions, wildcards } = locate(row)
  const ctx: Ctx = { store: row.store, world: w, functions, wildcards }
  const v = evaluate(allow.condition!, { ctx, bindings: new Map(), depth: 0 })
  return typeof v === 'boolean' ? v : 'error'
}
