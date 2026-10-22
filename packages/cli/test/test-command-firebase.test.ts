import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { generateTests, parseRulesFile, serializeTestFile, vocabularyMap } from '@holdline/core'
import { beforeAll, describe, expect, it } from 'vitest'
import { skipReason } from '../../testkit/test/helpers.js'
import { copyFixture, failedCases, runTestCommand as run, type Edit } from './helpers/fixture.js'
import { runCli } from './helpers/project.js'

type Run = Awaited<ReturnType<typeof run>>
type Report = { files: { rule: string; cases: { passed: boolean }[] }[]; infrastructure: { store: string; message: string }[] }

const EMULATOR = 240_000

// The clean run decides whether the emulators can run here; without the tools every test skips with the reason.
describe('@emulator holdline test on firestore and storage', () => {
  let clean: Run
  let infra: string | undefined
  beforeAll(async () => {
    clean = await run('test-fb')
    const report = JSON.parse(clean.stdout) as Report
    const down = report.infrastructure.find(i => i.store === 'firestore' || i.store === 'storage')
    // Skips only when firebase-tools or Java is missing; any other failure fails the suite here.
    infra = down === undefined ? undefined : skipReason({ infra: down.message })
  }, EMULATOR)

  const red = async (ctx: { skip: (note?: string) => void }, edits: Edit[]) => {
    if (infra !== undefined) ctx.skip(infra)
    return run('test-fb', edits)
  }

  it('runs every case green on the clean rules', ctx => {
    if (infra !== undefined) return ctx.skip(infra)
    expect(clean.code, clean.stdout + clean.stderr).toBe(0)
    const report = JSON.parse(clean.stdout) as Report
    expect(report.infrastructure).toEqual([])
    expect(report.files.map(f => [f.rule, f.cases.length, f.cases.every(c => c.passed)])).toEqual([
      ['R-001', 3, true], ['R-002', 3, true], ['R-003', 3, true], ['R-004', 2, true],
    ])
  })

  it('is red on a loosened firestore read rule', async ctx => {
    const r = await red(ctx, [['firestore.rules', /allow read: if request\.auth != null\n\s*&& exists\([^\n]*\);/, 'allow read: if request.auth != null;']])
    expect(r.code, r.stderr).toBe(1)
    expect(failedCases(r)).toEqual([['R-001', 'read: denied without exists(/orgs/{resource.orgId}/members/{actor.uid})']])
  }, EMULATOR)

  it('is red on a storage read that no longer checks the membership', async ctx => {
    const r = await red(ctx, [['storage.rules', /allow get: if request\.auth != null\n\s*&& firestore\.exists\([^\n]*\);/, 'allow get: if request.auth != null;']])
    expect(r.code, r.stderr).toBe(1)
    expect(failedCases(r)).toEqual([['R-003', 'read: denied without exists(/orgs/{param.orgId}/members/{actor.uid})']])
  }, EMULATOR)

  it('is red on a create rule without the status check', async ctx => {
    const r = await red(ctx, [['firestore.rules', "\n        && request.resource.data.status in ['active', 'archived']", '']])
    expect(r.code, r.stderr).toBe(1)
    expect(failedCases(r)).toEqual([['R-004', "create: denied with status '__holdline_invalid__'"]])
  }, EMULATOR)

  it('stays red on a test file generated against older facts until --regenerate', async ctx => {
    if (infra !== undefined) return ctx.skip(infra)
    const root = await copyFixture('test-fb')
    // Same rule hash, but the allow case was built without the create policy: it sends no status.
    const file = parseRulesFile(await readFile(join(root, 'holdline.rules'), 'utf8'))
    const stale = generateTests(file.rules.find(r => r.id === 'R-002')!, vocabularyMap(file))!
    await mkdir(join(root, '.holdline/tests'), { recursive: true })
    await writeFile(join(root, '.holdline/tests/R-002.yaml'), serializeTestFile(stale))

    const red = await runCli(['test', '--facts', 'facts.json', '--rule', 'R-002'], { cwd: root })
    expect(red.code, red.stderr).toBe(1)
    expect(red.stdout).toContain('✗ create: allowed when every condition holds: expected allow, got deny')
    expect(red.stdout).toContain('after changing policies run holdline test --regenerate')

    const green = await runCli(['test', '--regenerate', '--facts', 'facts.json', '--format', 'json', '--rule', 'R-002'], { cwd: root })
    expect(green.code, green.stdout).toBe(0)
    expect(JSON.parse(green.stdout).files.map((f: { rule: string; generated?: string }) => [f.rule, f.generated])).toEqual([['R-002', 'refreshed']])
  }, EMULATOR)
})
