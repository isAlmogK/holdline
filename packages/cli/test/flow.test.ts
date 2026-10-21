import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { copyFixture } from './helpers/fixture.js'
import { makeProject, runCli } from './helpers/project.js'

const facts = JSON.stringify({
  version: 1,
  symbols: [
    { id: 'h:transfer', kind: 'function', lang: 'ts', location: { file: 'src/dogs.ts', line: 40 } },
    { id: 'h:archive', kind: 'function', lang: 'ts', location: { file: 'src/dogs.ts', line: 60 } },
  ],
  routes: [
    { id: 'route:POST /dogs/:id/transfer', method: 'POST', path: '/dogs/:id/transfer', handler: 'h:transfer', framework: 'express' },
    { id: 'route:POST /dogs/:id/archive', method: 'POST', path: '/dogs/:id/archive', handler: 'h:archive', framework: 'express' },
  ],
  guards: [{ at: 'h:transfer', requires: { ref: 'staff' } }],
  policies: [{ id: 'firestore:/dogs/{d}#read', store: 'firestore', target: '/dogs/{d}', ops: ['read'], condition: { atom: { op: 'authenticated' } }, evidence: { file: 'firestore.rules', line: 5 } }],
})

const proposals = JSON.stringify({
  vocabulary: [{ id: 'staff', text: 'Caller is staff', expr: { atom: { op: 'in', left: 'actor.role', right: { literal: ['admin'] } } } }],
  rules: [
    { text: 'Only staff transfer dogs', type: 'access', target: { routes: 'POST /dogs/*/transfer' }, requires: { ref: 'staff' }, evidence: ['h:transfer'] },
    { text: 'Only staff archive dogs', type: 'access', target: { routes: 'POST /dogs/*/archive' }, requires: { ref: 'staff' }, evidence: ['h:archive'] },
    { text: 'Signed-in users read dogs', type: 'data-access', target: { store: 'firestore', path: '/dogs/{dogId}' }, ops: ['read'], requires: { atom: { op: 'authenticated' } }, evidence: ['firestore:/dogs/{d}#read'] },
    { text: 'Cats', type: 'access', target: { routes: 'GET /cats' }, requires: { atom: { op: 'authenticated' } } },
  ],
})

