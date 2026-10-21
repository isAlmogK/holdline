export interface SqlFunction {
  schema: string
  name: string
  argNames: string[]
  language: string // pg_language.lanname
  volatility: string // pg_proc.provolatile: i, s or v
  body: string // pg_proc.prosrc
}

// What the normalizer needs to know about the database.
export interface CatalogIndex {
  relations: Map<string, Set<string>> // 'schema.table' → column names, for every non-system table
  functions: Map<string, SqlFunction> // 'schema.name/nargs'
}
