// Runs a Postgres test file on PGlite, one rolled-back transaction per case (spec 5.2).
import type { PGlite } from '@electric-sql/pglite'
import type { TestCase, TestFile } from '@holdline/core'
import { actAs, type Dialect } from './pg-actor.js'
import { describeError, insert, operate, type Run, type Seeded } from './pg-ops.js'
import { completeRow, mapRow } from './pg-rows.js'
import { readTable, type PgTable, type Queryable } from './pg-schema.js'
import type { CaseResult } from './report.js'

export type CaseKind = 'access' | 'invariant'

// Reads through the case's transaction (PGlite serializes queries while one is open); cached per file.
type Tables = (tx: Queryable, path: string) => Promise<PgTable>

async function steps(tx: Queryable, c: TestCase, kind: CaseKind, dialect: Dialect, tables: Tables): Promise<Run> {
  await tx.query('set local session_replication_role = replica')
  const uuids = new Map<string, string>()
  const seeded: Seeded[] = []
  for (const [i, seed] of c.seed.entries()) {
    try {
      const table = await tables(tx, seed.path)
      const row = completeRow(table, seed.data, i, uuids)
      await insert(tx, table, row)
      seeded.push({ table, row })
    } catch (e) {
      return { actual: 'error', error: `seed ${seed.path} failed: ${describeError(e)}` }
    }
  }
  const table = await tables(tx, c.do.path)
  const row = c.do.op === 'create' ? completeRow(table, c.do.data ?? {}, 'do', uuids) : mapRow(table, c.do.data ?? {}, uuids)
  // Invariants run as superuser with foreign keys on; access cases keep replica mode (RLS still applies).
  const act = async () => {
    if (kind === 'invariant') await tx.query('set local session_replication_role = origin')
    else await actAs(tx, dialect, c.as, uuids)
  }
  return operate(tx, c.do.op, table, row, seeded.filter(s => s.table.path === table.path), act)
}

async function runCase(db: PGlite, c: TestCase, kind: CaseKind, dialect: Dialect, tables: Tables): Promise<Run> {
  try {
    return await db.transaction(async tx => {
      try {
        return await steps(tx, c, kind, dialect, tables)
      } catch (e) {
        return { actual: 'error' as const, error: describeError(e) }
      } finally {
        await tx.rollback()
      }
    })
  } catch (e) {
    return { actual: 'error', error: describeError(e) }
  }
}

export async function runPostgresFile(db: PGlite, file: TestFile, kind: CaseKind, dialect: Dialect): Promise<CaseResult[]> {
  const cache = new Map<string, PgTable>()
  const tables: Tables = async (tx, path) => cache.get(path) ?? cache.set(path, await readTable(tx, path)).get(path)!
  const results: CaseResult[] = []
  for (const c of file.cases) {
    const run = await runCase(db, c, kind, dialect, tables)
    const passed = run.actual === c.expect
    const result: CaseResult = { name: c.name, expect: c.expect, actual: run.actual, passed }
    if (!passed) result.detail = `expected ${c.expect}, got ${run.actual}${run.error ? `: ${run.error}` : ''}`
    results.push(result)
  }
  return results
}
