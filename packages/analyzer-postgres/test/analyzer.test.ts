import { readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { FileCache, listFiles, type AnalyzerContext, type HoldlineConfig } from '@holdline/core'
import { describe, expect, it, vi } from 'vitest'
import { postgresAnalyzer } from '../src/analyzer.js'
import { makeProject } from './helpers/project.js'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

async function context(root: string, config: HoldlineConfig = {}): Promise<AnalyzerContext> {
  return { root, files: await listFiles(root), cache: new FileCache(root), config, recognizers: [] }
}

const MIGRATION = `-- projects
create table public.projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id)
);
alter table public.projects enable row level security;

create policy "owners update" on public.projects
  for update to authenticated
  using (owner_id = (select auth.uid()));
create policy "service" on public.projects to service_role using (true);
`

describe('postgresAnalyzer', () => {
  it('emits tables, symbols and policies with locations', async () => {
    const root = await makeProject({ 'supabase/migrations/001_init.sql': MIGRATION })
    const out = await postgresAnalyzer.analyze(await context(root))
    expect(out.tables).toHaveLength(1)
    expect(out.tables![0]).toMatchObject({ id: 'pg:public.projects', rlsEnabled: true, location: { file: 'supabase/migrations/001_init.sql', line: 2 } })
    expect(out.symbols).toEqual([
      { id: 'pg:public.projects', kind: 'table', lang: 'sql', location: { file: 'supabase/migrations/001_init.sql', line: 2 } },
      { id: 'pg:public.projects#policy:owners update', kind: 'policy', lang: 'sql', location: { file: 'supabase/migrations/001_init.sql', line: 8 } },
    ])
    const authenticated = { atom: { op: 'authenticated' } }
    const owner = { atom: { op: 'eq', left: 'resource.owner_id', right: 'actor.uid' } }
    const incomingOwner = { atom: { op: 'eq', left: 'incoming.owner_id', right: 'actor.uid' } }
    expect(out.policies).toEqual([{
      id: 'pg:public.projects#policy:owners update', store: 'pg-rls', target: 'public.projects', ops: ['update'],
      // authenticated AND (authenticated AND resource owner) AND (authenticated AND incoming owner)
      condition: { and: [authenticated, { and: [authenticated, owner] }, { and: [authenticated, incomingOwner] }] },
      functions: [], evidence: { file: 'supabase/migrations/001_init.sql', line: 8 },
    }])
    expect(out.diagnostics).toEqual([expect.objectContaining({ severity: 'warning', message: expect.stringContaining('"service"') })])
  })

  it('reports a failing migration as one error diagnostic', async () => {
    const root = await makeProject({ 'supabase/migrations/001.sql': 'create table public.a (id int);\ncreate tabel b;' })
    const out = await postgresAnalyzer.analyze(await context(root))
    expect(out).toEqual({ diagnostics: [{ analyzer: 'postgres', file: 'supabase/migrations/001.sql', severity: 'error', message: expect.stringMatching(/syntax error.*\(line 2\)/) }] })
  })

  it('reports configured globs that match nothing, and a Prisma schema without migrations', async () => {
    const empty = await makeProject({ 'src/a.ts': '' })
    expect(await postgresAnalyzer.analyze(await context(empty, { postgres: { migrations: ['db/*.sql'] } }))).toEqual({ diagnostics: [
      { analyzer: 'postgres', file: '.holdline/config.yaml', severity: 'error', message: 'postgres.migrations matches no files' },
    ] })
    const prisma = await makeProject({ 'prisma/schema.prisma': 'model A { id Int @id }' })
    expect(await postgresAnalyzer.detect(prisma, await listFiles(prisma), {})).toBe(true)
    expect(await postgresAnalyzer.analyze(await context(prisma))).toEqual({ diagnostics: [
      { analyzer: 'postgres', file: 'prisma/schema.prisma', severity: 'warning', message: 'no SQL migrations found; run prisma migrate or point holdline at a schema dump' },
    ] })
  })

  it('serves an unchanged migration set from the cache without starting Postgres', async () => {
    const root = await makeProject({ 'supabase/migrations/001_init.sql': MIGRATION })
    await postgresAnalyzer.analyze(await context(root))
    const dir = join(root, '.holdline/cache/files/postgres')
    const [file] = await readdir(dir)
    const sentinel = { diagnostics: [{ analyzer: 'postgres', file: 'x', severity: 'warning', message: 'from cache' }] }
    await writeFile(join(dir, file!), JSON.stringify(sentinel))
    expect(await postgresAnalyzer.analyze(await context(root))).toEqual(sentinel)
    await writeFile(join(root, 'supabase/migrations/001_init.sql'), `${MIGRATION}\n-- changed\n`)
    expect((await postgresAnalyzer.analyze(await context(root))).tables).toHaveLength(1)
  })

  it('scans 50 migrations cold in under 10 seconds (spec 3.5)', async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 50; i++) {
      const n = String(i).padStart(3, '0')
      files[`supabase/migrations/${n}_t.sql`] = `create table public.t${n} (id uuid primary key, owner_id uuid not null);
alter table public.t${n} enable row level security;
create policy "own ${n}" on public.t${n} for all to authenticated using (owner_id = (select auth.uid()));`
    }
    const root = await makeProject(files)
    const started = Date.now()
    const out = await postgresAnalyzer.analyze(await context(root))
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(out.tables).toHaveLength(50)
    expect(out.policies).toHaveLength(250)
  })
})
