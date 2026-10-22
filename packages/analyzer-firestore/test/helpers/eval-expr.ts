import { parseLookup, type Atom, type Expr, type Operand } from '@holdline/core'
import { isMap, sameValue, type World } from './world.js'

/**
 * The Holdline model of an Expr in world `w`. Absent fields are null; atoms with an actor operand, an `{actor.`
 * path or an actor-dependent lookup are false for an anonymous caller; `opaque` (and a `ref` with no vocabulary
 * entry) is undefined (unknown) and and/or/not are three-valued over it. `lt`/`gt` use Firestore ordering for two
 * values of the same orderable type (numbers, strings) and are false otherwise; `in` with a list on the right is
 * membership, with a map on the right is key membership. The prover matches these atoms by identity only, so any
 * interpretation is consistent with it; this one makes the model agree with Firestore.
 */
export function evalExpr(e: Expr, w: World, vocab: ReadonlyMap<string, Expr> = new Map()): boolean | undefined {
  if ('and' in e) return combine(e.and.map(x => evalExpr(x, w, vocab)), false)
  if ('or' in e) return combine(e.or.map(x => evalExpr(x, w, vocab)), true)
  if ('not' in e) {
    const v = evalExpr(e.not, w, vocab)
    return v === undefined ? undefined : !v
  }
  if ('ref' in e) {
    const expansion = vocab.get(e.ref)
    return expansion === undefined ? undefined : evalExpr(expansion, w, vocab)
  }
  if ('opaque' in e) return undefined
  return evalAtom(e.atom, w)
}

/** and (`dominant` false) / or (`dominant` true): the dominant value wins, then unknown, then the other value. */
function combine(values: (boolean | undefined)[], dominant: boolean): boolean | undefined {
  if (values.includes(dominant)) return dominant
  return values.includes(undefined) ? undefined : !dominant
}

const ANONYMOUS = Symbol('anonymous') // the operand reads the actor and there is none

/** `a.b.c` inside a record: null when any step is absent or not a map. */
function nested(root: unknown, dotted: string): unknown {
  let cur = root
  for (const key of dotted.split('.')) {
    if (!isMap(cur) || !Object.hasOwn(cur, key)) return null
    cur = cur[key]
  }
  return cur
}

/** A lookup path with its `{operand}` placeholders filled, or undefined when a value cannot form a segment. */
function fill(path: string, w: World): string | undefined | typeof ANONYMOUS {
  let anonymous = false
  let unfillable = false
  const filled = path.replace(/\{([^}]+)\}/g, (_, operand: string) => {
    const v = resolve(operand, w)
    if (v === ANONYMOUS) anonymous = true
    else if (typeof v === 'string') return v
    else if (typeof v === 'number' && Number.isInteger(v)) return String(v)
    else unfillable = true
    return ''
  })
  return anonymous ? ANONYMOUS : unfillable ? undefined : filled
}

function resolve(o: Operand, w: World): unknown {
  if (typeof o !== 'string') return o.literal
  const lookup = parseLookup(o)
  if (lookup) {
    const path = fill(lookup.path, w)
    if (path === ANONYMOUS) return ANONYMOUS
    return path === undefined ? null : nested(w.docs[path], lookup.field)
  }
  const dot = o.indexOf('.')
  const head = o.slice(0, dot)
  const rest = o.slice(dot + 1)
  switch (head) {
    case 'actor':
      if (!w.actor) return ANONYMOUS
      if (rest === 'uid') return w.actor.uid
      if (rest.startsWith('claim.')) return nested(w.actor.claims, rest.slice('claim.'.length))
      break
    case 'resource': return nested(w.resource, rest)
    case 'incoming': return nested(w.incoming, rest)
    case 'param': return w.params[rest] ?? null
  }
  throw new Error(`unsupported operand ${o}`)
}

function evalAtom(atom: Atom, w: World): boolean {
  switch (atom.op) {
    case 'authenticated': return w.actor !== null
    case 'exists': {
      const path = fill(atom.doc, w)
      return typeof path === 'string' && w.docs[path] !== undefined
    }
    case 'isNull': {
      const v = resolve(atom.operand, w)
      return v !== ANONYMOUS && v === null
    }
  }
  const l = resolve(atom.left, w)
  const r = resolve(atom.right, w)
  if (l === ANONYMOUS || r === ANONYMOUS) return false
  switch (atom.op) {
    case 'eq': return sameValue(l, r)
    case 'ne': return !sameValue(l, r)
    case 'lt':
    case 'gt': {
      const ordered = (typeof l === 'number' && typeof r === 'number') || (typeof l === 'string' && typeof r === 'string')
      if (!ordered) return false
      return atom.op === 'lt' ? (l as number | string) < (r as number | string) : (l as number | string) > (r as number | string)
    }
    case 'in':
      if (Array.isArray(r)) return r.some(x => sameValue(x, l))
      return isMap(r) && typeof l === 'string' && Object.hasOwn(r, l)
  }
}
