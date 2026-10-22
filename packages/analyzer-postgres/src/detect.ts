import { matchFiles, type HoldlineConfig } from '@holdline/core'

export type Dialect = 'supabase' | 'plain'

const SUPABASE = 'supabase/migrations/*.sql'
const DEFAULT_GLOBS = [SUPABASE, 'prisma/migrations/*/migration.sql', 'drizzle/*.sql', 'migrations/*.sql', 'db/migrations/*.sql']

export interface MigrationPlan {
  paths: string[] // in apply order: every supported tool names migrations so that sorted order is apply order
  dialect: Dialect
  configured: boolean // postgres.migrations is set in .holdline/config.yaml
}

export function findMigrations(files: readonly string[], config: HoldlineConfig): MigrationPlan {
  const section = config.postgres ?? {}
  const configured = section.migrations !== undefined
  const paths = matchFiles(files, section.migrations ?? DEFAULT_GLOBS)
  const dialect = section.dialect ?? (matchFiles(paths, [SUPABASE]).length > 0 ? 'supabase' : 'plain')
  return { paths, dialect, configured }
}

// A Prisma schema without migrations still runs the analyzer, so it can say why there are no tables.
export function detectPostgres(files: readonly string[], config: HoldlineConfig): boolean {
  const plan = findMigrations(files, config)
  return plan.configured || plan.paths.length > 0 || files.includes('prisma/schema.prisma')
}
