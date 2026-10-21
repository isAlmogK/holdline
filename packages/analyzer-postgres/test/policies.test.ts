import type { Expr } from '@holdline/core'
import { describe, expect, it } from 'vitest'
import { forAnonymous, requireSignIn } from '../src/anon.js'
import type { PolicyRow } from '../src/catalog.js'
import { buildPolicies, type ConditionOf } from '../src/policies.js'

const AUTH: Expr = { atom: { op: 'authenticated' } }
const eq = (left: string, right: string): Expr => ({ atom: { op: 'eq', left, right } })
const OWNER = eq('resource.owner_id', 'actor.uid')

describe('forAnonymous and requireSignIn', () => {
  it('knows which conditions are false for an anonymous caller', () => {
    expect(forAnonymous(OWNER)).toBe('F')
    expect(forAnonymous({ atom: { op: 'exists', doc: 'pg:public.m?user_id={actor.uid}' } })).toBe('F')
    expect(forAnonymous({ not: OWNER })).toBe('T')
    expect(forAnonymous({ not: AUTH })).toBe('T')
    expect(forAnonymous({ and: [] })).toBe('T')
    expect(forAnonymous({ or: [OWNER, { opaque: 'x' }] })).toBe('?')
    expect(forAnonymous({ and: [OWNER, { opaque: 'x' }] })).toBe('F')
    expect(forAnonymous(eq('actor.claim.role', 'resource.role'))).toBe('?')
    expect(forAnonymous({ atom: { op: 'isNull', operand: 'resource.deleted_at' } })).toBe('?')
  })
  it('adds authenticated only when the condition is false for anonymous callers', () => {
    expect(requireSignIn(OWNER)).toEqual({ and: [AUTH, OWNER] })
    expect(requireSignIn({ and: [OWNER, { atom: { op: 'isNull', operand: 'resource.d' } }] }))
      .toEqual({ and: [AUTH, OWNER, { atom: { op: 'isNull', operand: 'resource.d' } }] })
    expect(requireSignIn({ not: AUTH })).toEqual({ not: AUTH })
    expect(requireSignIn({ and: [] })).toEqual({ and: [] })
  })
})

// A fake normalizer: the SQL text names the Expr.
const EXPRS: Record<string, Expr> = { draft: eq('resource.status', 'draft'), submitted: eq('resource.status', 'submitted'), owner: OWNER, true: { and: [] }, live: { atom: { op: 'isNull', operand: 'resource.deleted_at' } } }
const condition: ConditionOf = (sql, _table, side) => {
  const e = EXPRS[sql]!
  return { expr: side === 'incoming' ? JSON.parse(JSON.stringify(e).replaceAll('resource.', 'incoming.')) : e, functions: sql === 'owner' ? ['public.f'] : [] }
}
// Coverage as readCatalog computes it for the shim's roles (none inherits another).
const covers = (roles: readonly string[]) =>
  ({ coversSignedIn: roles.some(r => r === 'public' || r === 'authenticated'), coversAnon: roles.some(r => r === 'public' || r === 'anon') })
const row = (over: Partial<PolicyRow>): PolicyRow =>
  ({ schema: 'public', table: 'docs', name: 'p', cmd: 'r', permissive: true, roles: ['public'], using: 'owner', check: null, ...covers(over.roles ?? ['public']), ...over })
const at = () => ({ file: 'm.sql', line: 3 })

