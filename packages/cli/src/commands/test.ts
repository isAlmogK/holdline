import { DataStoreSchema, loadConfig, vocabularyMap, type Facts } from '@holdline/core'
import { formatTestReport, type TestOutput } from '../format/test-report.js'
import { UsageError, type Io } from '../io.js'
import { selectRules, testFiles } from '../test-files.js'
import { loadFacts, loadRules } from '../workspace.js'

export type TestOptions = { rule?: string[]; store?: string; format: string; facts?: string }

export async function testCommand(opts: TestOptions, io: Io): Promise<number> {
  if (!['human', 'json'].includes(opts.format)) throw new UsageError(`unknown format ${opts.format}: use human or json`)
  const store = opts.store === undefined ? undefined : DataStoreSchema.safeParse(opts.store)
  if (store && !store.success) throw new UsageError(`unknown store ${opts.store}: use postgres, firestore or storage`)
  const file = await loadRules(io.cwd)
  const config = await loadConfig(io.cwd)
  const vocab = vocabularyMap(file)
  const missing = (opts.rule ?? []).filter(id => !file.rules.some(r => r.id === id))
  if (missing.length > 0) throw new UsageError(`no rule ${missing.join(', ')}`)

  let facts: Promise<Facts> | undefined
  const lazyFacts = () => (facts ??= loadFacts(io.cwd, opts.facts))
  const selected = (await testFiles(io.cwd, selectRules(file.rules, opts.rule), vocab, lazyFacts))
    .filter(s => !store?.data || s.file.store === store.data)
  const items = selected.map(s => ({ file: s.file, kind: s.rule.type === 'invariant' ? 'invariant' as const : 'access' as const }))

  // PGlite and the Firebase SDK load only when tests run.
  const { runTests } = await import('@holdline/testkit')
  const report = await runTests(io.cwd, config, items)
  const generated = new Map(selected.map(s => [s.rule.id, s.generated]))
  const files = report.files.map(f => {
    const g = generated.get(f.rule)
    return g ? { ...f, generated: g } : f
  })
  const output: TestOutput = { files, infrastructure: report.infrastructure }
  io.stdout(formatTestReport(output, opts.format as 'human' | 'json'))
  if (report.infrastructure.length > 0) return 3
  return files.some(f => f.cases.some(c => !c.passed)) ? 1 : 0
}
