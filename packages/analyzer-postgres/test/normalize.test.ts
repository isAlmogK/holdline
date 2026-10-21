import { beforeAll, describe, expect, it } from 'vitest'
import type { CatalogIndex } from '../src/catalog.js'
import { normalizeCondition } from '../src/normalize.js'
import { loadSqlParser, type SqlParse } from '../src/pgparse.js'
import type { Side } from '../src/scope.js'

let parse: SqlParse
beforeAll(async () => { parse = await loadSqlParser() })

const catalog: CatalogIndex = {
  relations: new Map([
    ['public.projects', new Set(['id', 'org_id', 'owner_id', 'status', 'n', 'deleted_at'])],
    ['public.memberships', new Set(['org_id', 'user_id', 'role'])],
    ['auth.users', new Set(['id', 'email'])],
  ]),
  functions: new Map(),
}

const norm = (sql: string, side: Side = 'resource', supabase = true) =>
  normalizeCondition(sql, { table: 'public.projects', side, catalog, parse, supabase }).expr
const atom = (a: object) => ({ atom: a })
const AUTH = atom({ op: 'authenticated' })

describe('normalizeCondition: operands', () => {
  it('maps auth functions and claims', () => {
    expect(norm('(owner_id = auth.uid())')).toEqual(atom({ op: 'eq', left: 'resource.owner_id', right: 'actor.uid' }))
    expect(norm('(( SELECT auth.uid() AS uid) = owner_id)')).toEqual(atom({ op: 'eq', left: 'actor.uid', right: 'resource.owner_id' }))
    expect(norm("((auth.uid())::text = 'x'::text)")).toEqual(atom({ op: 'eq', left: 'actor.uid', right: { literal: 'x' } }))
    expect(norm("((auth.jwt() ->> 'user_role'::text) = 'admin'::text)"))
      .toEqual(atom({ op: 'eq', left: 'actor.claim.user_role', right: { literal: 'admin' } }))
    expect(norm("(((auth.jwt() -> 'app_metadata'::text) ->> 'tier'::text) = 'gold'::text)"))
      .toEqual(atom({ op: 'eq', left: 'actor.claim.app_metadata.tier', right: { literal: 'gold' } }))
    expect(norm("(auth.role() = 'authenticated'::text)")).toEqual(atom({ op: 'eq', left: 'actor.role', right: { literal: 'authenticated' } }))
  })
  it('maps the policy table columns to the stored or incoming record', () => {
    expect(norm("(projects.status = 'a'::text)")).toEqual(atom({ op: 'eq', left: 'resource.status', right: { literal: 'a' } }))
    expect(norm("(public.projects.status = 'a'::text)", 'incoming')).toEqual(atom({ op: 'eq', left: 'incoming.status', right: { literal: 'a' } }))
  })
  it('leaves auth functions alone for the plain dialect', () => {
    expect(norm('(owner_id = auth.uid())', 'resource', false)).toEqual({ opaque: 'owner_id = auth.uid()' })
  })
  it('makes unknown columns, other casts and other functions opaque', () => {
    expect(norm("(nosuch = 'a'::text)")).toEqual({ opaque: "nosuch = 'a'::text" })
    expect(norm("((owner_id)::text = 'a'::text)")).toEqual({ opaque: "(owner_id)::text = 'a'::text" })
    expect(norm("(lower(status) = 'a'::text)")).toEqual({ opaque: "lower(status) = 'a'::text" })
  })
})

describe('normalizeCondition: comparisons and structure', () => {
  it('maps =, <>, <, > and leaves other operators opaque', () => {
    expect(norm("(status <> 'a'::text)")).toEqual(atom({ op: 'ne', left: 'resource.status', right: { literal: 'a' } }))
    expect(norm('(n < 3)')).toEqual(atom({ op: 'lt', left: 'resource.n', right: { literal: 3 } }))
    expect(norm('(n > 3)')).toEqual(atom({ op: 'gt', left: 'resource.n', right: { literal: 3 } }))
    expect(norm('(n >= 3)')).toEqual({ opaque: 'n >= 3' })
  })
  it('maps IN lists and = ANY (ARRAY[...]) to in', () => {
    const want = atom({ op: 'in', left: 'resource.status', right: { literal: ['a', 'b'] } })
    expect(norm("(status = ANY (ARRAY['a'::text, 'b'::text]))")).toEqual(want)
    expect(norm("status IN ('a', 'b')")).toEqual(want)
    expect(norm("status NOT IN ('a', 'b')")).toEqual({ opaque: "status NOT IN ('a', 'b')" })
    expect(norm('(status = ANY (ARRAY[owner_id]))')).toEqual({ opaque: 'status = ANY (ARRAY[owner_id])' })
  })
  it('maps null tests, with auth.uid() as sign-in', () => {
    expect(norm('(deleted_at IS NULL)')).toEqual(atom({ op: 'isNull', operand: 'resource.deleted_at' }))
    expect(norm('(deleted_at IS NOT NULL)')).toEqual({ not: atom({ op: 'isNull', operand: 'resource.deleted_at' }) })
    expect(norm('(auth.uid() IS NOT NULL)')).toEqual(AUTH)
    expect(norm('(auth.uid() IS NULL)')).toEqual({ not: AUTH })
    expect(norm("((auth.jwt() ->> 'k'::text) IS NULL)")).toHaveProperty('opaque')
  })
  it('maps AND, OR, NOT, true and false', () => {
    expect(norm("((status = 'a'::text) AND (NOT (n < 3)))")).toEqual({ and: [
      atom({ op: 'eq', left: 'resource.status', right: { literal: 'a' } }),
      { not: atom({ op: 'lt', left: 'resource.n', right: { literal: 3 } }) },
    ] })
    expect((norm("((status = 'a'::text) OR (n > 3))") as { or: unknown[] }).or).toHaveLength(2)
    expect(norm('true')).toEqual({ and: [] })
    expect(norm('false')).toEqual({ or: [] })
  })
  it('treats the anon role as not signed in', () => {
    expect(norm("(auth.role() = 'anon'::text)")).toEqual({ not: AUTH })
    expect(norm("((auth.jwt() ->> 'role'::text) = 'anon'::text)")).toEqual({ not: AUTH })
    expect(norm("(auth.role() <> 'anon'::text)")).toEqual({ opaque: "auth.role() <> 'anon'::text" })
  })
  it('makes subqueries and helper calls opaque until they are supported', () => {
    expect(norm('is_member(org_id)')).toEqual({ opaque: 'is_member(org_id)' })
  })
})