describe('buildPolicies', () => {
  it('emits one policy per op with the right clause', () => {
    const { policies } = buildPolicies([row({ cmd: '*', using: 'owner' })], 'supabase', condition, at)
    const byOp = Object.fromEntries(policies.map(p => [p.ops[0], p.condition]))
    expect(Object.keys(byOp)).toEqual(['read', 'list', 'create', 'update', 'delete'])
    expect(byOp.read).toEqual({ and: [AUTH, OWNER] })
    expect(byOp.create).toEqual({ and: [AUTH, eq('incoming.owner_id', 'actor.uid')] })
    expect(byOp.update).toEqual({ and: [AUTH, OWNER, eq('incoming.owner_id', 'actor.uid')] })
    expect(policies[0]).toEqual({
      id: 'pg:public.docs#policy:p', store: 'pg-rls', target: 'public.docs', ops: ['read'],
      condition: { and: [AUTH, OWNER] }, functions: ['public.f'], evidence: { file: 'm.sql', line: 3 },
    })
  })
  it('uses WITH CHECK for insert and both clauses for update', () => {
    const { policies } = buildPolicies([
      row({ name: 'ins', cmd: 'a', using: null, check: 'owner' }),
      row({ name: 'upd', cmd: 'w', using: 'true', check: 'owner' }),
      row({ name: 'del', cmd: 'd', using: null }),
    ], 'supabase', condition, at)
    expect(policies.map(p => [p.id, p.ops, p.condition])).toEqual([
      ['pg:public.docs#policy:ins', ['create'], { and: [AUTH, eq('incoming.owner_id', 'actor.uid')] }],
      ['pg:public.docs#policy:upd', ['update'], { and: [AUTH, { and: [] }, eq('incoming.owner_id', 'actor.uid')] }],
      ['pg:public.docs#policy:del', ['delete'], { and: [] }],
    ])
  })
  it('ANDs restrictive policies into the permissive ones for the same ops', () => {
    const { policies } = buildPolicies([
      row({ name: 'all', using: 'true' }),
      row({ name: 'only live', permissive: false, cmd: '*', using: 'live' }),
    ], 'supabase', condition, at)
    expect(policies).toHaveLength(2)
    expect(policies.map(p => p.condition)).toEqual([
      { and: [{ and: [] }, EXPRS.live] }, { and: [{ and: [] }, EXPRS.live] },
    ])
  })
  it('applies Supabase roles: anon only, skipped roles with a warning', () => {
    const { policies, diagnostics } = buildPolicies([
      row({ name: 'anon read', roles: ['anon'], using: 'true' }),
      row({ name: 'svc', roles: ['service_role'], using: 'true' }),
      row({ name: 'anon restrict', roles: ['anon'], permissive: false, using: 'live' }),
    ], 'supabase', condition, at)
    expect(policies.map(p => p.condition)).toEqual([
      { and: [{ and: [{ not: AUTH }, { and: [] }] }, { or: [AUTH, EXPRS.live] }] },
      { and: [{ and: [{ not: AUTH }, { and: [] }] }, { or: [AUTH, EXPRS.live] }] },
    ])
    expect(diagnostics).toEqual([{
      analyzer: 'postgres', file: 'm.sql', severity: 'warning',
      message: 'policy "svc" on public.docs applies only to roles service_role; Holdline models the anon and authenticated roles, so it was skipped',
    }])
  })
  it('uses the coverage readCatalog computed, so a custom role granted to authenticated counts', () => {
    const { policies, diagnostics } = buildPolicies([
      row({ name: 'editors', roles: ['editors'], coversSignedIn: true, coversAnon: false, using: 'true' }),
      row({ name: 'r', roles: ['visitors'], coversSignedIn: false, coversAnon: true, permissive: false, using: 'live' }),
    ], 'supabase', condition, at)
    const want = { and: [AUTH, { and: [AUTH, { and: [] }] }, { or: [AUTH, EXPRS.live] }] }
    expect(policies.map(p => p.condition)).toEqual([want, want]) // read and list
    expect(diagnostics).toEqual([])
  })
  it('keeps plain-dialect policies for any role and drops their restrictive ones', () => {
    const { policies, diagnostics } = buildPolicies([
      row({ name: 'app', roles: ['app_user'], using: 'true' }),
      row({ name: 'r', roles: ['app_user'], permissive: false, using: 'live' }),
    ], 'plain', condition, at)
    expect(policies.map(p => p.condition)).toEqual([{ and: [] }, { and: [] }])
    expect(diagnostics).toEqual([])
  })
  it('ORs the WITH CHECK clauses of all permissive update policies', () => {
    const { policies } = buildPolicies([
      row({ name: 'A', cmd: 'w', using: 'owner', check: 'draft' }),
      row({ name: 'B', cmd: 'w', using: 'submitted', check: 'submitted' }),
    ], 'plain', condition, at)
    const checks = { or: [eq('incoming.status', 'draft'), eq('incoming.status', 'submitted')] }
    expect(policies.map(p => p.condition)).toEqual([
      { and: [AUTH, OWNER, checks] },
      { and: [EXPRS.submitted, checks] },
    ])
  })
  it('wraps each policy for the callers its roles cover', () => {
    const signed = buildPolicies([row({ roles: ['authenticated'], using: 'true' })], 'supabase', condition, at).policies
    expect(signed[0]!.condition).toEqual({ and: [AUTH, { and: [] }] })
    const { policies } = buildPolicies([
      row({ name: 'anon all', roles: ['anon'], using: 'true' }),
      row({ name: 'auth only', roles: ['authenticated'], permissive: false, using: 'owner' }),
    ], 'supabase', condition, at)
    // the restriction binds signed-in callers only, so anonymous reads stay possible
    expect(policies[0]!.condition).toEqual({ and: [{ and: [{ not: AUTH }, { and: [] }] }, { or: [{ not: AUTH }, OWNER] }] })
    expect(forAnonymous(policies[0]!.condition)).not.toBe('F')
  })
})
