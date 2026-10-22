// Runs test files on their store's runner (spec 5.1): Postgres files each on a fresh PGlite, Firestore and
// Storage files in one emulator run. A runner that cannot start is an infrastructure failure, not a case result.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { applyMigrations, type MigrationRun } from '@holdline/analyzer-postgres'
import type { HoldlineConfig, TestFile } from '@holdline/core'
import { runOnEmulator } from './emulator.js'
import { resolveRulesFile } from './firebase-rules.js'
import type { FirebaseInput } from './firebase-runner.js'
import { prepareRoles } from './pg-actor.js'
import { runPostgresFile, type CaseKind } from './pg-runner.js'
import type { CaseResult, FileReport, InfraFailure, TestReport } from './report.js'

export type TestItem = { file: TestFile; kind: CaseKind }

export const NO_MIGRATIONS = 'no SQL migrations found (set postgres.migrations in .holdline/config.yaml)'

const report = (file: TestFile, cases: CaseResult[] = []): FileReport =>
  ({ rule: file.rule, store: file.store, cases, skipped: file.skipped })

export async function runTests(root: string, config: HoldlineConfig, items: TestItem[]): Promise<TestReport> {
  const results = new Map<TestItem, CaseResult[]>()
  const infrastructure: InfraFailure[] = []
  const runnable = items.filter(i => i.file.cases.length > 0)
  const postgres = runnable.filter(i => i.file.store === 'postgres')
  if (postgres.length > 0) {
    const infra = await runPostgres(root, config, postgres, results)
    if (infra) infrastructure.push({ store: 'postgres', message: infra })
  }
  const firebase = runnable.filter(i => i.file.store !== 'postgres')
  if (firebase.length > 0) infrastructure.push(...await runFirebase(root, config, firebase, results))
  // A file whose store could not run is left out of the files: its cases did not pass or fail.
  const failedStores = new Set(infrastructure.map(i => i.store))
  const files = items
    .filter(i => i.file.cases.length === 0 || !failedStores.has(i.file.store))
    .map(i => report(i.file, results.get(i)))
  return { files, infrastructure }
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

async function runPostgres(root: string, config: HoldlineConfig, items: TestItem[], out: Map<TestItem, CaseResult[]>): Promise<string | undefined> {
  for (const item of items) {
    let migrated: MigrationRun
    try {
      migrated = await applyMigrations(root, config)
    } catch (e) {
      return `the Postgres runner could not start: ${message(e)}`
    }
    const { db, dialect, migrations, failure } = migrated
    try {
      if (migrations.length === 0) return NO_MIGRATIONS
      if (failure) return `migration ${failure.file} failed: ${failure.message}`
      await prepareRoles(db, dialect)
      out.set(item, await runPostgresFile(db, item.file, item.kind, dialect))
    } catch (e) {
      return `the Postgres runner failed: ${message(e)}`
    } finally {
      await db.close().catch(() => undefined)
    }
  }
  return undefined
}

async function rules(root: string, path: string | undefined): Promise<string | undefined> {
  return path === undefined ? undefined : readFile(join(root, path), 'utf8')
}

async function runFirebase(root: string, config: HoldlineConfig, items: TestItem[], out: Map<TestItem, CaseResult[]>): Promise<InfraFailure[]> {
  const infrastructure: InfraFailure[] = []
  const firestoreRules = await rules(root, await resolveRulesFile(root, config, 'firestore'))
  const hasStorage = items.some(i => i.file.store === 'storage')
  const storageRules = hasStorage ? await rules(root, await resolveRulesFile(root, config, 'storage')) : undefined
  // Never run Firestore files without Firestore rules: a running emulator would keep the rules it has.
  if (items.some(i => i.file.store === 'firestore') && firestoreRules === undefined) {
    infrastructure.push({ store: 'firestore', message: 'no firestore rules file found' })
  }
  if (hasStorage && storageRules === undefined) infrastructure.push({ store: 'storage', message: 'no storage rules file found' })
  const blocked = new Set(infrastructure.map(i => i.store))
  const runnable = items.filter(i => !blocked.has(i.file.store))
  if (runnable.length === 0) return infrastructure
  // Storage rules only when storage files run (an in-process run needs the Storage emulator for them).
  // Storage rules read Firestore (firestore.exists/get), so storage runs also load the Firestore rules.
  const input: FirebaseInput = {
    ...(firestoreRules !== undefined ? { firestoreRules } : {}),
    ...(storageRules !== undefined && runnable.some(i => i.file.store === 'storage') ? { storageRules } : {}),
    files: runnable.map(i => i.file),
  }
  const outcome = await runOnEmulator(input)
  if ('infra' in outcome) {
    for (const store of new Set(runnable.map(i => i.file.store))) infrastructure.push({ store, message: outcome.infra })
    return infrastructure
  }
  // A rule the worker did not answer for means the run broke: its cases did not pass or fail.
  for (const item of runnable) {
    const cases = outcome.results[item.file.rule]
    if (cases) out.set(item, cases)
    else infrastructure.push({ store: item.file.store, message: `the emulator worker returned no results for ${item.file.rule}` })
  }
  return infrastructure
}
