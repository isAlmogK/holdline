import type { Policy } from '@holdline/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { analyzeMigrations, factsFromDatabase } from '../src/facts.js'
import { runMigrations, type MigrationRun } from '../src/migrate.js'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

// pg_get_expr prints names relative to the session search_path, which a migration can change.
// The policy below means app.members and app.is_member; public has look-alikes that must not be used.
const SCHEMA = `
create schema app;
create table public.members (org_id uuid, user_id uuid);
create table app.members (org_id uuid, user_id uuid);
create table public.docs (id uuid primary key, org_id uuid);
alter table public.docs enable row level security;
create function public.is_member(o uuid) returns boolean language sql stable as $$ select true $$;
create function app.is_member(o uuid) returns boolean language sql stable
  as $$ select exists (select 1 from app.members where org_id = o and user_id = auth.uid()) $$;
`
const POLICIES = `
create policy via_exists on public.docs for select
  using (exists (select 1 from members m where m.org_id = docs.org_id and m.user_id = auth.uid()));
create policy via_helper on public.docs for delete using (is_member(org_id));
`
const APP_MEMBER = { atom: { op: 'exists', doc: 'pg:app.members?org_id={resource.org_id}&user_id={actor.uid}' } }
const AUTH = { atom: { op: 'authenticated' } }

function conditions(policies: readonly Policy[]) {
  return Object.fromEntries(policies.filter(p => p.ops[0] !== 'list').map(p => [p.id.split(':').at(-1), { condition: p.condition, functions: p.functions }]))
}
const WANT = {
  via_exists: { condition: { and: [AUTH, APP_MEMBER] }, functions: [] },
  via_helper: { condition: { and: [AUTH, APP_MEMBER] }, functions: ['app.is_member'] },
}

let run: MigrationRun | undefined
afterEach(async () => { await run?.db.close(); run = undefined })

describe('search_path set by a migration', () => {
  it('names the schema the policy means after a session-level SET search_path', async () => {
    const out = await analyzeMigrations([
      { path: '1.sql', sql: SCHEMA },
      { path: '2.sql', sql: `set search_path = app, public;\n${POLICIES}` },
    ], 'supabase')
    expect(out.diagnostics ?? []).toEqual([])
    expect(conditions(out.policies as Policy[])).toEqual(WANT)
  })

  it('names the schema the policy means after a pg_dump-style set_config', async () => {
    const out = await analyzeMigrations([
      { path: '1.sql', sql: SCHEMA },
      { path: '2.sql', sql: `select pg_catalog.set_config('search_path', '', false);\nset search_path = app, public;\n${POLICIES}` },
    ], 'supabase')
    expect(conditions(out.policies as Policy[])).toEqual(WANT)
  })

  it('restores the dialect search_path after every migration', async () => {
    run = await runMigrations([{ path: '1.sql', sql: "select pg_catalog.set_config('search_path', '', false);" }], 'supabase')
    expect((await run.db.query<{ search_path: string }>('show search_path')).rows[0]!.search_path).toBe('"$user", public, extensions')
    await run.db.close()
    run = await runMigrations([{ path: '1.sql', sql: 'create schema app; set search_path = app;' }], 'plain')
    expect((await run.db.query<{ search_path: string }>('show search_path')).rows[0]!.search_path).toBe('public')
  })

  it('lets a later migration see the dialect search_path again', async () => {
    run = await runMigrations([
      { path: '1.sql', sql: "select pg_catalog.set_config('search_path', '', false);" },
      { path: '2.sql', sql: 'create table t (id int);' },
    ], 'plain')
    expect(run.failure).toBeUndefined()
  })

  it('reads the catalog with the dialect search_path whatever the session has', async () => {
    run = await runMigrations([{ path: '1.sql', sql: SCHEMA }, { path: '2.sql', sql: `set search_path = app, public;\n${POLICIES}` }], 'supabase')
    await run.db.exec('set search_path = app, public')
    const out = await factsFromDatabase(run.db, 'supabase', [])
    expect(conditions(out.policies as Policy[])).toEqual(WANT)
    // and leaves the caller's session as it was
    expect((await run.db.query<{ search_path: string }>('show search_path')).rows[0]!.search_path).toBe('app, public')
  })
})
