import type { Expr, Operand } from '@holdline/core'

export type Tri = 'T' | 'F' | '?'

// Claims Supabase also puts in the anon key's token, so they are not null for anonymous callers.
const ANON_CLAIMS = ['role', 'iss', 'ref', 'aud', 'iat', 'exp'].map(c => `actor.claim.${c}`)

const actorDependent = (o: Operand) => typeof o === 'string'
  && !ANON_CLAIMS.some(c => o === c || o.startsWith(`${c}.`))
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
  return { and: [{ atom: { op: 'authenticated' } }, ...('and' in e ? e.and : [e])] }
}
