// Runs a Postgres test file on PGlite, one rolled-back transaction per case (spec 5.2).
import type { PGlite } from '@electric-sql/pglite'
import type { TestCase, TestFile } from '@holdline/core'
import { actAs, type Dialect } from './pg-actor.js'
import { completeRow, mapRow } from './pg-rows.js'
import { quoteIdent, readTable, type PgTable, type Queryable } from './pg-schema.js'
import type { CaseResult, Outcome } from './report.js'

export type CaseKind = 'access' | 'invariant'

// not null, foreign key, unique, check, invalid input (enum label).
const REJECT_CODES = new Set(['23502', '23503', '23505', '23514', '22P02'])
const NO_PRIVILEGE = '42501'

type Run = { actual: Outcome; error?: string }
type Seeded = { table: PgTable; row: Record<string, unknown> }
// Reads through the case's transaction (PGlite serializes queries while one is open); cached per file.
type Tables = (tx: Queryable, path: string) => Promise<PgTable>

function describeError(e: unknown): string {
  const err = e as { message?: string; code?: string }
  const message = err?.message ?? String(e)
  return err?.code ? `${message} (${err.code})` : message
}

async function insert(tx: Queryable, table: PgTable, row: Record<string, unknown>): Promise<void> {
  const cols = Object.keys(row)
  if (cols.length === 0) return void (await tx.query(`insert into ${table.sql} default values`))
  const params = cols.map((_, i) => `$${i + 1}`).join(', ')
  await tx.query(`insert into ${table.sql} (${cols.map(quoteIdent).join(', ')}) values (${params})`, cols.map(c => row[c]))
}

function wherePk(table: PgTable, row: Record<string, unknown>, offset = 0): { sql: string; params: unknown[] } {
  if (table.primaryKey.length === 0) throw new Error(`table ${table.path} has no primary key`)
  return {
    sql: table.primaryKey.map((c, i) => `${quoteIdent(c)} = $${offset + i + 1}`).join(' and '),
    params: table.primaryKey.map(c => row[c]),
  }
}

function keyOf(table: PgTable, row: Record<string, unknown>): string {
  const uuid = (c: string) => table.columns.find(col => col.name === c)?.type === 'uuid'
  return JSON.stringify(table.primaryKey.map(c => (uuid(c) ? String(row[c]).toLowerCase() : String(row[c]))))
}

// A refused statement: no privilege or RLS is deny; a constraint is reject where the op can be rejected.
async function attempt(run: () => Promise<Outcome>, canReject: boolean): Promise<Run> {
  try {
    return { actual: await run() }
  } catch (e) {
    const code = (e as { code?: string })?.code
    if (code === NO_PRIVILEGE) return { actual: 'deny', error: describeError(e) }
    if (canReject && code && REJECT_CODES.has(code)) return { actual: 'reject', error: describeError(e) }
    return { actual: 'error', error: describeError(e) }
  }
}

async function operate(tx: Queryable, op: TestCase['do']['op'], table: PgTable, row: Record<string, unknown>, records: Seeded[]): Promise<Run> {
  if (op === 'create') return attempt(async () => (await insert(tx, table, row), 'allow'), true)
  const record = records[0]?.row
  if (!record) return { actual: 'error', error: `no seed row of ${table.path} to ${op}` }
  const pk = wherePk(table, record)
  const changed = (r: { rowCount?: number; affectedRows?: number }): Outcome => ((r.rowCount ?? r.affectedRows ?? 0) > 0 ? 'allow' : 'deny')
  switch (op) {
    case 'read':
      return attempt(async () => ((await tx.query(`select 1 from ${table.sql} where ${pk.sql}`, pk.params)).rows.length > 0 ? 'allow' : 'deny'), false)
    case 'list':
      return attempt(async () => {
        const pkCols = table.primaryKey.map(quoteIdent).join(', ')
        const seen = new Set((await tx.query<Record<string, unknown>>(`select ${pkCols} from ${table.sql}`)).rows.map(r => keyOf(table, r)))
        return records.some(s => seen.has(keyOf(table, s.row))) ? 'allow' : 'deny'
      }, false)
    case 'update': {
      const cols = Object.keys(row)
      const set = cols.length > 0 ? cols.map((c, i) => `${quoteIdent(c)} = $${i + 1}`).join(', ') : `${quoteIdent(table.primaryKey[0]!)} = ${quoteIdent(table.primaryKey[0]!)}`
      const where = wherePk(table, record, cols.length)
      return attempt(async () => changed(await tx.query(`update ${table.sql} set ${set} where ${where.sql}`, [...cols.map(c => row[c]), ...where.params])), true)
    }
    case 'delete':
      return attempt(async () => changed(await tx.query(`delete from ${table.sql} where ${pk.sql}`, pk.params)), false)
  }
}

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
  if (kind === 'invariant') await tx.query('set local session_replication_role = origin')
  else await actAs(tx, dialect, c.as, uuids)
  return operate(tx, c.do.op, table, row, seeded.filter(s => s.table.path === table.path))
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
