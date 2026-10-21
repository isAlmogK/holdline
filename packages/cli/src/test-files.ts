// The test files `holdline test` runs (spec 5.1): one per selected rule, regenerated first when it is
// missing, was generated from another version of the rule, or `--regenerate` asks (generation is
// deterministic). Selected rules that cannot run and orphan test files become visible notes.
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  effectiveEnforce, generateTests, hashRule, parseTestFile, serializeTestFile, type DataStore, type Expr, type Facts,
  type Rule, type TestFile,
} from '@holdline/core'
import type { FileReport } from '@holdline/testkit'
import { UsageError } from './io.js'
import { testsDir, writeFileEnsured } from './workspace.js'

export type Selected = { rule: Rule; file: TestFile; generated?: 'missing' | 'changed' }
export type Selection = { tests: Selected[]; notes: FileReport[] }
export type SelectOptions = { only?: string[]; store?: DataStore; regenerate?: boolean }

const storeOf = (rule: Rule): DataStore | undefined => ('store' in rule.target ? rule.target.store : undefined)

// Every `.holdline/tests/*.yaml`, by file name without the extension; a file that does not parse is a usage error.
async function readTestFiles(root: string): Promise<Map<string, TestFile>> {
  let names: string[]
  try {
    names = (await readdir(testsDir(root))).filter(n => n.endsWith('.yaml')).sort()
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return new Map()
    throw e
  }
  const files = new Map<string, TestFile>()
  for (const name of names) {
    const source = `.holdline/tests/${name}`
    try {
      files.set(name.slice(0, -'.yaml'.length), parseTestFile(await readFile(join(testsDir(root), name), 'utf8'), source))
    } catch (e) {
      const message = (e as Error).message
      throw new UsageError(message.startsWith(source) ? message : `${source}: ${message}`)
    }
  }
  return files
}

// The rule's file, regenerated when needed; an unchanged regeneration is not marked. Undefined: no cases possible.
async function testFile(root: string, rule: Rule, vocab: Map<string, Expr>, file: TestFile | undefined, facts: () => Promise<Facts>, regenerate: boolean): Promise<Selected | undefined> {
  const current = file !== undefined && file.rule === rule.id && file.generatedFrom === hashRule(rule, vocab)
  if (current && !regenerate) return { rule, file }
  // Invariant cases need the table or create policy; data-access allow cases also satisfy the op's policy.
  // Other rule types generate nothing, so they never trigger a scan.
  const usesFacts = rule.type === 'invariant' || rule.type === 'data-access'
  const fresh = generateTests(rule, vocab, usesFacts ? await facts() : undefined)
  if (!fresh) return undefined
  const text = serializeTestFile(fresh)
  if (file && serializeTestFile(file) === text) return { rule, file: fresh }
  await writeFileEnsured(join(testsDir(root), `${rule.id}.yaml`), text)
  return { rule, file: fresh, generated: file ? 'changed' : 'missing' }
}

// Without --rule: every rule enforced by test. With it: the named rules. --store filters before any generation.
export async function selectTests(root: string, rules: Rule[], vocab: Map<string, Expr>, facts: () => Promise<Facts>, opts: SelectOptions): Promise<Selection> {
  const existing = await readTestFiles(root)
  const tests: Selected[] = []
  const notes: FileReport[] = []
  const note = (rule: string, store: DataStore | undefined, reason: string) =>
    notes.push({ rule, ...(store ? { store } : {}), cases: [], skipped: [reason] })
  const candidates = rules
    .filter(r => (opts.only ? opts.only.includes(r.id) : effectiveEnforce(r).includes('test')))
    .filter(r => !opts.store || storeOf(r) === opts.store)
  for (const rule of candidates) {
    if (rule.status !== 'approved') { note(rule.id, storeOf(rule), 'not tested: rule is muted'); continue }
    if (!effectiveEnforce(rule).includes('test')) { note(rule.id, storeOf(rule), 'not tested: rule is not enforced by test'); continue }
    const selected = await testFile(root, rule, vocab, existing.get(rule.id), facts, !!opts.regenerate)
    if (selected) tests.push(selected)
    else note(rule.id, storeOf(rule), `not tested: no cases can be generated for ${rule.type} rules`)
  }
  if (!opts.only) {
    for (const [id, file] of existing) {
      if (rules.some(r => r.id === id && r.status === 'approved') || notes.some(n => n.rule === id)) continue
      if (opts.store && file.store !== opts.store) continue
      note(id, file.store, `orphan test file: no approved rule ${id}; delete .holdline/tests/${id}.yaml`)
    }
  }
  return { tests, notes }
}
