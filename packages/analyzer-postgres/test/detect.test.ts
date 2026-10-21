import { describe, expect, it } from 'vitest'
import { detectPostgres, findMigrations } from '../src/detect.js'

describe('findMigrations', () => {
  it('finds Supabase migrations in sorted order and picks the supabase dialect', () => {
    const files = ['supabase/migrations/002_b.sql', 'supabase/migrations/001_a.sql', 'src/app.ts']
    expect(findMigrations(files, {})).toEqual({
      paths: ['supabase/migrations/001_a.sql', 'supabase/migrations/002_b.sql'], dialect: 'supabase', configured: false,
    })
  })

  it('finds Prisma, Drizzle and plain migration folders with the plain dialect', () => {
    const files = [
      'prisma/migrations/0002_x/migration.sql', 'prisma/migrations/0001_init/migration.sql',
      'drizzle/0000_a.sql', 'migrations/001.sql', 'db/migrations/001.sql', 'db/seed.sql',
    ]
    expect(findMigrations(files, {})).toEqual({
      paths: ['db/migrations/001.sql', 'drizzle/0000_a.sql', 'migrations/001.sql',
        'prisma/migrations/0001_init/migration.sql', 'prisma/migrations/0002_x/migration.sql'],
      dialect: 'plain', configured: false,
    })
  })

  it('uses the configured globs and dialect instead of the defaults', () => {
    const files = ['sql/b.sql', 'sql/a.sql', 'supabase/migrations/001.sql']
    expect(findMigrations(files, { postgres: { migrations: ['sql/*.sql'], dialect: 'supabase' } }))
      .toEqual({ paths: ['sql/a.sql', 'sql/b.sql'], dialect: 'supabase', configured: true })
    expect(findMigrations(files, { postgres: { migrations: ['sql/*.sql'] } }).dialect).toBe('plain')
  })
})

describe('detectPostgres', () => {
  it('runs for migrations, a configured section, or a Prisma schema', () => {
    expect(detectPostgres(['supabase/migrations/001.sql'], {})).toBe(true)
    expect(detectPostgres(['src/app.ts'], { postgres: { migrations: ['none/*.sql'] } })).toBe(true)
    expect(detectPostgres(['prisma/schema.prisma'], {})).toBe(true)
    expect(detectPostgres(['src/app.ts', 'schema.sql'], {})).toBe(false)
  })
})
