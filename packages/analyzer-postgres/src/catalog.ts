import type { PGlite } from '@electric-sql/pglite'
import type { Table } from '@holdline/core'
import type { Dialect } from './detect.js'
import { readTables, SYSTEM_SCHEMAS_SQL, type Queryable } from './tables.js'

export interface SqlFunction {
  schema: string
  name: string
  argNames: string[]
  language: string // pg_language.lanname
  volatility: string // pg_proc.provolatile: i, s or v
  body: string // pg_proc.prosrc
  searchPath?: string[] // the function's own SET search_path (pg_proc.proconfig)
}

// What the normalizer needs to know about the database.
export interface CatalogIndex {
  relations: Map<string, Set<string>> // 'schema.table' → column names, for every non-system table
  functions: Map<string, SqlFunction> // 'schema.name/nargs'
  builtins: Set<string> // names of pg_catalog functions: an unqualified call to one is never a user function
}

export const SHIM_SCHEMAS = ['auth', 'storage', 'extensions']

// pg_get_expr, format_type and pg_get_constraintdef print names relative to the session search_path. The catalog
// is read with these, the schemas normalize.ts resolves unqualified names through (a migration may have changed it).
export const SEARCH_PATH: Record<Dialect, string> = { supabase: '"$user", public, extensions', plain: 'public' }

export interface PolicyRow {
  schema: string
  table: string
  name: string
  cmd: 'r' | 'a' | 'w' | 'd' | '*'
  permissive: boolean
  roles: string[] // 'public' for PUBLIC
  // The policy applies to a caller with role authenticated (anon): PUBLIC, or a role whose privileges that role has
  // (pg_has_role USAGE, as Postgres decides). False when the role does not exist (the plain dialect).
  coversSignedIn: boolean
  coversAnon: boolean
  using: string | null // pg_get_expr(polqual)
  check: string | null // pg_get_expr(polwithcheck)
}

export interface Catalog extends CatalogIndex { tables: Table[]; policies: PolicyRow[] }

interface FnRow {
  schema: string; name: string; nargs: number; names: string[] | null; modes: string[] | null
  language: string; volatility: string; body: string; config: string[] | null
}

// Names of the input arguments only (modes i, b, v), so they line up with a call's arguments.
function inputNames(names: string[] | null, modes: string[] | null): string[] {
  if (!names) return []
  return names.filter((_, i) => modes === null || ['i', 'b', 'v'].includes(modes[i] ?? 'i'))
}

// The function's own SET search_path; pg_catalog and pg_temp are covered by `builtins`, $user has no schema here.
function searchPathOf(config: string[] | null): string[] | undefined {
  const entry = config?.find(c => c.startsWith('search_path='))
  if (entry === undefined) return undefined
  return entry.slice('search_path='.length).split(',')
    .map(s => s.trim().replace(/^"(.*)"$/, '$1'))
    .filter(s => s !== '' && s !== '$user' && s !== 'pg_temp' && s !== 'pg_catalog')
}

async function readFunctions(db: Queryable): Promise<Map<string, SqlFunction>> {
  const rows = (await db.query<FnRow>(`
    select n.nspname as schema, p.proname as name, p.pronargs as nargs, p.proargnames::text[] as names,
      p.proargmodes::text[] as modes, l.lanname as language, p.provolatile as volatility, p.prosrc as body,
      p.proconfig as config
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
    where p.prokind = 'f' and ${SYSTEM_SCHEMAS_SQL}
    order by 1, 2, 3`)).rows
  const functions = new Map<string, SqlFunction>()
  const overloaded = new Set<string>()
  for (const r of rows) {
    const key = `${r.schema}.${r.name}/${r.nargs}`
    if (functions.has(key)) overloaded.add(key) // same name and arity: a call can't be matched to one body
    const searchPath = searchPathOf(r.config)
    functions.set(key, {
      schema: r.schema, name: r.name, argNames: inputNames(r.names, r.modes), language: r.language,
      volatility: r.volatility, body: r.body, ...(searchPath ? { searchPath } : {}),
    })
  }
  for (const key of overloaded) functions.delete(key)
  return functions
}

const covers = (role: string) => `coalesce((select bool_or(r = 0 or pg_has_role(
  (select oid from pg_roles where rolname = '${role}'), r, 'USAGE')) from unnest(p.polroles) r), false)`

// In a transaction with a local search_path, so the caller's session is left as it was.
export function readCatalog(db: PGlite, dialect: Dialect): Promise<Catalog> {
  return db.transaction(async tx => {
    await tx.query(`select set_config('search_path', $1, true)`, [SEARCH_PATH[dialect]])
    return readAll(tx, dialect)
  })
}

async function readAll(db: Queryable, dialect: Dialect): Promise<Catalog> {
  const excluded = dialect === 'supabase' ? SHIM_SCHEMAS : []
  const tables = await readTables(db, excluded)
  const names = new Set(tables.map(t => t.name))
  const columns = (await db.query<{ tbl: string; col: string }>(`
    select n.nspname || '.' || c.relname as tbl, a.attname as col
    from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
    where a.attnum > 0 and not a.attisdropped and c.relkind in ('r', 'p', 'v', 'm', 'f') and ${SYSTEM_SCHEMAS_SQL}
    order by 1, a.attnum`)).rows
  const relations = new Map<string, Set<string>>()
  for (const r of columns) relations.set(r.tbl, (relations.get(r.tbl) ?? new Set()).add(r.col))
  const builtins = new Set((await db.query<{ name: string }>(`
    select distinct p.proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'pg_catalog'`)).rows.map(r => r.name))
  const rows = (await db.query<PolicyRow>(`
    select n.nspname as schema, c.relname as "table", p.polname as name, p.polcmd as cmd, p.polpermissive as permissive,
      array(select case when r = 0 then 'public' else pg_get_userbyid(r)::text end from unnest(p.polroles) r) as roles,
      ${covers('authenticated')} as "coversSignedIn", ${covers('anon')} as "coversAnon",
      pg_get_expr(p.polqual, p.polrelid) as "using", pg_get_expr(p.polwithcheck, p.polrelid) as "check"
    from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace
    order by 1, 2, 3`)).rows
  return {
    tables, relations, builtins, functions: await readFunctions(db),
    policies: rows.filter(r => names.has(`${r.schema}.${r.table}`)),
  }
}
