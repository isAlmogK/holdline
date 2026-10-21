import { readFileSync, readdirSync } from 'node:fs'
import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { applyPatch } from './helpers/json-patch.js'
import { makeProject, runCli } from './helpers/project.js'

const golden = fileURLToPath(new URL('../../../examples/golden-ts-postgres/', import.meta.url))

async function goldenProject(): Promise<string> {
  const root = await makeProject({})
  await copyFile(join(golden, 'expected-rules.yaml'), join(root, 'holdline.rules'))
  await copyFile(join(golden, 'fixtures/facts.json'), join(root, 'facts.json'))
  return root
}

describe('golden-ts-postgres', () => {
  it('passes every expected rule on the clean facts', async () => {
    const root = await goldenProject()
    const out = await runCli(['check', '--facts', 'facts.json', '--format', 'json', '--strict'], { cwd: root })
    const parsed = JSON.parse(out.stdout)
    expect(parsed.results.filter((r: { status: string }) => r.status !== 'pass')).toEqual([])
    expect(parsed.summary.pass).toBe(12)
    expect(out.code).toBe(0)
  })

  it('keeps symbol and table locations true to the source', () => {
    const facts = JSON.parse(readFileSync(join(golden, 'fixtures/facts.json'), 'utf8'))
    for (const s of facts.symbols as { id: string; location?: { file: string; line: number } }[]) {
      if (!s.location) continue
      const line = readFileSync(join(golden, s.location.file), 'utf8').split('\n')[s.location.line - 1] ?? ''
      const name = s.id.split('#')[1]!.split('.').pop()!
      expect(line, s.id).toContain(name)
    }
    for (const t of facts.tables as { name: string; location: { file: string; line: number } }[]) {
      const line = readFileSync(join(golden, t.location.file), 'utf8').split('\n')[t.location.line - 1] ?? ''
      expect(line, t.name).toContain(`CREATE TABLE "${t.name.split('.').pop()}"`)
    }
  })

  const breakages = readdirSync(join(golden, 'fixtures/breakages'))
  it('has one breakage per rule', () => {
    expect(breakages.sort()).toEqual(Array.from({ length: 12 }, (_, i) => `R-${String(i + 1).padStart(3, '0')}.json`))
  })

  for (const name of breakages.sort()) {
    it(`catches breakage ${name}`, async () => {
      const breakage = JSON.parse(await readFile(join(golden, 'fixtures/breakages', name), 'utf8'))
      const root = await goldenProject()
      const facts = JSON.parse(await readFile(join(root, 'facts.json'), 'utf8'))
      await writeFile(join(root, 'facts.json'), JSON.stringify(applyPatch(facts, breakage.patch)))
      const out = await runCli(['check', '--facts', 'facts.json', '--format', 'json'], { cwd: root })
      const parsed = JSON.parse(out.stdout)
      expect(parsed.summary.pass).toBe(11)
      expect(parsed.summary.violation).toBe(1)
      const failing = parsed.results.filter((r: { status: string }) => r.status !== 'pass')
      expect(out.code).toBe(1)
      expect([...new Set(failing.map((r: { rule: string }) => r.rule))]).toEqual([breakage.rule])
      expect(failing.every((r: { status: string }) => r.status === 'violation')).toBe(true)
    })
  }
})
