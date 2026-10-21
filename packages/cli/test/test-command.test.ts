import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTestFile, serializeTestFile } from '@holdline/core'
import { describe, expect, it } from 'vitest'
import { copyFixture, failedCases, runTestCommand as run } from './helpers/fixture.js'
import { runCli } from './helpers/project.js'

// Each run boots a WASM Postgres per test file (nine here); allow for parallel-suite load.
const SLOW = 120_000
const MIGRATION = 'supabase/migrations/0001_init.sql'
const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const TSX = join(REPO, 'node_modules/.bin/tsx')
const APPROVE_FIXTURE = join(REPO, 'scripts/approve-fixture.ts')
const ALL = ['R-001', 'R-002', 'R-003', 'R-004', 'R-005', 'R-006', 'R-007', 'R-008', 'R-009']

const rulesOf = (stdout: string) => (JSON.parse(stdout).files as { rule: string }[]).map(f => f.rule)

describe('holdline test on postgres', () => {
  it('runs every postgres case green on the clean schema', async () => {
    const r = await run('test-pg')
    expect(r.code, r.stdout + r.stderr).toBe(0)
    const json = JSON.parse(r.stdout)
    expect(json.infrastructure).toEqual([])
    expect(json.files.map((f: { rule: string; generated: string }) => [f.rule, f.generated])).toEqual(ALL.map(id => [id, 'missing']))
    expect(json.files.every((f: { store: string }) => f.store === 'postgres')).toBe(true)
    expect(json.summary).toEqual({ passed: 24, failed: 0, rules: 9 })
    expect(existsSync(join(r.root, '.holdline/tests/R-004.yaml'))).toBe(true)
    // A second run uses the files it wrote and loads no facts (this facts file does not exist).
    const again = await runCli(['test', '--facts', 'missing.json', '--format', 'json'], { cwd: r.root })
    expect(again.code).toBe(0)
    expect(JSON.parse(again.stdout).files.every((f: { generated?: string }) => f.generated === undefined)).toBe(true)
  }, SLOW)

  it('is red on a loosened policy', async () => {
    const r = await run('test-pg', [[MIGRATION, /for select using \([\s\S]*?\)\);/, 'for select using (true);']])
    expect(r.code).toBe(1)
    expect(failedCases(r)).toEqual([
      ['R-001', 'read: denied without authenticated'],
      ['R-001', 'read: denied without exists(pg:public.memberships?org_id={resource.org_id}&user_id={actor.uid})'],
    ])
  }, SLOW)

  it('is red on a dropped not-null constraint', async () => {
    const r = await run('test-pg', [[MIGRATION, 'org_id uuid not null references public.orgs(id), owner_id', 'org_id uuid references public.orgs(id), owner_id']])
    expect(r.code).toBe(1)
    expect(failedCases(r)).toEqual([['R-004', 'create: rejects org_id null']])
  }, SLOW)

  it('is red on a dropped foreign key', async () => {
    const r = await run('test-pg', [[MIGRATION, 'org_id uuid not null references public.orgs(id), owner_id', 'org_id uuid not null, owner_id']])
    expect(r.code).toBe(1)
    expect(failedCases(r)).toEqual([['R-005', 'create: rejects org_id with no matching public.orgs row']])
  }, SLOW)

  it('is red on a dropped enum check', async () => {
    const r = await run('test-pg', [[MIGRATION, " check (role in ('owner', 'admin', 'member'))", '']])
    expect(r.code).toBe(1)
    expect(failedCases(r)).toEqual([['R-006', "create: rejects role '__holdline_invalid__'"]])
  }, SLOW)

  it('is red on a dropped unique constraint', async () => {
    const r = await run('test-pg', [[MIGRATION, ',\n  unique (org_id, title)', '']])
    expect(r.code).toBe(1)
    expect(failedCases(r)).toEqual([['R-008', 'create: rejects a second row with the same org_id, title']])
  }, SLOW)

  // The primary key references auth.users: the seeded duplicate needs its own key and parent, or the primary key
  // refuses the insert and the case passes without the unique constraint.
  it('is red on a dropped unique column on a table whose primary key is a foreign key', async () => {
    const r = await run('test-pg', [[MIGRATION, 'username text not null unique', 'username text not null']])
    expect(r.code).toBe(1)
    expect(failedCases(r)).toEqual([['R-009', 'create: rejects a second row with the same username']])
  }, SLOW)

  // `using (true)` also lets anonymous callers through, so the authenticated cases fail too.
  it('is red on an owner check dropped from the update and delete policies', async () => {
    const r = await run('test-pg', [
      [MIGRATION, 'for update using (owner_id = auth.uid())', 'for update using (true)'],
      [MIGRATION, 'for delete using (owner_id = auth.uid())', 'for delete using (true)'],
    ])
    expect(r.code).toBe(1)
    expect(failedCases(r)).toEqual([
      ['R-002', 'update: denied without authenticated'],
      ['R-002', 'update: denied without resource.owner_id == actor.uid'],
      ['R-002', 'delete: denied without authenticated'],
      ['R-002', 'delete: denied without resource.owner_id == actor.uid'],
    ])
  }, SLOW)

  it('regenerates a file whose rule changed and says so', async () => {
    const root = await copyFixture('test-pg')
    expect((await runCli(['test', '--facts', 'facts.json', '--rule', 'R-002'], { cwd: root })).code).toBe(0)
    const path = join(root, '.holdline/tests/R-002.yaml')
    await writeFile(path, (await readFile(path, 'utf8')).replace(/^generatedFrom: .*$/m, 'generatedFrom: stale'))
    const r = await runCli(['test', '--facts', 'facts.json', '--format', 'json', '--rule', 'R-001', 'R-002'], { cwd: root })
    expect(r.code, r.stderr).toBe(0)
    expect(JSON.parse(r.stdout).files.map((f: { rule: string; generated?: string }) => [f.rule, f.generated])).toEqual([['R-001', 'missing'], ['R-002', 'changed']])
    expect(await readFile(path, 'utf8')).not.toContain('generatedFrom: stale')
  }, SLOW)

  it('filters by --rule and --store, before generating anything', async () => {
    const byRule = await run('test-pg', [], ['--rule', 'R-003', 'R-006'])
    expect(byRule.code, byRule.stderr).toBe(0)
    expect(rulesOf(byRule.stdout)).toEqual(['R-003', 'R-006'])
    // No facts file: generating a postgres file would need one.
    const root = await copyFixture('test-pg')
    const otherStore = await runCli(['test', '--facts', 'missing.json', '--format', 'json', '--store', 'firestore'], { cwd: root })
    expect(otherStore.code, otherStore.stderr).toBe(0)
    expect(JSON.parse(otherStore.stdout)).toEqual({ files: [], infrastructure: [], summary: { passed: 0, failed: 0, rules: 0 } })
    expect(existsSync(join(root, '.holdline/tests'))).toBe(false)
  }, SLOW)

  it('notes a named rule that is not enforced by test, without running it', async () => {
    const root = await copyFixture('test-pg', [['holdline.rules', /(text: Every project belongs to an org\n)/, '$1    enforce:\n      - static\n']])
    const r = await runCli(['test', '--facts', 'facts.json', '--format', 'json', '--rule', 'R-004', 'R-005'], { cwd: root })
    expect(r.code, r.stderr).toBe(0)
    const files = JSON.parse(r.stdout).files
    expect(files.map((f: { rule: string }) => f.rule)).toEqual(['R-004', 'R-005'])
    expect(files[0]).toEqual({ rule: 'R-004', store: 'postgres', cases: [], skipped: ['not tested: rule is not enforced by test'] })
  }, SLOW)

  it('notes muted rules, rules no cases can be generated for, and orphan test files', async () => {
    const access = [
      '  - id: R-020', '    text: Signed-in users only', '    type: access', '    target:', '      routes: GET /x',
      '    requires:', '      atom:', '        op: authenticated', '    enforce:', '      - test', '    status: approved',
      '    approved:', '      by: fixture', '      at: 2026-10-21', '      hash: unstamped', '',
    ].join('\n')
    const root = await copyFixture('test-pg', [['holdline.rules', /^rules:\n/m, `rules:\n${access}`]])
    execFileSync(TSX, [APPROVE_FIXTURE, join(root, 'holdline.rules')])
    expect((await runCli(['mute', 'R-007', '--reason', 'migrating'], { cwd: root })).code).toBe(0)
    await mkdir(join(root, '.holdline/tests'), { recursive: true })
    const orphan = { rule: 'R-050', generatedFrom: 'h', store: 'postgres' as const, cases: [], skipped: [] }
    await writeFile(join(root, '.holdline/tests/R-050.yaml'), serializeTestFile(orphan))
    const r = await runCli(['test', '--facts', 'facts.json', '--format', 'json'], { cwd: root })
    expect(r.code, r.stderr).toBe(0)
    const files = JSON.parse(r.stdout).files as { rule: string; cases: unknown[]; skipped: string[] }[]
    expect(files.map(f => f.rule)).toEqual(['R-020', ...ALL, 'R-050'])
    const notes = files.filter(f => f.cases.length === 0)
    expect(notes).toEqual([
      { rule: 'R-020', cases: [], skipped: ['not tested: no cases can be generated for access rules'] },
      { rule: 'R-007', store: 'postgres', cases: [], skipped: ['not tested: rule is muted'] },
      { rule: 'R-050', store: 'postgres', cases: [], skipped: ['orphan test file: no approved rule R-050; delete .holdline/tests/R-050.yaml'] },
    ])
  }, SLOW)

  it('exits 2 on an unknown rule, store or format', async () => {
    const root = await copyFixture('test-pg')
    const rule = await runCli(['test', '--rule', 'R-099'], { cwd: root })
    expect([rule.code, rule.stderr]).toEqual([2, 'holdline: no rule R-099\n'])
    const store = await runCli(['test', '--store', 'mongo'], { cwd: root })
    expect(store.code).toBe(2)
    expect(store.stderr).toMatch(/unknown store mongo/)
    const format = await runCli(['test', '--format', 'agent'], { cwd: root })
    expect(format.code).toBe(2)
    expect(format.stderr).toMatch(/unknown format agent/)
  })

  it('exits 2 on a test file that does not parse, naming it', async () => {
    const root = await copyFixture('test-pg')
    await mkdir(join(root, '.holdline/tests'), { recursive: true })
    await writeFile(join(root, '.holdline/tests/R-001.yaml'), 'rule: R-001\ncases: nope\n')
    const r = await runCli(['test', '--facts', 'facts.json'], { cwd: root })
    expect(r.code).toBe(2)
    expect(r.stderr).toMatch(/^holdline: \.holdline\/tests\/R-001\.yaml: /)
  })

  it('exits 3 when there are no migrations', async () => {
    const root = await copyFixture('test-pg')
    await rm(join(root, 'supabase'), { recursive: true })
    const r = await runCli(['test', '--facts', 'facts.json', '--format', 'json', '--rule', 'R-001'], { cwd: root })
    expect(r.code).toBe(3)
    expect(JSON.parse(r.stdout).infrastructure).toEqual([
      { store: 'postgres', message: 'no SQL migrations found (set postgres.migrations in .holdline/config.yaml)' },
    ])
  }, SLOW)

  it('exits 3 when a migration fails', async () => {
    const r = await run('test-pg', [[MIGRATION, 'create table public.orgs', 'create tabel public.orgs']], ['--rule', 'R-001'])
    expect(r.code).toBe(3)
    expect(JSON.parse(r.stdout).infrastructure).toEqual([
      { store: 'postgres', message: expect.stringMatching(/^migration supabase\/migrations\/0001_init\.sql failed: syntax error/) },
    ])
  }, SLOW)

  it('reports a file with no cases with its skipped reasons, without running it', async () => {
    const root = await copyFixture('test-pg')
    await writeFile(join(root, 'empty.json'), '{ "version": 1 }')
    const r = await runCli(['test', '--facts', 'empty.json', '--format', 'json', '--rule', 'R-004'], { cwd: root })
    expect(r.code, r.stderr).toBe(0)
    expect(JSON.parse(r.stdout).files).toEqual([{
      rule: 'R-004', store: 'postgres', generated: 'missing', cases: [],
      skipped: ['table public.projects is not in the facts; run holdline scan, then holdline test --regenerate'],
    }])
  })

  it('exits 3 when a firestore or storage rules file is missing, without starting the emulator', async () => {
    const root = await copyFixture('test-fb')
    await rm(join(root, 'firestore.rules'))
    await rm(join(root, 'storage.rules'))
    const r = await runCli(['test', '--facts', 'facts.json', '--format', 'json', '--rule', 'R-001', 'R-003'], { cwd: root })
    expect(r.code).toBe(3)
    expect(JSON.parse(r.stdout)).toEqual({
      files: [],
      infrastructure: [{ store: 'firestore', message: 'no firestore rules file found' }, { store: 'storage', message: 'no storage rules file found' }],
      summary: { passed: 0, failed: 0, rules: 0 },
    })
  })

  it('generates data-access allow cases that satisfy the policy in the facts', async () => {
    // Without rules files the run stops at infrastructure, after the file is written, without an emulator.
    const root = await copyFixture('test-fb')
    await rm(join(root, 'firestore.rules'))
    const r = await runCli(['test', '--facts', 'facts.json', '--format', 'json', '--rule', 'R-002'], { cwd: root })
    expect(r.code, r.stderr).toBe(3)
    const file = parseTestFile(await readFile(join(root, '.holdline/tests/R-002.yaml'), 'utf8'))
    const data = Object.fromEntries(file.cases.map(c => [c.name, c.do.data]))
    // The create policy also checks status, so every case sends a valid one; deny cases break only the rule's atoms.
    expect(data).toEqual({
      'create: allowed when every condition holds': { orgId: 'value-1', status: 'active' },
      'create: denied without authenticated': { orgId: 'value-1', status: 'active' },
      'create: denied without incoming.orgId in doc(/users/{actor.uid}).orgIds': { orgId: 'other-value', status: 'active' },
    })
  })

  it('--regenerate rebuilds a file the facts have changed for, and marks only changed files', async () => {
    const root = await copyFixture('test-pg')
    expect((await runCli(['approve', 'R-004'], { cwd: root })).code).toBe(0)
    const stuck = await runCli(['test', '--facts', 'facts.json', '--format', 'json', '--rule', 'R-004'], { cwd: root })
    expect(stuck.code, stuck.stderr).toBe(0)
    expect(JSON.parse(stuck.stdout).files).toEqual([{
      rule: 'R-004', store: 'postgres', cases: [],
      skipped: ['table public.projects is not in the facts; run holdline scan, then holdline test --regenerate'],
    }])
    const fixed = await runCli(['test', '--regenerate', '--facts', 'facts.json', '--format', 'json', '--rule', 'R-004'], { cwd: root })
    expect(fixed.code, fixed.stderr).toBe(0)
    const json = JSON.parse(fixed.stdout)
    expect(json.files.map((f: { rule: string; generated?: string; skipped: string[] }) => [f.rule, f.generated, f.skipped])).toEqual([['R-004', 'changed', []]])
    expect(json.summary).toEqual({ passed: 2, failed: 0, rules: 1 })
    const again = await runCli(['test', '--regenerate', '--facts', 'facts.json', '--format', 'json', '--rule', 'R-004'], { cwd: root })
    expect(JSON.parse(again.stdout).files[0].generated).toBeUndefined()
  }, SLOW)

  it('prints a human report', async () => {
    const root = await copyFixture('test-pg', [[MIGRATION, 'org_id uuid not null references public.orgs(id), owner_id', 'org_id uuid references public.orgs(id), owner_id']])
    const r = await runCli(['test', '--facts', 'facts.json', '--rule', 'R-001', 'R-004'], { cwd: root })
    expect(r.code).toBe(1)
    expect(r.stdout).toBe([
      'R-001 postgres: 3 passed (generated: no test file)',
      'R-004 postgres: 1 passed, 1 failed (generated: no test file)',
      '  ✗ create: rejects org_id null: expected reject, got allow',
      '',
      '4 passed, 1 failed in 2 rules',
      '',
    ].join('\n'))
  }, SLOW)
})
