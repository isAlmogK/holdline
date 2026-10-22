import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { readCatalog } from '../src/catalog.js'
import { runMigrations, type MigrationRun } from '../src/migrate.js'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

let run: MigrationRun
beforeAll(async () => {
  run = await runMigrations([{ path: 'm.sql', sql: `
    create table public.docs (id uuid primary key, owner_id uuid);
    alter table public.docs enable row level security;
    create function public.mine(o uuid) returns boolean language sql stable as $$ select o = auth.uid() $$;
    create policy "own" on public.docs for update to authenticated using (public.mine(owner_id)) with check (owner_id = auth.uid());
    create policy "anon none" on public.docs as restrictive for select to anon using (false);
    create policy "files" on storage.objects for select using (owner = auth.uid());
  ` }], 'supabase')
})
afterAll(async () => { await run.db.close() })

describe('readCatalog', () => {
  it('reads policy rows, relations and functions, leaving shim tables out of tables and policies', async () => {
    const c = await readCatalog(run.db, 'supabase')
    expect(c.tables.map(t => t.id)).toEqual(['pg:public.docs'])
    expect(c.policies).toEqual([
      { schema: 'public', table: 'docs', name: 'anon none', cmd: 'r', permissive: false, roles: ['anon'], coversSignedIn: false, coversAnon: true, using: 'false', check: null },
      { schema: 'public', table: 'docs', name: 'own', cmd: 'w', permissive: true, roles: ['authenticated'], coversSignedIn: true, coversAnon: false, using: 'mine(owner_id)', check: '(owner_id = auth.uid())' },
    ])
    expect(c.relations.get('public.docs')).toEqual(new Set(['id', 'owner_id']))
    expect(c.relations.get('auth.users')).toEqual(new Set(['id', 'email']))
    expect(c.functions.get('public.mine/1')).toMatchObject({ schema: 'public', name: 'mine', argNames: ['o'], language: 'sql', volatility: 's' })
    expect(c.functions.get('public.mine/1')!.body.trim()).toBe('select o = auth.uid()')
  })
})

describe('readCatalog function details', () => {
  let r2: MigrationRun
  beforeAll(async () => {
    r2 = await runMigrations([{ path: 'm.sql', sql: `
      create function public.locked(a int) returns boolean language sql set search_path = '' as $$ select true $$;
      create function public.scoped(a int) returns boolean language sql set search_path = app, public as $$ select true $$;
      create function public.plain(a int) returns boolean language sql as $$ select true $$;
      create function public.dup(a int) returns boolean language sql as $$ select true $$;
      create function public.dup(a text) returns boolean language sql as $$ select true $$;
      create function public.without(out o int, a int, inout b int) returns record language sql as $$ select 1, b $$;
    ` }], 'supabase')
  })
  afterAll(async () => { await r2.db.close() })

  it('fills searchPath from proconfig', async () => {
    const c = await readCatalog(r2.db, 'supabase')
    expect(c.functions.get('public.locked/1')!.searchPath).toEqual([])
    expect(c.functions.get('public.scoped/1')!.searchPath).toEqual(['app', 'public'])
    expect(c.functions.get('public.plain/1')!.searchPath).toBeUndefined()
  })
  it('lists pg_catalog function names as builtins but not as functions', async () => {
    const c = await readCatalog(r2.db, 'supabase')
    expect(c.builtins.has('lower')).toBe(true)
    expect(c.builtins.has('mine')).toBe(false)
    expect([...c.functions.keys()].some(k => k.startsWith('pg_catalog.'))).toBe(false)
  })
  it('drops overloaded keys', async () => {
    const c = await readCatalog(r2.db, 'supabase')
    expect(c.functions.has('public.dup/1')).toBe(false)
    expect(c.functions.has('public.plain/1')).toBe(true)
  })
  it('keeps only input argument names', async () => {
    const c = await readCatalog(r2.db, 'supabase')
    expect(c.functions.get('public.without/2')?.argNames).toEqual(['a', 'b'])
  })
})

describe('readCatalog role coverage', () => {
  let r3: MigrationRun
  beforeAll(async () => {
    r3 = await runMigrations([{ path: 'm.sql', sql: `
      create role editors; grant editors to authenticated with inherit true;
      create role visitors; grant visitors to anon with inherit true;
      create role everyone; grant everyone to anon, authenticated with inherit true;
      create role reviewers; grant reviewers to authenticated; -- authenticated is NOINHERIT, so this grant does not inherit
      create table public.docs (id int);
      create policy "to public" on public.docs for select using (true);
      create policy "to both" on public.docs for select to anon, authenticated using (true);
      create policy "to service" on public.docs for select to service_role using (true);
      create policy "to editors" on public.docs for select to editors using (true);
      create policy "to visitors" on public.docs for select to visitors using (true);
      create policy "to everyone" on public.docs for select to everyone using (true);
      create policy "to reviewers" on public.docs for select to reviewers using (true);
    ` }], 'supabase')
    if (r3.failure) throw new Error(r3.failure.message)
  })
  afterAll(async () => { await r3.db.close() })

  // Postgres applies a policy to a caller whose role has the privileges of one of the policy's roles (pg_has_role USAGE).
  it('covers the callers whose role has the privileges of a policy role', async () => {
    const c = await readCatalog(r3.db, 'supabase')
    expect(Object.fromEntries(c.policies.map(p => [p.name, [p.coversSignedIn, p.coversAnon]]))).toEqual({
      'to public': [true, true], 'to both': [true, true], 'to service': [false, false], 'to editors': [true, false],
      'to visitors': [false, true], 'to everyone': [true, true], 'to reviewers': [false, false],
    })
  })
  it('covers nobody but public in the plain dialect, where anon and authenticated need not exist', async () => {
    const plain = await runMigrations([{ path: 'm.sql', sql: `
      create role app_user;
      create table public.docs (id int);
      create policy "to public" on public.docs for select using (true);
      create policy "to app" on public.docs for select to app_user using (true);
    ` }], 'plain')
    try {
      const c = await readCatalog(plain.db, 'plain')
      expect(c.policies.map(p => [p.name, p.coversSignedIn, p.coversAnon])).toEqual([['to app', false, false], ['to public', true, true]])
    } finally { await plain.db.close() }
  })
})
