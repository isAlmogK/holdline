import { deepEqual } from './canonical.js'
import { isLookupOperand, type Atom, type Expr, type Literal, type Operand } from './expr.js'

export type Vocabulary = ReadonlyMap<string, Expr>
export type Implication = { ok: true } | { ok: false; unproven: Expr }

export function expand(expr: Expr, vocab: Vocabulary, seen: ReadonlySet<string> = new Set()): Expr {
  if ('ref' in expr) {
    if (seen.has(expr.ref)) return { opaque: `circular predicate "${expr.ref}"` }
    const target = vocab.get(expr.ref)
    if (!target) return { opaque: `unknown predicate "${expr.ref}"` }
    return expand(target, vocab, new Set([...seen, expr.ref]))
  }
  if ('and' in expr) return { and: expr.and.map(e => expand(e, vocab, seen)) }
  if ('or' in expr) return { or: expr.or.map(e => expand(e, vocab, seen)) }
  if ('not' in expr) return { not: expand(expr.not, vocab, seen) }
  return expr
}

const isLiteral = (o: Operand): o is { literal: Literal } => typeof o !== 'string'
const isActor = (o: Operand) => typeof o === 'string' && o.startsWith('actor.')
const actorDependent = (o: Operand) => isActor(o) || (isLookupOperand(o) && o.includes('{actor.'))

function normalizeAtom(a: Atom): Atom {
  if ((a.op === 'eq' || a.op === 'ne') && isLiteral(a.left) && !isLiteral(a.right)) {
    return { op: a.op, left: a.right, right: a.left }
  }
  return a
}

// Only atoms that are false for an anonymous caller imply `authenticated`. Store semantics that
// deny anonymous callers (Firestore, RLS) are the analyzers' job: they add an explicit `authenticated` atom.
function impliesAuthenticated(a: Atom): boolean {
  switch (a.op) {
    case 'authenticated': return true
    case 'exists': return a.doc.includes('{actor.')
    case 'eq':
    case 'in': {
      const [actorSide, other] = actorDependent(a.left) ? [a.left, a.right] : actorDependent(a.right) ? [a.right, a.left] : [undefined, undefined]
      if (actorSide === undefined || other === undefined || !isLiteral(other)) return false
      const v = other.literal
      if (a.op === 'in') return Array.isArray(v) && v.length > 0
      return typeof v === 'string' || typeof v === 'number'
    }
    default: return false
  }
}

function arrayLiteral(o: Operand): (string | number)[] | undefined {
  return isLiteral(o) && Array.isArray(o.literal) ? o.literal : undefined
}

function scalarLiteral(o: Operand): (string | number)[] | undefined {
  if (!isLiteral(o)) return undefined
  const v = o.literal
  return typeof v === 'string' || typeof v === 'number' ? [v] : undefined
}

export function atomImplies(rawA: Atom, rawB: Atom): boolean {
  const a = normalizeAtom(rawA)
  const b = normalizeAtom(rawB)
  if (deepEqual(a, b)) return true
  if (b.op === 'authenticated') return impliesAuthenticated(a)
  if (a.op === 'authenticated') return false
  if (b.op === 'exists') return a.op === 'exists' && a.doc === b.doc
  if (b.op === 'isNull') return a.op === 'isNull' && deepEqual(a.operand, b.operand)
  if (a.op === 'exists' || a.op === 'isNull') return false
  if (b.op === 'in') {
    if ((a.op !== 'in' && a.op !== 'eq') || !deepEqual(a.left, b.left)) return false
    const have = a.op === 'in' ? arrayLiteral(a.right) : scalarLiteral(a.right)
    const allowed = arrayLiteral(b.right)
    return !!have && !!allowed && have.every(v => allowed.includes(v))
  }
  if (a.op !== b.op) return false
  if (deepEqual(a.left, b.left) && deepEqual(a.right, b.right)) return true
  return (a.op === 'eq' || a.op === 'ne') && deepEqual(a.left, b.right) && deepEqual(a.right, b.left)
}

