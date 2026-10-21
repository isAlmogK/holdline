import { beforeAll, describe, expect, it } from 'vitest'
import { announceSkip } from '../../testkit/test/helpers.js'
import { failedCases, runTestCommand as run, type Edit } from './helpers/fixture.js'

type Run = Awaited<ReturnType<typeof run>>
type Report = { files: { rule: string; cases: { passed: boolean }[] }[]; infrastructure: { store: string; message: string }[] }

const EMULATOR = 240_000

// The clean run decides whether the emulators can run here; without them every test skips with the reason.
describe('@emulator holdline test on firestore and storage', () => {
  let clean: Run
  let infra: string | undefined
  beforeAll(async () => {
    clean = await run('test-fb')
    const report = JSON.parse(clean.stdout) as Report
    const down = report.infrastructure.find(i => i.store === 'firestore' || i.store === 'storage')
    infra = down?.message
    announceSkip(infra === undefined ? { results: undefined } : { infra })
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
})