describe('inference flow', () => {
  it('infer --prompt prints the prompt and requires --prompt', async () => {
    const root = await makeProject({ 'facts.json': facts })
    const out = await runCli(['infer', '--prompt', '--facts', 'facts.json'], { cwd: root })
    expect(out.code).toBe(0)
    expect(out.stdout).toContain('POST /dogs/:id/transfer')
    expect((await runCli(['infer', '--facts', 'facts.json'], { cwd: root })).code).toBe(2)
  })

  it('infer --prompt with a too-small budget is a usage error', async () => {
    const root = await makeProject({ 'facts.json': facts })
    const out = await runCli(['infer', '--prompt', '--budget', '10', '--facts', 'facts.json'], { cwd: root })
    expect(out.code).toBe(2)
    expect(out.stderr).toContain('raise --budget')
  })

  it('--limit and --budget must be positive integers', async () => {
    const root = await makeProject({ 'facts.json': facts, 'proposals.json': proposals })
    expect((await runCli(['propose', 'proposals.json', '--facts', 'facts.json', '--limit', 'abc'], { cwd: root })).code).toBe(2)
    expect((await runCli(['infer', '--prompt', '--budget', '0', '--facts', 'facts.json'], { cwd: root })).code).toBe(2)
  })

  it('proposing the same file twice reports skipped duplicates', async () => {
    const root = await makeProject({ 'facts.json': facts, 'proposals.json': proposals })
    await runCli(['propose', 'proposals.json', '--facts', 'facts.json'], { cwd: root })
    const again = await runCli(['propose', 'proposals.json', '--facts', 'facts.json'], { cwd: root })
    expect(again.code).toBe(0)
    expect(again.stdout).toContain('skipped  ')
    expect(again.stdout).not.toContain('P-4')
    expect(await readFile(join(root, '.holdline/pending.yaml'), 'utf8')).not.toContain('key: P-4')
  })

  it('propose → approve → check, with generated tests', async () => {
    const root = await makeProject({ 'facts.json': facts, 'proposals.json': proposals })
    const proposed = await runCli(['propose', 'proposals.json', '--facts', 'facts.json'], { cwd: root })
    expect(proposed.code).toBe(0)
    expect(proposed.stdout).toContain('P-1 broken  Only staff archive dogs')
    expect(proposed.stdout).toContain('rejected  Cats: target not found')

    const approved = await runCli(['approve', '--all'], { cwd: root })
    expect(approved.code).toBe(0)
    expect(approved.stdout).toContain('P-1 → R-001')
    const rules = await readFile(join(root, 'holdline.rules'), 'utf8')
    expect(rules).toContain('by: tester')
    expect(rules).toContain('id: staff')
    expect(await readdir(join(root, '.holdline/tests'))).toEqual(['R-003.yaml'])

    const check = await runCli(['check', '--facts', 'facts.json'], { cwd: root })
    expect(check.code).toBe(1)
    expect(check.stdout).toContain('POST /dogs/:id/archive does not check staff')
  })

  it('an edited approved vocabulary entry fails check until approve vocabulary:<id>', async () => {
    const root = await makeProject({ 'facts.json': facts, 'proposals.json': proposals })
    await runCli(['propose', 'proposals.json', '--facts', 'facts.json'], { cwd: root })
    await runCli(['approve', '--all'], { cwd: root })
    const rulesFile = join(root, 'holdline.rules')
    const original = await readFile(rulesFile, 'utf8')
    expect(original).toMatch(/approved:\n\s+by: tester/)

    await writeFile(rulesFile, original.replace('recognize: []', 'recognize:\n      - symbol: h:transfer'))
    const recognized = await runCli(['check', '--facts', 'facts.json', '--format', 'agent'], { cwd: root })
    expect(recognized.code).toBe(1)
    expect(recognized.stdout).toContain('- vocabulary:staff "Caller is staff": this vocabulary entry was changed in holdline.rules without approval. Undo your change to it; only the user approves rule changes (they can run holdline approve vocabulary:staff).')
    const reapproved = await runCli(['approve', 'vocabulary:staff'], { cwd: root })
    expect(reapproved.code).toBe(0)
    expect(reapproved.stdout).toContain('vocabulary:staff re-approved')
    const after = JSON.parse((await runCli(['check', '--facts', 'facts.json', '--format', 'json'], { cwd: root })).stdout)
    expect(after.results.filter((r: { rule: string }) => r.rule === 'vocabulary:staff')).toEqual([])

    await writeFile(rulesFile, original.replace('- admin', '- owner'))
    const exprEdit = JSON.parse((await runCli(['check', '--facts', 'facts.json', '--format', 'json'], { cwd: root })).stdout)
    expect(exprEdit.results.filter((r: { status: string }) => r.status === 'unapproved-edit').map((r: { rule: string }) => r.rule))
      .toContain('vocabulary:staff')
    expect((await runCli(['check', '--facts', 'facts.json'], { cwd: root })).code).toBe(1)
  })

  it('propose reads stdin with "-" and reports invalid JSON as a usage error', async () => {
    const root = await makeProject({ 'facts.json': facts })
    expect((await runCli(['propose', '-', '--facts', 'facts.json'], { cwd: root, stdin: proposals })).code).toBe(0)
    expect((await runCli(['propose', '-', '--facts', 'facts.json'], { cwd: root, stdin: 'not json' })).code).toBe(2)
  })

  it('exits 2 on a malformed pending file and on a missing proposals file', async () => {
    const root = await makeProject({ 'facts.json': facts, '.holdline/pending.yaml': 'rules: [' })
    const bad = await runCli(['approve', 'P-1'], { cwd: root })
    expect(bad.code).toBe(2)
    expect(bad.stderr).toContain('.holdline/pending.yaml: invalid YAML')
    const root2 = await makeProject({ 'facts.json': facts, '.holdline/pending.yaml': 'version: 1\nrules: [{ key: nope }]' })
    expect((await runCli(['review'], { cwd: root2, stdin: 'q\n' })).code).toBe(2)
    const missing = await runCli(['propose', 'missing.json', '--facts', 'facts.json'], { cwd: root })
    expect(missing.code).toBe(2)
    expect(missing.stderr).toContain('proposals file not found: missing.json')
  })

  it('reject removes pending rules', async () => {
    const root = await makeProject({ 'facts.json': facts, 'proposals.json': proposals })
    await runCli(['propose', 'proposals.json', '--facts', 'facts.json'], { cwd: root })
    expect((await runCli(['reject', 'P-1'], { cwd: root })).code).toBe(0)
    const out = await runCli(['approve', 'P-1'], { cwd: root })
    expect(out.code).toBe(2)
  })

  it('review approves, rejects and skips from answers on stdin', async () => {
    const root = await makeProject({ 'facts.json': facts, 'proposals.json': proposals })
    await runCli(['propose', 'proposals.json', '--facts', 'facts.json'], { cwd: root })
    const out = await runCli(['review'], { cwd: root, stdin: 'a\nr\ns\n' })
    expect(out.code).toBe(0)
    expect(out.stdout).toContain('Approved P-1 as R-001')
    expect(out.stdout).toContain('Rejected P-2')
    const pending = await readFile(join(root, '.holdline/pending.yaml'), 'utf8')
    expect(pending).toContain('key: P-3')
    expect(await readFile(join(root, 'holdline.rules'), 'utf8')).toContain('id: R-001')
    await expect(readdir(join(root, '.holdline/tests'))).rejects.toThrow()
  })

  it('review re-asks on unrecognized answers and saves each decision', async () => {
    const root = await makeProject({ 'facts.json': facts, 'proposals.json': proposals })
    await runCli(['propose', 'proposals.json', '--facts', 'facts.json'], { cwd: root })
    const out = await runCli(['review'], { cwd: root, stdin: 'y\na\nq\n' })
    expect(out.code).toBe(0)
    expect(out.stdout).toContain('answer a, r, s or q')
    expect(out.stdout).toContain('Approved P-1 as R-001')
    expect(out.stdout).not.toContain('P-2 ?')
    expect(await readFile(join(root, 'holdline.rules'), 'utf8')).toContain('id: R-001')
    expect(await readFile(join(root, '.holdline/pending.yaml'), 'utf8')).toContain('key: P-2')
  })

  it('scan with no analyzers writes empty facts and says so', async () => {
    const root = await makeProject({ 'src/a.ts': 'export {}' })
    const out = await runCli(['scan'], { cwd: root })
    expect(out.code).toBe(0)
    expect(out.stdout).toContain('No analyzer recognized this project')
    expect(JSON.parse(await readFile(join(root, '.holdline/cache/facts.json'), 'utf8')).version).toBe(1)
  })

  it('approve generates invariant cases from the cached facts of the last scan', async () => {
    const root = await copyFixture('test-pg')
    const without = await runCli(['approve', 'R-004'], { cwd: root })
    expect(without.code, without.stderr).toBe(0)
    expect(await readFile(join(root, '.holdline/tests/R-004.yaml'), 'utf8')).toContain('is not in the facts')
    await mkdir(join(root, '.holdline/cache'), { recursive: true })
    await copyFile(join(root, 'facts.json'), join(root, '.holdline/cache/facts.json'))
    expect((await runCli(['approve', 'R-004'], { cwd: root })).code).toBe(0)
    const tests = await readFile(join(root, '.holdline/tests/R-004.yaml'), 'utf8')
    expect(tests).toContain('name: "create: rejects org_id null"')
    expect(tests).toContain('skipped: []')
  })
})
