import { PGlite } from '@electric-sql/pglite'
import { describe, expect, it, vi } from 'vitest'
import { runMigrations } from '../src/migrate.js'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

// A shim that fails, standing in for any error before the migrations run (it is never a migration failure).
vi.mock('../src/shim.js', () => ({ SUPABASE_SHIM: 'select holdline_no_such_function();' }))

describe('runMigrations', () => {
  it('closes the database when setting it up throws, then rethrows', async () => {
    const returned: PGlite[] = []
    const create = PGlite.create.bind(PGlite)
    let depth = 0 // PGlite.create may call itself; keep only what the outermost call returns to runMigrations
    const spy = vi.spyOn(PGlite, 'create').mockImplementation(async (...args: Parameters<typeof PGlite.create>) => {
      depth++
      try {
        const db = await create(...args)
        if (depth === 1) returned.push(db)
        return db
      } finally { depth-- }
    })
    try {
      await expect(runMigrations([], 'supabase')).rejects.toThrow(/holdline_no_such_function/)
      expect(returned).toHaveLength(1)
      expect(returned[0]!.closed).toBe(true)
    } finally {
      spy.mockRestore()
      for (const db of returned) if (!db.closed) await db.close()
    }
  })
})
