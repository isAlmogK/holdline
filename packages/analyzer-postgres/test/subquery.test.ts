import { beforeAll, describe, expect, it } from 'vitest'
import type { CatalogIndex, SqlFunction } from '../src/catalog.js'
import { normalizeCondition } from '../src/normalize.js'
import { loadSqlParser, type SqlParse } from '../src/pgparse.js'
import type { Side } from '../src/scope.js'

let parse: SqlParse
beforeAll(async () => { parse = await loadSqlParser() })

const fn = (name: string, argNames: string[], body: string, over: Partial<SqlFunction> = {}): [string, SqlFunction] =>
  [`public.${name}/${argNames.length}`, { schema: 'public', name, argNames, language: 'sql', volatility: 's', body, ...over }]

const catalog: CatalogIndex = {
  relations: new Map([
    ['public.projects', new Set(['id', 'org_id', 'owner_id', 'status'])],
    ['public.memberships', new Set(['org_id', 'user_id', 'role'])],
  ]),
  functions: new Map([
    fn('is_member', ['o'], ' select exists (select 1 from public.memberships m where m.org_id = o and m.user_id = (select auth.uid())) '),
    // one unnamed argument, read as $1
    ['public.is_member_pos/1', { schema: 'public', name: 'is_member_pos', argNames: [], language: 'sql', volatility: 's',
      body: ' select exists (select 1 from memberships where org_id = $1 and user_id = auth.uid()) ' }],
    fn('is_owner', ['p'], ' select p = auth.uid() '),
    fn('calls_member', ['o'], ' select public.is_member(o) '),
    fn('volatile_member', ['o'], ' select true ', { volatility: 'v' }),
    fn('plpgsql_member', ['o'], ' begin return true; end ', { language: 'plpgsql' }),
    fn('two_statements', ['o'], ' select 1; select true '),
    fn('loop', ['o'], ' select public.loop(o) '),
  ]),
}

const run = (sql: string, side: Side = 'resource') => normalizeCondition(sql, { table: 'public.projects', side, catalog, parse, supabase: true })
const norm = (sql: string, side: Side = 'resource') => run(sql, side).expr
const exists = (doc: string) => ({ atom: { op: 'exists', doc } })
const MEMBER = exists('pg:public.memberships?org_id={resource.org_id}&user_id={actor.uid}')

describe('EXISTS subqueries', () => {
  it('maps equality conjuncts to a canonical exists doc', () => {
    expect(norm('(EXISTS ( SELECT 1 FROM memberships m WHERE ((m.user_id = auth.uid()) AND (m.org_id = projects.org_id))))')).toEqual(MEMBER)
    expect(norm('(EXISTS ( SELECT 1 FROM memberships WHERE ((projects.org_id = memberships.org_id) AND (memberships.user_id = auth.uid()))))')).toEqual(MEMBER)
    expect(norm('(EXISTS ( SELECT 1 FROM memberships m WHERE ((m.org_id = projects.org_id) AND (m.user_id = auth.uid()))))', 'incoming'))
      .toEqual(exists('pg:public.memberships?org_id={incoming.org_id}&user_id={actor.uid}'))
  })
  it('resolves an unqualified column to the subquery table first, as SQL does', () => {
    // org_id exists in both tables: inside the subquery it is memberships.org_id, so this compares two inner columns.
    expect(norm('(EXISTS ( SELECT 1 FROM memberships WHERE (org_id = owner_id)))')).toEqual(exists('pg:public.memberships?org_id={resource.owner_id}'))
    expect(norm('(EXISTS ( SELECT 1 FROM memberships WHERE (org_id = user_id)))')).toHaveProperty('opaque')
  })
  it('is opaque for anything but equality conjuncts with operands', () => {
    for (const sql of [
      "(EXISTS ( SELECT 1 FROM memberships m WHERE ((m.org_id = projects.org_id) AND (m.role = 'admin'::text))))",
      '(EXISTS ( SELECT 1 FROM memberships m WHERE ((m.org_id = projects.org_id) OR (m.user_id = auth.uid()))))',
      '(EXISTS ( SELECT 1 FROM memberships m))',
      '(EXISTS ( SELECT 1 FROM memberships m, projects p WHERE (m.org_id = p.org_id)))',
      '(EXISTS ( SELECT 1 FROM nosuch n WHERE (n.org_id = projects.org_id)))',
      '(EXISTS ( SELECT 1 FROM memberships m WHERE ((m.org_id = projects.org_id) AND (m.org_id = projects.owner_id))))',
    ]) expect(norm(sql), sql).toHaveProperty('opaque')
  })
  it('keeps NOT EXISTS as not(exists)', () => {
    expect(norm('(NOT (EXISTS ( SELECT 1 FROM memberships m WHERE ((m.org_id = projects.org_id) AND (m.user_id = auth.uid())))))')).toEqual({ not: MEMBER })
  })
})

describe('IN subqueries', () => {
  it('maps x IN (SELECT t.a FROM t WHERE …) to exists with a={x}', () => {
    expect(norm('(org_id IN ( SELECT memberships.org_id FROM memberships WHERE (memberships.user_id = auth.uid())))')).toEqual(MEMBER)
    expect(norm('(org_id IN ( SELECT m.org_id FROM memberships m WHERE (m.user_id = ( SELECT auth.uid() AS uid))))')).toEqual(MEMBER)
  })
  it('is opaque with a non-column target or a filter it cannot express', () => {
    expect(norm('(org_id IN ( SELECT lower(m.role) FROM memberships m WHERE (m.user_id = auth.uid())))')).toHaveProperty('opaque')
    expect(norm("(org_id IN ( SELECT m.org_id FROM memberships m WHERE ((m.user_id = auth.uid()) AND (m.role = ANY (ARRAY['admin'::text])))))")).toHaveProperty('opaque')
  })
})

describe('helper functions', () => {
  it('inlines a stable SQL function by parameter name and records it', () => {
    expect(run('is_member(org_id)')).toEqual({ expr: MEMBER, functions: ['public.is_member'] })
    expect(norm('public.is_member(org_id)', 'incoming')).toEqual(exists('pg:public.memberships?org_id={incoming.org_id}&user_id={actor.uid}'))
  })
  it('inlines by position and through nested calls', () => {
    expect(norm('is_member_pos(org_id)')).toEqual(MEMBER)
    expect(run('calls_member(org_id)')).toEqual({ expr: MEMBER, functions: ['public.calls_member', 'public.is_member'] })
    expect(norm('is_owner(owner_id)')).toEqual({ atom: { op: 'eq', left: 'resource.owner_id', right: 'actor.uid' } })
  })
  it('does not inline volatile, non-SQL, multi-statement, unknown or runaway functions', () => {
    for (const sql of ['volatile_member(org_id)', 'plpgsql_member(org_id)', 'two_statements(org_id)', 'nosuch(org_id)', 'loop(org_id)', 'is_member(lower(status))']) {
      expect(norm(sql), sql).toHaveProperty('opaque')
    }
  })
})
