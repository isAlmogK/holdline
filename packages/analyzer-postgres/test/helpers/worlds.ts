import type { Row, World } from './model.js'

// Sampled worlds for the soundness test: callers, stored and incoming docs, and memberships.

export const U1 = '00000000-0000-0000-0000-0000000000a1'
export const U2 = '00000000-0000-0000-0000-0000000000a2'
export const O1 = '00000000-0000-0000-0000-0000000000b1'
export const O2 = '00000000-0000-0000-0000-0000000000b2'
export const DOC = '00000000-0000-0000-0000-0000000000c1'
// The claims Supabase's anon key carries: the model's anonymous caller (actor null) still has these in SQL.
export const ANON_KEY = { role: 'anon', iss: 'supabase', ref: 'demo', iat: 1700000000, exp: 2000000000 }

// A world for the model, and the claims SQL sees (the anon key's, or none, for an anonymous caller).
export interface Sample { world: World; jwt: Record<string, unknown> | null }

// A small deterministic generator (mulberry32), so failures reproduce.
function rng(seed: number) {
  let s = seed >>> 0
  return <T>(xs: readonly T[]): T => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return xs[((t ^ (t >>> 14)) >>> 0) % xs.length]!
  }
}

export function samples(count: number, seed: number): Sample[] {
  const pick = rng(seed)
  const doc = (): Row => ({
    id: DOC, org_id: pick([O1, O2, null]), owner_id: pick([U1, U2, null]),
    status: pick(['a', 'b', 'draft', 'submitted', null]), n: pick([0, 5, null]),
    deleted_at: pick([null, '2026-01-01T00:00:00+00:00']),
  })
  const membership = [{ org_id: O1, user_id: U1, role: 'admin' }, { org_id: O2, user_id: U2, role: 'member' }, { org_id: O1, user_id: U2, role: 'member' }]
  return Array.from({ length: count }, () => {
    const uid = pick([null, U1, U2])
    const extra = pick([{}, { user_role: 'admin' }, { app_metadata: { tier: 'gold' } }])
    const actor = uid === null ? null : { uid, claims: { sub: uid, role: 'authenticated', aud: 'authenticated', ...extra } }
    const world: World = {
      actor, resource: doc(), incoming: doc(),
      tables: { 'public.members': membership.filter(() => pick([true, false])) },
    }
    return { world, jwt: actor ? actor.claims : pick([null, ANON_KEY]) }
  })
}
