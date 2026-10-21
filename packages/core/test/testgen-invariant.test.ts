import { describe, expect, it } from 'vitest'
import { parseFacts } from '../src/facts.js'
import { hashRule } from '../src/hash.js'
import { RuleSchema } from '../src/rules.js'
import { generateTests } from '../src/testgen.js'

const vocab = new Map()
const rule = (raw: Record<string, unknown>) => RuleSchema.parse({ id: 'R-010', text: 't', status: 'approved', ...raw })
const facts = parseFacts({
  version: 1,
  tables: [
    { id: 'pg:public.orgs', name: 'public.orgs', columns: [
      { name: 'id', type: 'uuid', nullable: false }, { name: 'name', type: 'text', nullable: false },
    ], primaryKey: ['id'] },
    { id: 'pg:public.projects', name: 'public.projects', columns: [
      { name: 'id', type: 'uuid', nullable: false, default: 'gen_random_uuid()' },
      { name: 'org_id', type: 'uuid', nullable: false },
      { name: 'title', type: 'text', nullable: false },
      { name: 'status', type: 'text', nullable: false },
      { name: 'note', type: 'text', nullable: true },
    ], primaryKey: ['id'],
      foreignKeys: [{ columns: ['org_id'], references: { table: 'public.orgs', columns: ['id'] } }],
      checks: [{ expr: "(status = ANY (ARRAY['active'::text, 'archived'::text]))" }] },
    { id: 'pg:public.memberships', name: 'public.memberships', columns: [
      { name: 'org_id', type: 'uuid', nullable: false }, { name: 'user_id', type: 'uuid', nullable: false },
      { name: 'role', type: 'member_role', nullable: false },
    ], primaryKey: ['org_id', 'user_id'], uniques: [['org_id', 'user_id']],
      foreignKeys: [{ columns: ['org_id'], references: { table: 'public.orgs', columns: ['id'] } }],
      enums: [{ column: 'role', values: ['owner', 'admin', 'member'] }] },
  ],
})
const parents = [{ path: 'public.orgs', data: { id: 'org_id-1' } }]
const validProject = { org_id: 'org_id-1', title: 'x', status: 'active' }

describe('postgres invariant tests', () => {
  it('not-null: a valid row inserts, a null is rejected', () => {
    const r = rule({ type: 'invariant', target: { store: 'postgres', table: 'projects' }, kind: 'not-null', columns: ['org_id'] })
    const f = generateTests(r, vocab, facts)!
    expect(f.generatedFrom).toBe(hashRule(r, vocab))
    expect(f.store).toBe('postgres')
    expect(f.cases).toEqual([
      { name: 'create: a complete valid row inserts', as: null, seed: parents,
        do: { op: 'create', path: 'public.projects', data: validProject }, expect: 'allow' },
      { name: 'create: rejects org_id null', as: null, seed: parents,
        do: { op: 'create', path: 'public.projects', data: { ...validProject, org_id: null } }, expect: 'reject' },
    ])
    expect(f.skipped).toEqual([])
  })
  it('fk: a value with no referenced row is rejected', () => {
    const r = rule({ type: 'invariant', target: { store: 'postgres', table: 'public.projects' }, kind: 'fk', columns: ['org_id'],
      references: { table: 'orgs', columns: ['id'] } })
    expect(generateTests(r, vocab, facts)!.cases[1]).toEqual({
      name: 'create: rejects org_id with no matching public.orgs row', as: null, seed: parents,
      do: { op: 'create', path: 'public.projects', data: { ...validProject, org_id: 'missing-1' } }, expect: 'reject' })
  })
  it('unique: a second row with the same values is rejected', () => {
    const r = rule({ type: 'invariant', target: { store: 'postgres', table: 'memberships' }, kind: 'unique', columns: ['org_id', 'user_id'] })
    const row = { org_id: 'org_id-1', user_id: 'filler', role: 'owner' }
    expect(generateTests(r, vocab, facts)!.cases[1]).toEqual({
      name: 'create: rejects a second row with the same org_id, user_id', as: null,
      seed: [...parents, { path: 'public.memberships', data: row }],
      do: { op: 'create', path: 'public.memberships', data: row }, expect: 'reject' })
  })
  it('enum: the rule values give the valid row, an unknown value is rejected', () => {
    const r = rule({ type: 'invariant', target: { store: 'postgres', table: 'memberships' }, kind: 'enum', columns: ['role'],
      values: ['member', 'owner', 'admin'] })
    const cases = generateTests(r, vocab, facts)!.cases
    // user_id is a primary-key column the rule does not name and not a foreign key: the runner gives it a key.
    expect(cases[0]!.do.data).toEqual({ org_id: 'org_id-1', role: 'member' })
    expect(cases[1]!.do.data!.role).toBe('__holdline_invalid__')
    expect(cases[1]!.name).toBe("create: rejects role '__holdline_invalid__'")
  })
  it('check: skipped', () => {
    const r = rule({ type: 'invariant', target: { store: 'postgres', table: 'projects' }, kind: 'check', columns: ['title'], expr: 'length(title) > 0' })
    expect(generateTests(r, vocab, facts)).toMatchObject({ cases: [], skipped: ['check expressions are tested statically only'] })
  })
  it('skips without facts for the table', () => {
    const r = rule({ type: 'invariant', target: { store: 'postgres', table: 'nope' }, kind: 'not-null', columns: ['a'] })
    expect(generateTests(r, vocab, facts)!.skipped).toEqual(['table public.nope is not in the facts; run holdline scan, then holdline test --regenerate'])
    expect(generateTests(r, vocab)!.skipped).toEqual(['table public.nope is not in the facts; run holdline scan, then holdline test --regenerate'])
  })
  it('skips storage invariants', () => {
    const r = rule({ type: 'invariant', target: { store: 'storage', path: '/f/{id}' }, kind: 'not-null', columns: ['a'] })
    expect(generateTests(r, vocab, facts)!.skipped).toEqual(['storage invariants are not generated; check them statically'])
  })
  it('still returns undefined for other non data-access rules', () => {
    expect(generateTests(rule({ type: 'access', target: { routes: 'GET /x' }, requires: { atom: { op: 'authenticated' } } }), vocab, facts)).toBeUndefined()
  })
})

