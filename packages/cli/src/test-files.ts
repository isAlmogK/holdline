// The test files `holdline test` runs (spec 5.1): one per selected rule, regenerated first when it is
// missing or was generated from another version of the rule (generation is deterministic).
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  effectiveEnforce, generateTests, hashRule, parseTestFile, serializeTestFile, type Expr, type Facts, type Rule,
  type TestFile,
} from '@holdline/core'
import { UsageError } from './io.js'
import { testsDir, writeFileEnsured } from './workspace.js'

export type Selected = { rule: Rule; file: TestFile; generated?: 'missing' | 'changed' }

// Approved rules enforced by `test`, in rules-file order, limited to `only` when given.
export function selectRules(rules: Rule[], only?: string[]): Rule[] {
  return rules.filter(r => r.status === 'approved' && effectiveEnforce(r).includes('test') && (!only || only.includes(r.id)))
}

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

export async function testFiles(root: string, rules: Rule[], vocab: Map<string, Expr>, facts: () => Promise<Facts>): Promise<Selected[]> {
  const existing = await readTestFiles(root)
  const selected: Selected[] = []
  for (const rule of rules) {
    const file = existing.get(rule.id)
    if (file && file.rule === rule.id && file.generatedFrom === hashRule(rule, vocab)) {
      selected.push({ rule, file })
      continue
    }
    // Only invariant cases read the facts, so other rules never trigger a scan.
    const fresh = generateTests(rule, vocab, rule.type === 'invariant' ? await facts() : undefined)
    if (!fresh) continue
    await writeFileEnsured(join(testsDir(root), `${rule.id}.yaml`), serializeTestFile(fresh))
    selected.push({ rule, file: fresh, generated: file ? 'changed' : 'missing' })
  }
  return selected
}
