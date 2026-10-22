export { postgresAnalyzer } from './analyzer.js'
export { detectPostgres, findMigrations, type Dialect, type MigrationPlan } from './detect.js'
export { analyzeMigrations, factsFromDatabase } from './facts.js'
export { applyMigrations, readMigrations, runMigrations, type Migration, type MigrationFailure, type MigrationRun } from './migrate.js'
