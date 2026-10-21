import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { expectCaught, expectClean, goldenApps, runPatchedApp, type PatchedAppRun } from './helpers/golden-patch.js'

const examples = fileURLToPath(new URL('../../../examples/', import.meta.url))

describe('file-patch golden harness', () => {
  it('runs scan and check on an unpatched skeleton', async () => {
    const out = await runPatchedApp(join(examples, 'golden-firebase'))
    expect(out.scan.code).toBe(0)
    expect(out.check.code).toBe(0)
    expect(out.check.json.summary.rules).toBe(0)
  })

  it('applies a patch before scanning', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'holdline-patch-'))
    const patch = join(dir, 'add-note.patch')
    await writeFile(patch, [
      'diff --git a/NOTE.md b/NOTE.md',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/NOTE.md',
      '@@ -0,0 +1 @@',
      '+patched',
      '',
    ].join('\n'))
    const out = await runPatchedApp(join(examples, 'golden-firebase'), patch)
    expect(await readFile(join(out.root, 'NOTE.md'), 'utf8')).toBe('patched\n')
    expect(existsSync(join(out.root, 'breakages'))).toBe(false)
    expect(await readFile(join(out.root, 'holdline.rules'), 'utf8'))
      .toBe(await readFile(join(examples, 'golden-firebase', 'expected-rules.yaml'), 'utf8'))
  })

  it('throws when a patch does not apply', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'holdline-patch-'))
    const patch = join(dir, 'bad.patch')
    await writeFile(patch, 'diff --git a/missing.txt b/missing.txt\n--- a/missing.txt\n+++ b/missing.txt\n@@ -1 +1 @@\n-a\n+b\n')
    await expect(runPatchedApp(join(examples, 'golden-firebase'), patch)).rejects.toThrow(/git apply/)
  })

  it('accepts a trailing slash on the app folder', async () => {
    const out = await runPatchedApp(join(examples, 'golden-firebase') + '/')
    expect(existsSync(join(out.root, 'breakages'))).toBe(false)
    expect(existsSync(join(out.root, 'firestore.rules'))).toBe(true)
  })
})

function run(over: { scan?: number; check?: number; results?: { rule: string; status: string }[] }): PatchedAppRun {
  return {
    root: '/nowhere',
    scan: { code: over.scan ?? 0, stdout: '', stderr: '' },
    check: { code: over.check ?? 0, json: { summary: {}, results: over.results ?? [] } },
  }
}

describe('catch assertions', () => {
  it('expectClean passes a clean run', () => {
    expect(() => expectClean(run({ results: [{ rule: 'R-001', status: 'pass' }] }))).not.toThrow()
  })
  it('expectClean fails on a failing result or a nonzero scan', () => {
    expect(() => expectClean(run({ check: 1, results: [{ rule: 'R-001', status: 'violation' }] }))).toThrow()
    expect(() => expectClean(run({ scan: 3 }))).toThrow(/holdline scan exited 3/)
  })
  it('expectCaught passes when exactly the rule is violated', () => {
    const out = run({ check: 1, results: [{ rule: 'R-001', status: 'violation' }, { rule: 'R-002', status: 'pass' }] })
    expect(() => expectCaught(out, 'R-001')).not.toThrow()
  })
  it('expectCaught fails when the breakage is not caught', () => {
    expect(() => expectCaught(run({ results: [{ rule: 'R-001', status: 'pass' }] }), 'R-001')).toThrow()
  })
  it('expectCaught fails on the wrong rule or an extra rule', () => {
    expect(() => expectCaught(run({ check: 1, results: [{ rule: 'R-002', status: 'violation' }] }), 'R-001')).toThrow()
    const both = run({ check: 1, results: [{ rule: 'R-001', status: 'violation' }, { rule: 'R-002', status: 'violation' }] })
    expect(() => expectCaught(both, 'R-001')).toThrow()
  })
  it('expectCaught fails on stale or unknown instead of violation', () => {
    for (const status of ['stale', 'unknown']) {
      expect(() => expectCaught(run({ check: 1, results: [{ rule: 'R-001', status }] }), 'R-001')).toThrow()
    }
  })
  it('expectCaught fails on a nonzero scan', () => {
    const out = run({ scan: 3, check: 1, results: [{ rule: 'R-001', status: 'violation' }] })
    expect(() => expectCaught(out, 'R-001')).toThrow(/holdline scan exited 3/)
  })
})

describe('goldenApps', () => {
  async function examplesDir(files: string[]): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'holdline-examples-'))
    await mkdir(join(dir, 'golden-x', 'breakages'), { recursive: true })
    for (const f of files) await writeFile(join(dir, 'golden-x', 'breakages', f), '')
    return dir
  }
  it('lists *.patch files and ignores .gitkeep', async () => {
    const dir = await examplesDir(['.gitkeep', 'R-002.patch', 'R-001.patch'])
    expect(goldenApps(dir).map(a => a.breakages.map(b => b.replace(/^.*\//, '')))).toEqual([['R-001.patch', 'R-002.patch']])
  })
  it('skips an app with no patches', async () => {
    expect(goldenApps(await examplesDir(['.gitkeep']))).toEqual([])
  })
  it('throws on a misnamed breakage file', async () => {
    const dir = await examplesDir(['R-001.diff', 'R-002.patch'])
    expect(() => goldenApps(dir)).toThrow(/R-001\.diff/)
  })
})

const apps = goldenApps()

// Empty until a track adds .patch files; vitest rejects a suite with no tests.
describe.skipIf(apps.length === 0)('golden apps with file-patch breakages', () => {
  for (const app of apps) {
    describe(app.name, () => {
      it('passes every expected rule on the clean app', async () => {
        expectClean(await runPatchedApp(app.dir))
      })
      for (const patch of app.breakages) {
        const rule = patch.replace(/^.*\//, '').replace(/\.patch$/, '')
        it(`catches ${rule}`, async () => {
          expectCaught(await runPatchedApp(app.dir, patch), rule)
        })
      }
    })
  }
})
