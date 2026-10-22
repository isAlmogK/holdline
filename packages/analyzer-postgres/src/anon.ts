import type { Expr, Operand } from '@holdline/core'
import { isAnonKeyOperand } from './atoms.js'

export type Tri = 'T' | 'F' | '?'

const actorDependent = (o: Operand) => typeof o === 'string'
  && !isAnonKeyOperand(o) // set for anonymous callers too
  && (o.startsWith('actor.') || (o.startsWith('doc(') && o.includes('{actor.')))

// The condition's value for an anonymous caller: auth.uid() and auth.jwt() are null, and a comparison
// with null is never true, so every atom that reads the actor is false (the facts' anonymous caller convention).
export function forAnonymous(e: Expr): Tri {
  if ('and' in e) { const v = e.and.map(forAnonymous); return v.includes('F') ? 'F' : v.every(x => x === 'T') ? 'T' : '?' }
  if ('or' in e) { const v = e.or.map(forAnonymous); return v.includes('T') ? 'T' : v.every(x => x === 'F') ? 'F' : '?' }
  if ('not' in e) { const v = forAnonymous(e.not); return v === 'T' ? 'F' : v === 'F' ? 'T' : '?' }
  if (!('atom' in e)) return '?'
  const a = e.atom
  if (a.op === 'authenticated') return 'F'
  if (a.op === 'exists') return a.doc.includes('{actor.') ? 'F' : '?'
  if (a.op === 'isNull') return actorDependent(a.operand) ? 'F' : '?'
  return actorDependent(a.left) || actorDependent(a.right) ? 'F' : '?'
}

// Analyzers state sign-in explicitly (facts.md): a policy no anonymous caller can satisfy requires it.
export function requireSignIn(e: Expr): Expr {
  if (forAnonymous(e) !== 'F') return e
  if ('and' in e && e.and.some(c => 'atom' in c && c.atom.op === 'authenticated')) return e
  return { and: [{ atom: { op: 'authenticated' } }, ...('and' in e ? e.and : [e])] }
}
