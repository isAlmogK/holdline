import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseRulesFile } from '@holdline/core'
import { beforeAll, describe, expect, it } from 'vitest'
import { skipReason } from '../../testkit/test/helpers.js'
import { copyPatchedApp } from './helpers/golden-patch.js'
import { runCli } from './helpers/project.js'

// Spec section 1 item 2: `holdline test` runs every generated case green on each clean golden app, and at least
// one case of each data-access rule red on that rule's breakage (and no case of another rule).

type Report = {
  files: { rule: string; cases: { name: string; passed: boolean }[] }[]
  infrastructure: { store: string; message: string }[]
  summary: { passed: number; failed: number }
}

const examples = fileURLToPath(new URL('../../../examples/', import.meta.url))
const SLOW = 120_000
const EMULATOR = 240_000

async function runTest(app: string, patch?: string): Promise<{ code: number; report: Report; out: string }> {
  const cwd = await copyPatchedApp(join(examples, app), patch)
  const scan = await runCli(['scan'], { cwd })
  expect(scan.code, `holdline scan exited ${scan.code}\n${scan.stderr}`).toBe(0)
  const r = await runCli(['test', '--format', 'json'], { cwd })
  return { code: r.code, report: JSON.parse(r.stdout) as Report, out: r.stdout + r.stderr }
}

const failingRules = (r: Report) => [...new Set(r.files.filter(f => f.cases.some(c => !c.passed)).map(f => f.rule))]

function expectGreen(run: Awaited<ReturnType<typeof runTest>>): void {
  expect(run.report.infrastructure).toEqual([])
  expect(failingRules(run.report), run.out).toEqual([])
  expect(run.report.summary.passed).toBeGreaterThan(0)
  expect(run.code).toBe(0)
}

function expectRed(run: Awaited<ReturnType<typeof runTest>>, rule: string): void {
  expect(run.report.infrastructure).toEqual([])
  expect(failingRules(run.report), run.out).toEqual([rule])
  expect(run.code).toBe(1)
}

// Each data-access rule of the app with its breakage patch, which every such rule must have.
function dataAccessBreakages(app: string): { rule: string; patch: string }[] {
  const rules = parseRulesFile(readFileSync(join(examples, app, 'expected-rules.yaml'), 'utf8')).rules
  return rules.filter(r => r.type === 'data-access').map(r => {
    const patch = join(examples, app, 'breakages', `${r.id}.patch`)
    if (!existsSync(patch)) throw new Error(`${app} has no breakage for data-access rule ${r.id}`)
    return { rule: r.id, patch }
  })
}

describe('holdline test on golden-supabase', () => {
  it('runs every case green on the clean app', async () => {
    expectGreen(await runTest('golden-supabase'))
  }, SLOW)
  for (const { rule, patch } of dataAccessBreakages('golden-supabase')) {
    it(`is red on ${rule} for its breakage`, async () => {
      expectRed(await runTest('golden-supabase', patch), rule)
    }, SLOW)
  }
})

// The clean run decides whether the emulators can run here; without the tools every test skips with the reason.
describe('@emulator holdline test on golden-firebase', () => {
  let clean: Awaited<ReturnType<typeof runTest>>
  let infra: string | undefined
  beforeAll(async () => {
    clean = await runTest('golden-firebase')
    const down = clean.report.infrastructure.find(i => i.store === 'firestore' || i.store === 'storage')
    // Skips only when firebase-tools or Java is missing; any other failure fails the suite here.
    infra = down === undefined ? undefined : skipReason({ infra: down.message })
  }, EMULATOR)

  it('runs every case green on the clean app', ctx => {
    if (infra !== undefined) return ctx.skip(infra)
    expectGreen(clean)
  })
  for (const { rule, patch } of dataAccessBreakages('golden-firebase')) {
    it(`is red on ${rule} for its breakage`, async ctx => {
      if (infra !== undefined) return ctx.skip(infra)
      expectRed(await runTest('golden-firebase', patch), rule)
    }, EMULATOR)
  }
})
