import type { PGlite } from '@electric-sql/pglite'
import type { TestCase, TestFile } from '@holdline/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applyMigrations } from '../src/migrations.js'
import { prepareRoles } from '../src/pg-actor.js'
import { runPostgresFile } from '../src/pg-runner.js'
import { project, SLOW } from './helpers.js'

const SCHEMA = `
create table public.orgs (id uuid primary key, name text not null);
create table public.memberships (org_id uuid not null references public.orgs(id), user_id uuid not null,
  role text not null check (role in ('owner', 'admin', 'member')), primary key (org_id, user_id));
create table public.projects (id uuid primary key default gen_random_uuid(), org_id uuid not null references public.orgs(id),
  owner_id uuid not null, title text not null, amount int not null check (amount > 0));
alter table public.projects enable row level security;
create policy read_members on public.projects for select using (
  exists (select 1 from public.memberships m where m.org_id = projects.org_id and m.user_id = auth.uid()));
create policy update_owner on public.projects for update using (owner_id = auth.uid());
create policy insert_owner on public.projects for insert with check (owner_id = auth.uid());
create policy delete_owner on public.projects for delete using (owner_id = auth.uid());
create table public.notes (id bigint generated always as identity primary key, owner_id uuid not null,
  locked boolean not null default false, body text);
alter table public.notes enable row level security;
create policy notes_read on public.notes for select using (owner_id = auth.uid());
create policy notes_update on public.notes for update using (owner_id = auth.uid()) with check (not locked);
create policy notes_delete on public.notes for delete using (owner_id = auth.uid());
`

const actor = { uid: 'user-1', claims: {} }
const other = { uid: 'user-2', claims: {} }
const projectRow = { org_id: 'org-1' }
const record = (data: Record<string, unknown> = projectRow) => ({ path: 'public.projects', data })
const member = { path: 'public.memberships', data: { org_id: 'org-1', user_id: 'user-1' } }

function file(cases: TestCase[]): TestFile {
  return { rule: 'r', generatedFrom: 'h', store: 'postgres', cases, skipped: [] }
}
function tc(name: string, c: Omit<TestCase, 'name' | 'seed'> & { seed?: TestCase['seed'] }): TestCase {
  return { name, seed: [], ...c }
}
function outcomes(results: { name: string; actual: string; passed: boolean; detail?: string }[]) {
  return Object.fromEntries(results.map(r => [r.name, r.passed ? r.actual : `${r.actual} (${r.detail})`]))
}

