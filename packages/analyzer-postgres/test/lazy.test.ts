import { describe, expect, it, vi } from 'vitest'

// Importing the package must load neither PGlite nor libpg-query: they load when the analyzer runs.
// A factory runs only when its module is imported, so any import of these fails the test.
vi.mock('@electric-sql/pglite', () => { throw new Error('PGlite loaded on import') })
vi.mock('@electric-sql/pglite/contrib/uuid_ossp', () => { throw new Error('uuid_ossp loaded on import') })
vi.mock('@electric-sql/pglite/contrib/pgcrypto', () => { throw new Error('pgcrypto loaded on import') })
vi.mock('libpg-query', () => { throw new Error('libpg-query loaded on import') })

describe('the package entry', () => {
  it('loads neither PGlite nor libpg-query', async () => {
    const mod = await import('../src/index.js')
    expect(mod.postgresAnalyzer.name).toBe('postgres')
  })
})
