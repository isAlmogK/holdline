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
const EXPRS: Record<string, Expr> = { owner: OWNER, true: { and: [] }, live: { atom: { op: 'isNull', operand: 'resource.deleted_at' } } }
const condition: ConditionOf = (sql, _table, side) => {
  const e = EXPRS[sql]!
  return { expr: side === 'incoming' ? JSON.parse(JSON.stringify(e).replaceAll('resource.', 'incoming.')) : e, functions: sql === 'owner' ? ['public.f'] : [] }
}
const row = (over: Partial<PolicyRow>): PolicyRow =>
  ({ schema: 'public', table: 'docs', name: 'p', cmd: 'r', permissive: true, roles: ['public'], using: 'owner', check: null, ...over })
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
  it('keeps plain-dialect policies for any role and drops their restrictive ones', () => {
    const { policies, diagnostics } = buildPolicies([
      row({ name: 'app', roles: ['app_user'], using: 'true' }),
      row({ name: 'r', roles: ['app_user'], permissive: false, using: 'live' }),
    ], 'plain', condition, at)
    expect(policies.map(p => p.condition)).toEqual([{ and: [] }, { and: [] }])
    expect(diagnostics).toEqual([])
  })
})
