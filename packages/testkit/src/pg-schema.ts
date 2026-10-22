// Reads a table's shape from the catalog: what the runner needs to complete rows and find them by key.
import type { Transaction } from '@electric-sql/pglite'

export type Queryable = Pick<Transaction, 'query'>

export type PgColumn = {
  name: string
  type: string
  notNull: boolean
  hasDefault: boolean
  identity: '' | 'a' | 'd'
  generated: boolean
  enumLabels: string[]
}

export type PgTable = {
  path: string
  // `"schema"."table"`, ready for SQL text.
  sql: string
  columns: PgColumn[]
  primaryKey: string[]
  checks: string[]
}

export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

// `schema.table`, or `table` in `public`.
export function splitPath(path: string): { schema: string; table: string } {
  const dot = path.indexOf('.')
  return dot < 0 ? { schema: 'public', table: path } : { schema: path.slice(0, dot), table: path.slice(dot + 1) }
}

type ColumnRow = { name: string; type: string; notnull: boolean; hasdef: boolean; identity: string; generated: string; labels: string[] }

export async function readTable(db: Queryable, path: string): Promise<PgTable> {
  const { schema, table } = splitPath(path)
  const rel = await db.query<{ oid: number | null }>(`select to_regclass(format('%I.%I', $1::text, $2::text))::oid as oid`, [schema, table])
  const oid = rel.rows[0]?.oid
  if (oid === null || oid === undefined) throw new Error(`table ${path} does not exist`)
  const columns = await db.query<ColumnRow>(
    `select a.attname as name, format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as notnull,
       a.atthasdef as hasdef, a.attidentity::text as identity, a.attgenerated::text as generated,
       coalesce((select array_agg(e.enumlabel::text order by e.enumsortorder) from pg_enum e where e.enumtypid = a.atttypid), '{}') as labels
     from pg_attribute a where a.attrelid = $1 and a.attnum > 0 and not a.attisdropped order by a.attnum`,
    [oid],
  )
  const pk = await db.query<{ name: string }>(
    `select a.attname as name from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey::int2[])
     where i.indrelid = $1 and i.indisprimary order by array_position(i.indkey::int2[], a.attnum)`,
    [oid],
  )
  const checks = await db.query<{ def: string }>(`select pg_get_constraintdef(oid) as def from pg_constraint where conrelid = $1 and contype = 'c'`, [oid])
  return {
    path: `${schema}.${table}`,
    sql: `${quoteIdent(schema)}.${quoteIdent(table)}`,
    columns: columns.rows.map(c => ({
      name: c.name,
      type: c.type,
      notNull: c.notnull,
      hasDefault: c.hasdef,
      identity: (c.identity || '') as PgColumn['identity'],
      generated: c.generated !== '' && c.generated !== null,
      enumLabels: c.labels,
    })),
    primaryKey: pk.rows.map(r => r.name),
    checks: checks.rows.map(r => r.def),
  }
}
