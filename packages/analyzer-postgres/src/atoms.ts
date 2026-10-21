import type { Atom, Expr, Literal, Operand } from '@holdline/core'

export const SIGNED_IN: Expr = { atom: { op: 'authenticated' } }

type Comparison = Extract<Atom, { left: Operand }>

// An anonymous caller is "no actor" in the facts, yet in Supabase it carries these claims and role 'anon'.
// The claims in the anon key's token (shared with anon.ts and subquery.ts).
export const ANON_KEY_CLAIMS = ['role', 'iss', 'ref', 'aud', 'iat', 'exp']
// True for actor.role and actor.claim.<k>[.…] with k in ANON_KEY_CLAIMS: not null for an anonymous caller.
export const isAnonKeyOperand = (o: Operand) => typeof o === 'string'
  && (o === 'actor.role' || (o.startsWith('actor.claim.') && ANON_KEY_CLAIMS.includes(o.split('.')[2]!)))
const ANON_CLAIMS = new Set(ANON_KEY_CLAIMS.filter(c => c !== 'role')) // role has its own rules below
const NUMBER_LIKE = /^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$/

const literal = (o: Operand): Literal | undefined => (typeof o === 'object' ? o.literal : undefined)
const isRole = (o: Operand) => o === 'actor.role' || o === 'actor.claim.role'
const isClaim = (o: Operand) => typeof o === 'string' && o.startsWith('actor.claim.')
// `->>` yields text, but the claim's JSON value may be a boolean, a number or null.
const plainString = (v: Literal | undefined): v is string =>
  typeof v === 'string' && v !== 'true' && v !== 'false' && v !== 'null' && !NUMBER_LIKE.test(v)

// The atom for a comparison, or undefined when it can't be stated exactly (the caller makes it opaque).
// A result may allow more than the SQL, never less.
export function atomExpr(a: Comparison): Expr | undefined {
  const { left, right, op } = a
  const sides = [left, right]
  if (sides.some(o => typeof o === 'string' && o.startsWith('actor.claim.') && ANON_CLAIMS.has(o.split('.')[2]!))) return undefined
  const role = sides.find(isRole)
  if (role !== undefined) {
    const other = literal(role === left ? right : left)
    if (op === 'eq') return typeof other === 'string' ? (other === 'anon' ? { not: SIGNED_IN } : { atom: a }) : undefined
    const list = literal(right)
    return op === 'in' && role === left && Array.isArray(list) && list.every(v => typeof v === 'string') && !list.includes('anon')
      ? { atom: a } : undefined
  }
  const claim = sides.find(isClaim)
  if (claim !== undefined) {
    if (op === 'lt' || op === 'gt') return undefined
    const other = literal(claim === left ? right : left)
    if (op === 'in') return claim === left && Array.isArray(other) && other.every(plainString) ? { atom: a } : undefined
    return plainString(other) ? { atom: a } : undefined
  }
  if (op === 'lt' || op === 'gt') {
    const l = literal(left)
    const r = literal(right)
    const oneNumber = (l === undefined) !== (r === undefined) && typeof (l ?? r) === 'number'
    return oneNumber ? { atom: a } : undefined
  }
  return { atom: a }
}
