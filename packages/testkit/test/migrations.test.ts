import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { applyMigrations } from '../src/migrations.js'

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holdline-tk-'))
  for (const [p, c] of Object.entries(files)) {
    await mkdir(join(root, p, '..'), { recursive: true })
    await writeFile(join(root, p), c)
  }
  return root
}

// PGlite boots a WASM Postgres per test; allow for parallel-suite load.
vi.setConfig({ testTimeout: 30_000 })

describe('applyMigrations', () => {
  it('applies supabase migrations in path order on top of the auth shim', async () => {
    const root = await project({
      'supabase/migrations/0002_b.sql': 'alter table public.t add column b text;',
      'supabase/migrations/0001_a.sql': 'create table public.t (id uuid primary key default gen_random_uuid(), owner uuid default auth.uid());',
    })
    const r = await applyMigrations(root, {})
    expect(r.error).toBeUndefined()
    expect(r.dialect).toBe('supabase')
    expect(r.files).toEqual(['supabase/migrations/0001_a.sql', 'supabase/migrations/0002_b.sql'])
    const cols = await r.db.query<{ attname: string }>(`select attname from pg_attribute where attrelid = 'public.t'::regclass and attnum > 0 order by attnum`)
    expect(cols.rows.map(c => c.attname)).toEqual(['id', 'owner', 'b'])
    const roles = await r.db.query<{ rolname: string }>(`select rolname from pg_roles where rolname in ('anon','authenticated','service_role') order by 1`)
    expect(roles.rows.map(x => x.rolname)).toEqual(['anon', 'authenticated', 'service_role'])
    await r.db.close()
  })
  it('uses config globs and the plain dialect', async () => {
    const root = await project({ 'db/schema/001.sql': 'create table things (id int primary key);' })
    const r = await applyMigrations(root, { postgres: { migrations: ['db/schema/*.sql'], dialect: 'plain' } })
    expect(r.dialect).toBe('plain')
    expect(r.files).toEqual(['db/schema/001.sql'])
    await r.db.close()
  })
  it('stops at the first failing migration', async () => {
    const root = await project({ 'migrations/1.sql': 'create table a (id int);', 'migrations/2.sql': 'create tabel b;', 'migrations/3.sql': 'create table c (id int);' })
    const r = await applyMigrations(root, {})
    expect(r.error?.file).toBe('migrations/2.sql')
    expect(r.error?.message).toMatch(/syntax error/)
    await r.db.close()
  })
})
