// Temporary copy of analyzer-postgres's applyMigrations (spec 3.2); replaced by the import once Track A merges.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { listFiles, matchFiles, type HoldlineConfig } from '@holdline/core'

export type MigrationResult = { db: PGlite; dialect: 'supabase' | 'plain'; files: string[]; error?: { file: string; message: string } }

const DEFAULT_GLOBS = [
  'supabase/migrations/*.sql',
  'prisma/migrations/*/migration.sql',
  'drizzle/*.sql',
  'migrations/*.sql',
  'db/migrations/*.sql',
]

const SUPABASE_SHIM = `
create schema if not exists auth;
create schema if not exists storage;
create schema if not exists extensions;
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
create function auth.role() returns text language sql stable as $$ select nullif(current_setting('request.jwt.claim.role', true), '')::text $$;
create table auth.users (id uuid primary key, email text);
grant usage on schema auth, extensions to anon, authenticated, service_role;
`

function failure(e: unknown): string {
  const err = e as { message?: string; position?: string | number }
  const message = err?.message ?? String(e)
  return err?.position !== undefined ? `${message} at position ${err.position}` : message
}

export async function applyMigrations(root: string, config: HoldlineConfig): Promise<MigrationResult> {
  const all = await listFiles(root)
  const configured = config.postgres?.migrations
  const files = configured
    ? matchFiles(all, configured)
    : [...new Set(DEFAULT_GLOBS.flatMap(g => matchFiles(all, [g])))]
  files.sort()
  const dialect = config.postgres?.dialect ?? (files.some(f => f.startsWith('supabase/migrations/')) ? 'supabase' : 'plain')
  const db = new PGlite()
  if (dialect === 'supabase') await db.exec(SUPABASE_SHIM)
  for (const file of files) {
    try {
      const sql = await readFile(join(root, file), 'utf8')
      await db.transaction(tx => tx.exec(sql))
    } catch (e) {
      return { db, dialect, files, error: { file, message: failure(e) } }
    }
  }
  return { db, dialect, files }
}
