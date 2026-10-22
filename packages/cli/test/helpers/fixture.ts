import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCli } from './project.js'

const fixtures = fileURLToPath(new URL('../fixtures/', import.meta.url))

// A text change to one file of the copied fixture; the `from` text must be in the file.
export type Edit = [path: string, from: string | RegExp, to: string]

export async function copyFixture(name: string, edits: Edit[] = []): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `holdline-${name}-`))
  await cp(join(fixtures, name), root, { recursive: true })
  for (const [path, from, to] of edits) {
    const text = await readFile(join(root, path), 'utf8')
    const next = text.replace(from, to)
    if (next === text) throw new Error(`edit of ${path} changed nothing: ${String(from)}`)
    await writeFile(join(root, path), next)
  }
  return root
}

export async function runTestCommand(name: string, edits: Edit[] = [], args: string[] = []) {
  const root = await copyFixture(name, edits)
  const r = await runCli(['test', '--facts', 'facts.json', '--format', 'json', ...args], { cwd: root })
  return { ...r, root }
}

type Json = { files: { rule: string; cases: { name: string; passed: boolean }[] }[] }

// [rule, case name] of every failed case.
export function failedCases(r: { stdout: string }): [string, string][] {
  const json = JSON.parse(r.stdout) as Json
  return json.files.flatMap(f => f.cases.filter(c => !c.passed).map(c => [f.rule, c.name] as [string, string]))
}
