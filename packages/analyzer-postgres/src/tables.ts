import type { Transaction } from '@electric-sql/pglite'
import type { Table } from '@holdline/core'

// A PGlite database or one of its transactions.
export type Queryable = Pick<Transaction, 'query'>

export const SYSTEM_SCHEMAS_SQL = `n.nspname <> 'information_schema' and n.nspname not like 'pg\\_%'`

export const sqlList = (names: readonly string[]) =>
  names.length === 0 ? `''` : names.map(n => `'${n.replace(/'/g, "''")}'`).join(', ')

// Aliases avoid reserved words ("table", "default").
interface TableRow { schema: string; tbl: string; rls: boolean }
interface ColumnRow { schema: string; tbl: string; name: string; type: string; nullable: boolean; dflt: string | null; enum_values: string[] | null }
interface ConstraintRow { schema: string; tbl: string; name: string; type: 'p' | 'u' | 'f' | 'c'; def: string; columns: string[]; ref_schema: string | null; ref_table: string | null; ref_columns: string[] }
interface IndexRow { schema: string; tbl: string; columns: string[] }

const SHORT: [RegExp, string][] = [
  [/^timestamp(\(\d+\))? with time zone/, 'timestamptz$1'],
  [/^timestamp(\(\d+\))? without time zone/, 'timestamp$1'],
  [/^time(\(\d+\))? with time zone/, 'timetz$1'],
  [/^time(\(\d+\))? without time zone/, 'time$1'],
  [/^character varying/, 'varchar'],
  [/^character(?=\(|\[|$)/, 'char'],
]

export function shortType(t: string): string {
  for (const [re, to] of SHORT) if (re.test(t)) return t.replace(re, to)
  return t
}

export function shortDefault(d: string): string {
  return d.replace(/^('(?:[^']|'')*')::[^'()]+$/, '$1')
}

export function checkExpr(def: string): string {
  return def.replace(/ NOT VALID$/, '').replace(/^CHECK \((.*)\)$/s, '$1')
}

export async function readTables(db: Queryable, excluded: readonly string[]): Promise<Table[]> {
  const where = `${SYSTEM_SCHEMAS_SQL} and n.nspname not in (${sqlList(excluded)}) and c.relkind in ('r', 'p')`
  const from = `pg_class c join pg_namespace n on n.oid = c.relnamespace`
  const tables = (await db.query<TableRow>(
    `select n.nspname as schema, c.relname as tbl, c.relrowsecurity as rls from ${from} where ${where} order by 1, 2`)).rows
  const columns = (await db.query<ColumnRow>(`
    select n.nspname as schema, c.relname as tbl, a.attname as name, format_type(a.atttypid, a.atttypmod) as type,
      not a.attnotnull as nullable, pg_get_expr(d.adbin, d.adrelid) as dflt,
      case when t.typtype = 'e' then array(select e.enumlabel::text from pg_enum e where e.enumtypid = t.oid order by e.enumsortorder) end as enum_values
    from pg_attribute a join ${from} on c.oid = a.attrelid join pg_type t on t.oid = a.atttypid
      left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where a.attnum > 0 and not a.attisdropped and ${where}
    order by 1, 2, a.attnum`)).rows
  const constraints = (await db.query<ConstraintRow>(`
    select n.nspname as schema, c.relname as tbl, k.conname as name, k.contype as type, pg_get_constraintdef(k.oid) as def,
      array(select a.attname::text from unnest(k.conkey) with ordinality u(num, i) join pg_attribute a on a.attrelid = k.conrelid and a.attnum = u.num order by u.i) as columns,
      fn.nspname as ref_schema, fc.relname as ref_table,
      array(select a.attname::text from unnest(k.confkey) with ordinality u(num, i) join pg_attribute a on a.attrelid = k.confrelid and a.attnum = u.num order by u.i) as ref_columns
    from pg_constraint k join ${from} on c.oid = k.conrelid
      left join pg_class fc on fc.oid = k.confrelid left join pg_namespace fn on fn.oid = fc.relnamespace
    where k.contype in ('p', 'u', 'f', 'c') and ${where}
    order by 1, 2, k.conkey[1], k.conname`)).rows
  // Unique indexes that back no constraint; partial and expression indexes don't guarantee uniqueness of the columns.
  const indexes = (await db.query<IndexRow>(`
    select n.nspname as schema, c.relname as tbl,
      array(select a.attname::text from unnest(i.indkey::int2[]) with ordinality u(num, o) join pg_attribute a on a.attrelid = i.indrelid and a.attnum = u.num where u.o <= i.indnkeyatts order by u.o) as columns
    from pg_index i join ${from} on c.oid = i.indrelid join pg_class ic on ic.oid = i.indexrelid
    where i.indisunique and not i.indisprimary and i.indexprs is null and i.indpred is null
      and not exists (select 1 from pg_constraint k where k.conindid = i.indexrelid) and ${where}
    order by 1, 2, i.indkey[0], ic.relname`)).rows

  const of = <R extends { schema: string; tbl: string }>(rows: R[], t: TableRow) => rows.filter(r => r.schema === t.schema && r.tbl === t.tbl)
  return tables.map((t): Table => {
    const name = `${t.schema}.${t.tbl}`
    const cols = of(columns, t)
    const cons = of(constraints, t)
    return {
      id: `pg:${name}`,
      name,
      columns: cols.map(c => ({ name: c.name, type: shortType(c.type), nullable: c.nullable, ...(c.dflt === null ? {} : { default: shortDefault(c.dflt) }) })),
      primaryKey: cons.find(k => k.type === 'p')?.columns ?? [],
      foreignKeys: cons.filter(k => k.type === 'f').map(k => ({ columns: k.columns, references: { table: `${k.ref_schema}.${k.ref_table}`, columns: k.ref_columns } })),
      uniques: [...cons.filter(k => k.type === 'u').map(k => k.columns), ...of(indexes, t).map(i => i.columns)],
      checks: cons.filter(k => k.type === 'c').map(k => ({ name: k.name, expr: checkExpr(k.def) })),
      enums: cols.filter(c => c.enum_values !== null).map(c => ({ column: c.name, values: c.enum_values! })),
      rlsEnabled: t.rls,
    }
  })
}
