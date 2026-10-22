import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  approve, factsCachePath, generateTests, parseFacts, reject, serializeTestFile, vocabularyMap, type Facts, type RulesFile,
} from '@holdline/core'
import { UsageError, type Io } from '../io.js'
import { approver, loadPending, loadRules, savePending, saveRules, testsDir, today, writeFileEnsured } from '../workspace.js'

// The facts of the last scan, when there is a readable one: invariant cases need them, and data-access
// allow cases use them to satisfy the op's policy too.
async function cachedFacts(root: string): Promise<Facts | undefined> {
  try {
    return parseFacts(JSON.parse(await readFile(factsCachePath(root), 'utf8')))
  } catch {
    return undefined
  }
}

export async function writeTests(root: string, file: RulesFile, ids: string[]): Promise<void> {
  const vocab = vocabularyMap(file)
  const facts = await cachedFacts(root)
  for (const id of ids) {
    const rule = file.rules.find(r => r.id === id)
    const tests = rule ? generateTests(rule, vocab, facts) : undefined
    if (tests) await writeFileEnsured(join(testsDir(root), `${id}.yaml`), serializeTestFile(tests))
  }
}

export async function approveCommand(keys: string[], opts: { all?: boolean }, io: Io): Promise<number> {
  if (!opts.all && keys.length === 0) throw new UsageError('approve needs keys (P-1, R-003) or --all')
  const pending = await loadPending(io.cwd)
  const file = await loadRules(io.cwd)
  let result: ReturnType<typeof approve>
  try {
    result = approve(file, pending, opts.all ? 'all' : keys, { by: approver(io), at: today(io) })
  } catch (e) {
    throw new UsageError((e as Error).message)
  }
  await saveRules(io.cwd, result.file)
  await savePending(io.cwd, result.pending)
  await writeTests(io.cwd, result.file, result.approved.map(a => a.id))
  io.stdout(`${result.approved.map(a => (a.key === a.id ? `${a.id} re-approved` : `${a.key} → ${a.id}`)).join('\n')}\n`)
  return 0
}

export async function rejectCommand(keys: string[], io: Io): Promise<number> {
  const pending = await loadPending(io.cwd)
  let next: ReturnType<typeof reject>
  try {
    next = reject(pending, keys)
  } catch (e) {
    throw new UsageError((e as Error).message)
  }
  await savePending(io.cwd, next)
  io.stdout(`Rejected ${keys.join(', ')}\n`)
  return 0
}
