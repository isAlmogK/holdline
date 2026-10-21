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