describe('runPostgresFile (supabase)', () => {
  let db: PGlite
  beforeAll(async () => {
    const r = await applyMigrations(await project({ 'supabase/migrations/1.sql': SCHEMA }), {})
    expect(r.error).toBeUndefined()
    db = r.db
    await prepareRoles(db, 'supabase')
  }, SLOW)
  afterAll(async () => { await db?.close() })

  const read = { op: 'read' as const, path: 'public.projects' }

  it('read: allow with membership, deny without, deny anonymous', async () => {
    const results = await runPostgresFile(db, file([
      tc('member', { as: actor, seed: [record(), member], do: read, expect: 'allow' }),
      tc('non-member', { as: actor, seed: [record()], do: read, expect: 'deny' }),
      tc('anonymous', { as: null, seed: [record(), member], do: read, expect: 'deny' }),
    ]), 'access', 'supabase')
    expect(outcomes(results)).toEqual({ member: 'allow', 'non-member': 'deny', anonymous: 'deny' })
  }, SLOW)

  // A data-access rule is per op: the UPDATE/DELETE policies are tested without the member-read SELECT policy.
  it('update/delete: owner allowed without a membership, other user denied', async () => {
    const owned = record({ ...projectRow, owner_id: 'user-1' })
    const update = { op: 'update' as const, path: 'public.projects', data: { title: 'y' } }
    const touch = { op: 'update' as const, path: 'public.projects' }
    const del = { op: 'delete' as const, path: 'public.projects' }
    const results = await runPostgresFile(db, file([
      tc('owner updates', { as: actor, seed: [owned], do: update, expect: 'allow' }),
      tc('owner updates nothing', { as: actor, seed: [owned], do: touch, expect: 'allow' }),
      tc('other updates', { as: other, seed: [owned], do: update, expect: 'deny' }),
      tc('owner deletes', { as: actor, seed: [owned], do: del, expect: 'allow' }),
      tc('other deletes', { as: other, seed: [owned], do: del, expect: 'deny' }),
    ]), 'access', 'supabase')
    expect(outcomes(results)).toEqual({
      'owner updates': 'allow', 'owner updates nothing': 'allow', 'other updates': 'deny', 'owner deletes': 'allow', 'other deletes': 'deny',
    })
  }, SLOW)

  it('update/delete: the record is checked, not any row the actor owns', async () => {
    const notMine = record({ ...projectRow, owner_id: 'user-2' })
    const mine = record({ ...projectRow, owner_id: 'user-1' })
    const results = await runPostgresFile(db, file([
      tc('update', { as: actor, seed: [notMine, mine], do: { op: 'update', path: 'public.projects', data: { title: 'y' } }, expect: 'deny' }),
      tc('delete', { as: actor, seed: [notMine, mine], do: { op: 'delete', path: 'public.projects' }, expect: 'deny' }),
    ]), 'access', 'supabase')
    expect(outcomes(results)).toEqual({ update: 'deny', delete: 'deny' })
  }, SLOW)

  it('finds a record whose key the database generated', async () => {
    const note = { path: 'public.notes', data: { owner_id: 'user-1' } }
    const results = await runPostgresFile(db, file([
      tc('owner reads', { as: actor, seed: [note], do: { op: 'read', path: 'public.notes' }, expect: 'allow' }),
      tc('owner updates', { as: actor, seed: [note], do: { op: 'update', path: 'public.notes', data: { body: 'y' } }, expect: 'allow' }),
      tc('owner deletes', { as: actor, seed: [note], do: { op: 'delete', path: 'public.notes' }, expect: 'allow' }),
      tc('other deletes', { as: other, seed: [note], do: { op: 'delete', path: 'public.notes' }, expect: 'deny' }),
    ]), 'access', 'supabase')
    expect(outcomes(results)).toEqual({ 'owner reads': 'allow', 'owner updates': 'allow', 'owner deletes': 'allow', 'other deletes': 'deny' })
  }, SLOW)

  it('a refused update with several rows of the table seeded is an error, not a deny', async () => {
    // The locked row fails the WITH CHECK, though the record itself is updatable: the statement cannot say which.
    const [r] = await runPostgresFile(db, file([tc('ambiguous', {
      as: actor,
      seed: [{ path: 'public.notes', data: { owner_id: 'user-1' } }, { path: 'public.notes', data: { owner_id: 'user-1', locked: true } }],
      do: { op: 'update', path: 'public.notes', data: { body: 'y' } },
      expect: 'deny',
    })]), 'access', 'supabase')
    expect(r!.actual).toBe('error')
    expect(r!.passed).toBe(false)
    expect(r!.detail).toMatch(/cannot tell which public\.notes row the policy rejected \(the case seeds 2 rows of public\.notes\)/)
  }, SLOW)

  it('PGlite: RESET ROLE leaves SET LOCAL ROLE, and an identical update moves the ctid', async () => {
    await db.transaction(async tx => {
      await tx.exec(`insert into public.orgs (id, name) values ('11111111-1111-4111-8111-111111111111', 'a')`)
      const ctid = async () => (await tx.query<{ c: string }>(`select ctid::text as c from public.orgs`)).rows[0]!.c
      const before = await ctid()
      await tx.exec('set local role authenticated')
      expect((await tx.query<{ u: string }>('select current_user as u')).rows[0]!.u).toBe('authenticated')
      await tx.query(`update public.orgs set name = $1`, ['a'])
      await tx.exec('reset role')
      expect((await tx.query<{ u: string }>('select current_user as u')).rows[0]!.u).toBe('postgres')
      expect(await ctid()).not.toBe(before)
      await tx.rollback()
    })
  }, SLOW)

  it('create: allowed for own owner_id, RLS violation is deny', async () => {
    const results = await runPostgresFile(db, file([
      tc('own', { as: actor, do: { op: 'create', path: 'public.projects', data: { owner_id: 'user-1', org_id: 'org-1' } }, expect: 'allow' }),
      tc('foreign', { as: actor, do: { op: 'create', path: 'public.projects', data: { owner_id: 'user-2', org_id: 'org-1' } }, expect: 'deny' }),
    ]), 'access', 'supabase')
    expect(outcomes(results)).toEqual({ own: 'allow', foreign: 'deny' })
  }, SLOW)

  it('list: allowed when a seeded row is visible', async () => {
    const list = { op: 'list' as const, path: 'public.projects' }
    const results = await runPostgresFile(db, file([
      tc('visible', { as: actor, seed: [record(), member], do: list, expect: 'allow' }),
      tc('hidden', { as: actor, seed: [record()], do: list, expect: 'deny' }),
    ]), 'access', 'supabase')
    expect(outcomes(results)).toEqual({ visible: 'allow', hidden: 'deny' })
  }, SLOW)

  it('maps claims to the uuid their value got in the same case', async () => {
    // auth.jwt() ->> 'org' must equal the org_id the seed row got, so the claim and the row agree.
    await db.exec(`create policy read_claim on public.orgs for select using (id = (auth.jwt() ->> 'org')::uuid);
      alter table public.orgs enable row level security;`)
    try {
      const results = await runPostgresFile(db, file([
        tc('claim', { as: { uid: 'user-1', claims: { org: 'org-1' } }, seed: [{ path: 'public.orgs', data: { id: 'org-1' } }], do: { op: 'read', path: 'public.orgs' }, expect: 'allow' }),
      ]), 'access', 'supabase')
      expect(outcomes(results)).toEqual({ claim: 'allow' })
    } finally {
      await db.exec('alter table public.orgs disable row level security; drop policy read_claim on public.orgs;')
    }
  }, SLOW)

  it('reports a wrong expectation as a failed case', async () => {
    const [r] = await runPostgresFile(db, file([tc('non-member', { as: actor, seed: [record()], do: read, expect: 'allow' })]), 'access', 'supabase')
    expect(r).toEqual({ name: 'non-member', expect: 'allow', actual: 'deny', passed: false, detail: 'expected allow, got deny' })
  }, SLOW)

  it('invariant: valid row inserts, null and missing fk and bad check are rejected', async () => {
    const org = { path: 'public.orgs', data: { id: 'org-1' } }
    const create = (data: Record<string, unknown>) => ({ op: 'create' as const, path: 'public.projects', data })
    const results = await runPostgresFile(db, file([
      tc('valid', { as: null, seed: [org], do: create({ org_id: 'org-1', owner_id: 'user-1', title: 'x' }), expect: 'allow' }),
      tc('null fk', { as: null, seed: [org], do: create({ org_id: null, owner_id: 'user-1', title: 'x' }), expect: 'reject' }),
      tc('missing fk', { as: null, seed: [org], do: create({ org_id: 'missing-1', owner_id: 'user-1', title: 'x' }), expect: 'reject' }),
      tc('bad check', { as: null, seed: [org], do: { op: 'create', path: 'public.memberships', data: { org_id: 'org-1', user_id: 'u', role: 'bogus' } }, expect: 'reject' }),
      tc('duplicate', {
        as: null,
        seed: [org, { path: 'public.memberships', data: { org_id: 'org-1', user_id: 'u' } }],
        do: { op: 'create', path: 'public.memberships', data: { org_id: 'org-1', user_id: 'u' } },
        expect: 'reject',
      }),
    ]), 'invariant', 'supabase')
    expect(outcomes(results)).toEqual({ valid: 'allow', 'null fk': 'reject', 'missing fk': 'reject', 'bad check': 'reject', duplicate: 'reject' })
  }, SLOW)

  it('invariant update keeps a WHERE on the record, so other seeded rows do not blur the outcome', async () => {
    const org = { path: 'public.orgs', data: { id: 'org-1' } }
    const m = (user_id: string) => ({ path: 'public.memberships', data: { org_id: 'org-1', user_id } })
    const update = (role: string) => ({ op: 'update' as const, path: 'public.memberships', data: { role } })
    const results = await runPostgresFile(db, file([
      tc('valid', { as: null, seed: [org, m('u'), m('v')], do: update('admin'), expect: 'allow' }),
      tc('bad check', { as: null, seed: [org, m('u'), m('v')], do: update('bogus'), expect: 'reject' }),
    ]), 'invariant', 'supabase')
    expect(outcomes(results)).toEqual({ valid: 'allow', 'bad check': 'reject' })
  }, SLOW)

  it('a seed with an unknown column is an error, not a pass', async () => {
    const [r] = await runPostgresFile(db, file([tc('bad seed', { as: actor, seed: [record({ nope: 1 })], do: read, expect: 'deny' })]), 'access', 'supabase')
    expect(r!.actual).toBe('error')
    expect(r!.passed).toBe(false)
    expect(r!.detail).toMatch(/seed public\.projects failed: column nope does not exist on public\.projects/)
  }, SLOW)

  it('read with no record seed is an error', async () => {
    const [r] = await runPostgresFile(db, file([tc('no record', { as: actor, seed: [member], do: read, expect: 'deny' })]), 'access', 'supabase')
    expect(r!.actual).toBe('error')
    expect(r!.passed).toBe(false)
  }, SLOW)

  it('leaves nothing behind between cases', async () => {
    await runPostgresFile(db, file([tc('member', { as: actor, seed: [record(), member], do: read, expect: 'allow' })]), 'access', 'supabase')
    const n = await db.query<{ n: number }>('select count(*)::int as n from public.projects')
    expect(n.rows[0]!.n).toBe(0)
  }, SLOW)
})

describe('runPostgresFile (plain)', () => {
  it('plain dialect acts as holdline_actor', async () => {
    const r = await applyMigrations(await project({ 'migrations/1.sql': 'create table things (id int primary key, name text not null); create table secrets (id int primary key);' }), {})
    expect(r.error).toBeUndefined()
    await prepareRoles(r.db, 'plain')
    // Not a superuser: a table the actor role has no privilege on is denied.
    await r.db.exec('revoke all on public.secrets from holdline_actor')
    try {
      const results = await runPostgresFile(r.db, file([
        tc('read', { as: actor, seed: [{ path: 'public.things', data: {} }], do: { op: 'read', path: 'public.things' }, expect: 'allow' }),
        tc('anonymous read', { as: null, seed: [{ path: 'public.things', data: {} }], do: { op: 'read', path: 'public.things' }, expect: 'allow' }),
        tc('no privilege', { as: actor, seed: [{ path: 'public.secrets', data: {} }], do: { op: 'read', path: 'public.secrets' }, expect: 'deny' }),
      ]), 'access', 'plain')
      expect(outcomes(results)).toEqual({ read: 'allow', 'anonymous read': 'allow', 'no privilege': 'deny' })
    } finally {
      await r.db.close()
    }
  }, SLOW)
})