// Both sides must already be expanded. Order matters: split the requirement's `and`,
// then the condition's `or`, then try the condition's `and`, then the requirement's `or`.
export function prove(c: Expr, r: Expr): boolean {
  if ('and' in r) return r.and.every(ri => prove(c, ri))
  if ('or' in c) return c.or.every(ci => prove(ci, r))
  if ('and' in c && c.and.some(ci => prove(ci, r))) return true
  if ('or' in r && r.or.some(ri => prove(c, ri))) return true
  if ('atom' in c && 'atom' in r) return atomImplies(c.atom, r.atom)
  if ('not' in c && 'not' in r) return !containsOpaque(c.not) && deepEqual(c.not, r.not)
  return false
}

export function implies(cond: Expr, req: Expr, vocab: Vocabulary): Implication {
  const c = expand(cond, vocab)
  const parts = 'and' in req ? req.and : [req]
  const failing = parts.filter(p => !prove(c, expand(p, vocab)))
  if (failing.length === 0) return { ok: true }
  return { ok: false, unproven: failing.length === 1 ? failing[0]! : { and: failing } }
}

function containsOpaque(e: Expr): boolean {
  if ('opaque' in e) return true
  if ('and' in e) return e.and.some(containsOpaque)
  if ('or' in e) return e.or.some(containsOpaque)
  if ('not' in e) return containsOpaque(e.not)
  return false
}

function mapAtoms(expr: Expr, f: (a: Atom) => Atom): Expr {
  if ('atom' in expr) return { atom: f(expr.atom) }
  if ('and' in expr) return { and: expr.and.map(e => mapAtoms(e, f)) }
  if ('or' in expr) return { or: expr.or.map(e => mapAtoms(e, f)) }
  if ('not' in expr) return { not: mapAtoms(expr.not, f) }
  return expr
}

function atoms(expr: Expr): Atom[] {
  if ('atom' in expr) return [expr.atom]
  if ('and' in expr) return expr.and.flatMap(atoms)
  if ('or' in expr) return expr.or.flatMap(atoms)
  if ('not' in expr) return atoms(expr.not)
  return []
}

// Renames `param.<name>` operands and `{param.<name>}` placeholders (in exists docs and lookup operands) through `names`.
// With `fresh`, a param that `names` does not map gets a fresh name (`__p0`, `__p1`, ... in order of first
// appearance) instead of keeping its own, so it cannot collide with a param of the other side.
export function renameParams(expr: Expr, names: ReadonlyMap<string, string>, opts: { fresh?: boolean } = {}): Expr {
  if (names.size === 0 && !opts.fresh) return expr
  const fresh = new Map<string, string>()
  const rename = (n: string): string => {
    const mapped = names.get(n)
    if (mapped !== undefined) return mapped
    if (!opts.fresh) return n
    if (!fresh.has(n)) fresh.set(n, `__p${fresh.size}`)
    return fresh.get(n)!
  }
  const doc = (d: string) =>
    d.replace(/\{param\.([A-Za-z0-9_]+)\}/g, (_, n: string) => `{param.${rename(n)}}`)
  const op = (o: Operand): Operand =>
    typeof o !== 'string' ? o : o.startsWith('param.') ? `param.${rename(o.slice(6))}` : isLookupOperand(o) ? doc(o) : o
  return mapAtoms(expr, a => {
    switch (a.op) {
      case 'authenticated': return a
      case 'exists': return { op: 'exists', doc: doc(a.doc) }
      case 'isNull': return { op: 'isNull', operand: op(a.operand) }
      default: return { op: a.op, left: op(a.left), right: op(a.right) }
    }
  })
}

export function collectRefs(expr: Expr): string[] {
  if ('ref' in expr) return [expr.ref]
  if ('and' in expr) return expr.and.flatMap(collectRefs)
  if ('or' in expr) return expr.or.flatMap(collectRefs)
  if ('not' in expr) return collectRefs(expr.not)
  return []
}

// True when the operand appears as an operand, or as a `{operand}` placeholder in an `exists` doc or a lookup path.
export function mentionsOperand(expr: Expr, operand: string): boolean {
  const placeholder = `{${operand}}`
  const mentions = (o: Operand) => o === operand || (isLookupOperand(o) && o.includes(placeholder))
  return atoms(expr).some(a => {
    switch (a.op) {
      case 'authenticated': return false
      case 'exists': return a.doc.includes(placeholder)
      case 'isNull': return mentions(a.operand)
      default: return mentions(a.left) || mentions(a.right)
    }
  })
}

export function flattenAnd(expr: Expr): Expr[] {
  return 'and' in expr ? expr.and.flatMap(flattenAnd) : [expr]
}