describe('firestore invariant tests', () => {
  const condition = { and: [
    { atom: { op: 'authenticated' } },
    { atom: { op: 'in', left: 'incoming.orgId', right: 'doc(/users/{actor.uid}).orgIds' } },
    { atom: { op: 'in', left: 'incoming.status', right: { literal: ['active', 'archived'] } } },
  ] }
  const fsFacts = parseFacts({ version: 1, policies: [
    { id: 'firestore:/projects/{projectId}#create@5', store: 'firestore', target: '/projects/{projectId}', ops: ['create'], condition },
  ] })
  const users = { path: '/users/user-1', data: { orgIds: ['value-1'] } }

  it('enum: allowed with a listed value, denied with another', () => {
    const r = rule({ type: 'invariant', target: { store: 'firestore', path: '/projects/{id}' }, kind: 'enum', columns: ['status'], values: ['active', 'archived'] })
    const f = generateTests(r, vocab, fsFacts)!
    expect(f.cases).toEqual([
      { name: 'create: allowed with a valid status', as: { uid: 'user-1', claims: {} }, seed: [users],
        do: { op: 'create', path: '/projects/id-1', data: { orgId: 'value-1', status: 'active' } }, expect: 'allow' },
      { name: "create: denied with status '__holdline_invalid__'", as: { uid: 'user-1', claims: {} }, seed: [users],
        do: { op: 'create', path: '/projects/id-1', data: { orgId: 'value-1', status: '__holdline_invalid__' } }, expect: 'deny' },
    ])
  })
  it('not-null: denied without the field', () => {
    const r = rule({ type: 'invariant', target: { store: 'firestore', path: '/projects/{id}' }, kind: 'not-null', columns: ['orgId'] })
    const f = generateTests(r, vocab, fsFacts)!
    expect(f.cases.map(c => [c.name, c.do.data, c.expect])).toEqual([
      ['create: allowed with orgId set', { orgId: 'value-1', status: 'active' }, 'allow'],
      ['create: denied without orgId', { status: 'active' }, 'deny'],
    ])
  })
  it('skips without a usable create policy', () => {
    const r = rule({ type: 'invariant', target: { store: 'firestore', path: '/other/{id}' }, kind: 'not-null', columns: ['a'] })
    expect(generateTests(r, vocab, fsFacts)!.skipped).toEqual(['create: no create policy for /other/{id} in the facts that cases can be generated for'])
  })
  const withSecond = (cond: unknown) => parseFacts({ version: 1, policies: [
    { id: 'firestore:/projects/{projectId}#create@5', store: 'firestore', target: '/projects/{projectId}', ops: ['create'], condition },
    { id: 'firestore:/projects/{projectId}#create@9', store: 'firestore', target: '/projects/{projectId}', ops: ['create'], condition: cond },
  ] })
  const nn = rule({ type: 'invariant', target: { store: 'firestore', path: '/projects/{id}' }, kind: 'not-null', columns: ['orgId'] })

  it('skips the deny case when another create policy allows it', () => {
    const f = generateTests(nn, vocab, withSecond({ and: [{ atom: { op: 'authenticated' } }] }))!
    expect(f.cases.map(c => c.expect)).toEqual(['allow'])
    expect(f.skipped).toEqual(['create: cannot deny only orgId (another create policy allows it: firestore:/projects/{projectId}#create@9)'])
  })
  it('skips the deny case when another create policy cannot be evaluated', () => {
    const f = generateTests(nn, vocab, withSecond({ opaque: 'custom()' }))!
    expect(f.cases.map(c => c.expect)).toEqual(['allow'])
    expect(f.skipped).toEqual(['create: cannot deny only orgId (create policy firestore:/projects/{projectId}#create@9 cannot be evaluated)'])
  })
  it('keeps the deny case when another create policy needs something the denied write lacks', () => {
    const f = generateTests(nn, vocab, withSecond({ and: [{ atom: { op: 'eq', left: 'actor.claim.admin', right: { literal: true } } }] }))!
    expect(f.cases.map(c => c.expect)).toEqual(['allow', 'deny'])
    expect(f.skipped).toEqual([])
  })
})
