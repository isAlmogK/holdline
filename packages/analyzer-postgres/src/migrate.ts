import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PGlite } from '@electric-sql/pglite'
import { listFiles, type HoldlineConfig } from '@holdline/core'
import { findMigrations, type Dialect } from './detect.js'
import { SUPABASE_SHIM } from './shim.js'

export interface Migration { path: string; sql: string }
export interface MigrationFailure { file: string; line?: number; message: string }
export interface MigrationRun {
  db: PGlite // the caller closes it
  dialect: Dialect
  migrations: Migration[]
  failure?: MigrationFailure // the first migration that failed; later ones were not applied
}

export async function readMigrations(root: string, paths: readonly string[]): Promise<Migration[]> {
  return Promise.all(paths.map(async path => ({ path, sql: await readFile(join(root, path), 'utf8') })))
}

// A fresh in-memory Postgres; the Supabase shim for that dialect; each migration in its own transaction.
// Stops at the first failure, because later migrations would run against the wrong schema.
export async function runMigrations(migrations: readonly Migration[], dialect: Dialect): Promise<MigrationRun> {
  const { PGlite } = await import('@electric-sql/pglite')
  const { uuid_ossp } = await import('@electric-sql/pglite/contrib/uuid_ossp')
  const { pgcrypto } = await import('@electric-sql/pglite/contrib/pgcrypto')
  const db = await PGlite.create({ extensions: { uuid_ossp, pgcrypto } })
  const run: MigrationRun = { db, dialect, migrations: [...migrations] }
  if (dialect === 'supabase') await db.exec(SUPABASE_SHIM)
  for (const m of migrations) {
    try {
      await db.transaction(tx => tx.exec(m.sql))
    } catch (e) {
      return { ...run, failure: failureOf(m, e) }
    }
  }
  return run
}

function failureOf(m: Migration, e: unknown): MigrationFailure {
  const message = e instanceof Error ? e.message : String(e)
  const position = Number((e as { position?: unknown }).position)
  if (!Number.isInteger(position) || position < 1) return { file: m.path, message }
  const line = m.sql.slice(0, position - 1).split('\n').length
  return { file: m.path, line, message: `${message} (line ${line})` }
}

// The migrations of the project at `root`, applied the way the analyzer applies them (spec 3.2).
export async function applyMigrations(root: string, config: HoldlineConfig, files?: readonly string[]): Promise<MigrationRun> {
  const plan = findMigrations(files ?? await listFiles(root), config)
  return runMigrations(await readMigrations(root, plan.paths), plan.dialect)
}
