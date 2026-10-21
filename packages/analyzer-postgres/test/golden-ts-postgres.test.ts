import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FileCache, listFiles, parseFacts } from '@holdline/core'
import { describe, expect, it, vi } from 'vitest'
import { postgresAnalyzer } from '../src/analyzer.js'
import { readMigrations, runMigrations } from '../src/migrate.js'
import { readTables } from '../src/tables.js'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const app = fileURLToPath(new URL('../../../examples/golden-ts-postgres/', import.meta.url))
const byId = <T extends { id: string }>(xs: T[]) => [...xs].sort((a, b) => a.id.localeCompare(b.id))

describe('golden-ts-postgres', () => {
  it('reads the same tables from the migration as the hand-written facts (without locations)', async () => {
    const expected = parseFacts(JSON.parse(await readFile(`${app}fixtures/facts.json`, 'utf8'))).tables
    const run = await runMigrations(await readMigrations(app, ['prisma/migrations/0001_init/migration.sql']), 'plain')
    try {
      const tables = parseFacts({ version: 1, tables: await readTables(run.db, []) }).tables
      expect(byId(tables)).toEqual(byId(expected).map(({ location: _location, ...t }) => t))
    } finally {
      await run.db.close()
    }
  })

  it('produces the hand-written tables, locations included, through the analyzer', async () => {
    const expected = parseFacts(JSON.parse(await readFile(`${app}fixtures/facts.json`, 'utf8'))).tables
    const files = await listFiles(app)
    expect(await postgresAnalyzer.detect(app, files, {})).toBe(true)
    const cache = new FileCache(await mkdtemp(join(tmpdir(), 'holdline-cache-'))) // keep the repo clean
    const out = await postgresAnalyzer.analyze({ root: app, files, cache, config: {}, recognizers: [] })
    expect(out.diagnostics ?? []).toEqual([])
    expect(byId(parseFacts({ version: 1, tables: out.tables }).tables)).toEqual(byId(expected))
  })
})
