import type { Analyzer, AnalyzerOutput } from '@holdline/core'
import { detectPostgres, findMigrations } from './detect.js'
import { analyzeMigrations } from './facts.js'
import { readMigrations } from './migrate.js'

const NAME = 'postgres'
const VERSION = '0.1.0' // bump when the output for the same migrations changes

export const postgresAnalyzer: Analyzer = {
  name: NAME,
  version: VERSION,
  detect: (_root, files, config) => detectPostgres(files, config),
  async analyze(ctx): Promise<AnalyzerOutput> {
    const plan = findMigrations(ctx.files, ctx.config)
    if (plan.paths.length === 0) {
      return { diagnostics: [plan.configured
        ? { analyzer: NAME, file: '.holdline/config.yaml', severity: 'error', message: 'postgres.migrations matches no files' }
        : { analyzer: NAME, file: 'prisma/schema.prisma', severity: 'warning', message: 'no SQL migrations found; run prisma migrate or point holdline at a schema dump' }] }
    }
    const migrations = await readMigrations(ctx.root, plan.paths)
    // The whole fact set depends on every migration, so it is cached as one entry.
    const key = JSON.stringify({ dialect: plan.dialect, migrations })
    const cached = await ctx.cache.get<AnalyzerOutput>(NAME, VERSION, key)
    if (cached) return cached
    const out = await analyzeMigrations(migrations, plan.dialect)
    await ctx.cache.set(NAME, VERSION, key, out)
    return out
  },
}
