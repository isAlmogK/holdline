import type { SqlNode } from './sql-ast.js'

export interface ParsedStatement { stmt: SqlNode; stmt_location?: number; stmt_len?: number }
export type SqlParse = (sql: string) => { stmts: ParsedStatement[] }

let parser: Promise<SqlParse> | undefined

// libpg-query is a large WASM module: load it only when the Postgres analyzer runs.
export function loadSqlParser(): Promise<SqlParse> {
  parser ??= import('libpg-query').then(async m => {
    await m.loadModule()
    return (sql: string) => m.parseSync(sql) as unknown as { stmts: ParsedStatement[] }
  })
  return parser
}
