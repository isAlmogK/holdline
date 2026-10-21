// The case's operation on the seeded record row, and how its result maps to an outcome (spec 5.2 step 3).
import type { TestCase } from '@holdline/core'
import { quoteIdent, type PgTable, type Queryable } from './pg-schema.js'
import type { Outcome } from './report.js'

// not null, foreign key, unique, check, invalid input (enum label).
const REJECT_CODES = new Set(['23502', '23503', '23505', '23514', '22P02'])
const NO_PRIVILEGE = '42501'

export type Run = { actual: Outcome; error?: string }
export type Row = Record<string, unknown>
export type Seeded = { table: PgTable; row: Row }

export function describeError(e: unknown): string {
  const err = e as { message?: string; code?: string }
  const message = err?.message ?? String(e)
  return err?.code ? `${message} (${err.code})` : message
}

export async function insert(tx: Queryable, table: PgTable, row: Row): Promise<void> {
  const cols = Object.keys(row)
  if (cols.length === 0) return void (await tx.query(`insert into ${table.sql} default values`))
  const params = cols.map((_, i) => `$${i + 1}`).join(', ')
  await tx.query(`insert into ${table.sql} (${cols.map(quoteIdent).join(', ')}) values (${params})`, cols.map(c => row[c]))
}

function wherePk(table: PgTable, row: Row): { sql: string; params: unknown[] } {
  if (table.primaryKey.length === 0) throw new Error(`table ${table.path} has no primary key`)
  return {
    sql: table.primaryKey.map((c, i) => `${quoteIdent(c)} = $${i + 1}`).join(' and '),
    params: table.primaryKey.map(c => row[c]),
  }
}

function keyOf(table: PgTable, row: Row): string {
  const uuid = (c: string) => table.columns.find(col => col.name === c)?.type === 'uuid'
  return JSON.stringify(table.primaryKey.map(c => (uuid(c) ? String(row[c]).toLowerCase() : String(row[c]))))
}

// An update with no data columns writes the record's own value to one column (a non-key one when it has one).
function touch(table: PgTable, record: Row): Row {
  const col = Object.keys(record).find(c => !table.primaryKey.includes(c)) ?? table.primaryKey[0]!
  return { [col]: record[col] }
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

// `act` switches to the case's actor; until then the transaction runs as superuser.
export async function operate(tx: Queryable, op: TestCase['do']['op'], table: PgTable, row: Row, records: Seeded[], act: () => Promise<void>): Promise<Run> {
  if (op === 'create') {
    await act()
    return attempt(async () => (await insert(tx, table, row), 'allow'), true)
  }
  const record = records[0]?.row
  if (!record) return { actual: 'error', error: `no seed row of ${table.path} to ${op}` }
  const pk = wherePk(table, record)
  const ctid = async () => (await tx.query<{ c: string }>(`select ctid::text as c from ${table.sql} where ${pk.sql}`, pk.params)).rows[0]?.c
  // UPDATE and DELETE run with no WHERE and no column reads: Postgres applies SELECT policies to them only when
  // the statement reads columns, and a data-access rule is per op. The record's fate is checked afterwards as
  // superuser (RESET ROLE): a new ctid means it was updated, a missing row means it was deleted.
  switch (op) {
    case 'read':
      await act()
      return attempt(async () => ((await tx.query(`select 1 from ${table.sql} where ${pk.sql}`, pk.params)).rows.length > 0 ? 'allow' : 'deny'), false)
    case 'list':
      await act()
      return attempt(async () => {
        const pkCols = table.primaryKey.map(quoteIdent).join(', ')
        const seen = new Set((await tx.query<Row>(`select ${pkCols} from ${table.sql}`)).rows.map(r => keyOf(table, r)))
        return records.some(s => seen.has(keyOf(table, s.row))) ? 'allow' : 'deny'
      }, false)
    case 'update': {
      const before = await ctid()
      const data = Object.keys(row).length > 0 ? row : touch(table, record)
      const cols = Object.keys(data)
      const set = cols.map((c, i) => `${quoteIdent(c)} = $${i + 1}`).join(', ')
      await act()
      return attempt(async () => {
        await tx.query(`update ${table.sql} set ${set}`, cols.map(c => data[c]))
        await tx.query('reset role')
        return (await ctid()) !== before ? 'allow' : 'deny'
      }, true)
    }
    case 'delete':
      await act()
      return attempt(async () => {
        await tx.query(`delete from ${table.sql}`)
        await tx.query('reset role')
        return (await ctid()) === undefined ? 'allow' : 'deny'
      }, false)
  }
}
