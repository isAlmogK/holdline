import type { Location } from '@holdline/core'
import type { Migration } from './migrate.js'
import type { SqlParse } from './pgparse.js'
import { kindOf, type SqlNode } from './sql-ast.js'

export interface StatementLocations {
  tables: Map<string, Location> // 'schema.table' → latest CREATE TABLE
  policies: Map<string, Location> // 'schema.table#policy name' → latest CREATE POLICY
}

const relationKey = (rv: SqlNode) => `${rv.schemaname ?? 'public'}.${rv.relname}`

// Locations only: the schema itself always comes from the catalog. A file the parser rejects has no locations
// (applying it reports the error).
export function statementLocations(migrations: readonly Migration[], parse: SqlParse): StatementLocations {
  const out: StatementLocations = { tables: new Map(), policies: new Map() }
  for (const m of migrations) {
    let stmts
    try { stmts = parse(m.sql).stmts } catch { continue }
    const bytes = Buffer.from(m.sql)
    for (const s of stmts) {
      const k = kindOf(s.stmt)
      if (!k) continue
      const at = (): Location => ({ file: m.path, line: lineAt(bytes, s.stmt_location ?? 0) })
      if (k[0] === 'CreateStmt') out.tables.set(relationKey(k[1].relation), at())
      if (k[0] === 'CreatePolicyStmt') out.policies.set(`${relationKey(k[1].table)}#${k[1].policy_name}`, at())
    }
  }
  return out
}

// The 1-based line of the first token at or after a byte offset (skipping whitespace and comments).
function lineAt(bytes: Buffer, offset: number): number {
  let i = offset
  for (;;) {
    while (i < bytes.length && (bytes[i] === 32 || (bytes[i]! >= 9 && bytes[i]! <= 13))) i++
    if (bytes[i] === 45 && bytes[i + 1] === 45) { while (i < bytes.length && bytes[i] !== 10) i++; continue }
    if (bytes[i] === 47 && bytes[i + 1] === 42) { const end = bytes.indexOf('*/', i + 2); i = end < 0 ? bytes.length : end + 2; continue }
    break
  }
  return bytes.subarray(0, i).toString().split('\n').length
}
