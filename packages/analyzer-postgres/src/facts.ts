import type { PGlite } from '@electric-sql/pglite'
import type { AnalyzerOutput, SymbolFact } from '@holdline/core'
import { readCatalog } from './catalog.js'
import type { Dialect } from './detect.js'
import { statementLocations } from './locations.js'
import { runMigrations, type Migration } from './migrate.js'
import { normalizeCondition } from './normalize.js'
import { loadSqlParser } from './pgparse.js'
import { buildPolicies } from './policies.js'

// Facts from a database the migrations were applied to. Locations come from the migration texts.
export async function factsFromDatabase(db: PGlite, dialect: Dialect, migrations: readonly Migration[]): Promise<AnalyzerOutput> {
  const catalog = await readCatalog(db, dialect)
  const parse = await loadSqlParser()
  const where = statementLocations(migrations, parse)
  const supabase = dialect === 'supabase'
  const { policies, diagnostics } = buildPolicies(
    catalog.policies, dialect,
    (sql, table, side) => normalizeCondition(sql, { table, side, catalog, parse, supabase }),
    row => where.policies.get(`${row.schema}.${row.table}#${row.name}`),
  )
  const tables = catalog.tables.map(t => {
    const location = where.tables.get(t.name)
    return location ? { ...t, location } : t
  })
  const symbols: SymbolFact[] = tables.map(t => ({ id: t.id, kind: 'table', lang: 'sql', ...(t.location ? { location: t.location } : {}) }))
  const seen = new Set<string>()
  for (const p of policies) {
    if (seen.has(p.id)) continue
    seen.add(p.id)
    symbols.push({ id: p.id, kind: 'policy', lang: 'sql', ...(p.evidence ? { location: p.evidence } : {}) })
  }
  return { tables, symbols, policies, diagnostics }
}

export async function analyzeMigrations(migrations: readonly Migration[], dialect: Dialect): Promise<AnalyzerOutput> {
  const run = await runMigrations(migrations, dialect)
  try {
    if (run.failure) {
      return { diagnostics: [{ analyzer: 'postgres', file: run.failure.file, severity: 'error', message: run.failure.message }] }
    }
    return await factsFromDatabase(run.db, dialect, migrations)
  } finally {
    await run.db.close()
  }
}
