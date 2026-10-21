import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyMigrations, runMigrations, type MigrationRun } from '../src/migrate.js'
import { makeProject } from './helpers/project.js'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

let run: MigrationRun | undefined
afterEach(async () => { await run?.db.close(); run = undefined })

describe('applyMigrations', () => {
  it('applies Supabase migrations in order on top of the shim', async () => {
    const root = await makeProject({
      'supabase/migrations/002_b.sql': 'alter table public.a add column note text;',
      'supabase/migrations/001_a.sql': 'create table public.a (id uuid primary key default extensions.uuid_generate_v4(), owner uuid references auth.users (id));',
    })
    run = await applyMigrations(root, {})
    expect(run.failure).toBeUndefined()
    expect(run.dialect).toBe('supabase')
    expect(run.migrations.map(m => m.path)).toEqual(['supabase/migrations/001_a.sql', 'supabase/migrations/002_b.sql'])
    const cols = await run.db.query<{ attname: string }>(`select attname from pg_attribute where attrelid = 'public.a'::regclass and attnum > 0 order by attnum`)
    expect(cols.rows.map(r => r.attname)).toEqual(['id', 'owner', 'note'])
  })

  it('reads auth.uid(), auth.jwt() and auth.role() from request.jwt.claims', async () => {
    run = await runMigrations([], 'supabase')
    const before = await run.db.query<{ uid: string | null }>(`select auth.uid() as uid`)
    expect(before.rows[0]!.uid).toBeNull()
    await run.db.exec('begin')
    await run.db.query(`select set_config('request.jwt.claims', $1, true)`,
      [JSON.stringify({ sub: '00000000-0000-0000-0000-000000000001', role: 'authenticated', user_role: 'admin' })])
    const r = await run.db.query<{ uid: string; role: string; claim: string }>(`select auth.uid() as uid, auth.role() as role, auth.jwt() ->> 'user_role' as claim`)
    expect(r.rows[0]).toEqual({ uid: '00000000-0000-0000-0000-000000000001', role: 'authenticated', claim: 'admin' })
    await run.db.exec('rollback')
    // After a transaction-local setting is rolled back the setting is '' rather than unset: still null, not an error.
    expect((await run.db.query<{ uid: string | null }>(`select auth.uid() as uid`)).rows[0]!.uid).toBeNull()
  })

  it('lets the authenticated role use public tables (Supabase default privileges)', async () => {
    run = await runMigrations([{ path: 'm.sql', sql: 'create table public.t (id int);' }], 'supabase')
    await expect(run.db.exec('begin; set local role authenticated; select * from public.t; rollback;')).resolves.toBeDefined()
  })

  it('puts extensions on the search_path for Supabase, so unqualified uuid_generate_v4() works', async () => {
    run = await runMigrations([
      { path: 'a.sql', sql: 'create table public.u (id uuid primary key default uuid_generate_v4());' },
      { path: 'b.sql', sql: `select crypt('x', gen_salt('bf'));` },
    ], 'supabase')
    expect(run.failure).toBeUndefined()
    const sp = await run.db.query<{ search_path: string }>('show search_path')
    expect(sp.rows[0]!.search_path).toBe('"$user", public, extensions')
  })

  it('leaves the search_path alone for the plain dialect', async () => {
    run = await runMigrations([], 'plain')
    const sp = await run.db.query<{ search_path: string }>('show search_path')
    expect(sp.rows[0]!.search_path).toBe('public') // PGlite's default
  })

  it('fails the authenticated-role check when privileges are missing', async () => {
    run = await runMigrations([{ path: 'm.sql', sql: 'create table public.t (id int); revoke all on public.t from authenticated;' }], 'supabase')
    await expect(run.db.exec('begin; set local role authenticated; select * from public.t;')).rejects.toThrow(/permission denied/)
    await run.db.exec('rollback')
  })

  it('does not create the shim for the plain dialect', async () => {
    run = await runMigrations([{ path: 'm.sql', sql: 'create schema auth; create table auth.users (id int);' }], 'plain')
    expect(run.failure).toBeUndefined()
  })

  it('stops at the first failing migration and reports its file, line and message', async () => {
    run = await runMigrations([
      { path: 'a.sql', sql: 'create table public.a (id int);' },
      { path: 'b.sql', sql: 'create table public.b (id int);\nselect nosuch from public.b;' },
      { path: 'c.sql', sql: 'create table public.c (id int);' },
    ], 'plain')
    expect(run.failure).toEqual({ file: 'b.sql', line: 2, message: 'column "nosuch" does not exist (line 2)' })
    const tables = await run.db.query<{ relname: string }>(`select relname from pg_class where relname in ('a', 'b', 'c') order by 1`)
    expect(tables.rows.map(r => r.relname)).toEqual(['a'])
  })

  it('names an extension PGlite does not ship', async () => {
    run = await runMigrations([{ path: 'x.sql', sql: 'create extension postgis;' }], 'plain')
    expect(run.failure?.message).toMatch(/extension "postgis" is not available/)
  })
})
