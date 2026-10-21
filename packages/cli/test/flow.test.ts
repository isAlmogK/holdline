import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
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
    expect((await runCli(['infer', '--prompt', '--budget', '10', '--facts', 'facts.json'], { cwd: root })).code).toBe(2)
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

  it('propose reads stdin with "-" and reports invalid JSON as a usage error', async () => {
    const root = await makeProject({ 'facts.json': facts })
    expect((await runCli(['propose', '-', '--facts', 'facts.json'], { cwd: root, stdin: proposals })).code).toBe(0)
    expect((await runCli(['propose', '-', '--facts', 'facts.json'], { cwd: root, stdin: 'not json' })).code).toBe(2)
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
  })

  it('scan with no analyzers writes empty facts and says so', async () => {
    const root = await makeProject({ 'src/a.ts': 'export {}' })
    const out = await runCli(['scan'], { cwd: root })
    expect(out.code).toBe(0)
    expect(out.stdout).toContain('No analyzer recognized this project')
    expect(JSON.parse(await readFile(join(root, '.holdline/cache/facts.json'), 'utf8')).version).toBe(1)
  })
})
