import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { goldenApps, runPatchedApp } from './helpers/golden-patch.js'

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
  })

  it('throws when a patch does not apply', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'holdline-patch-'))
    const patch = join(dir, 'bad.patch')
    await writeFile(patch, 'diff --git a/missing.txt b/missing.txt\n--- a/missing.txt\n+++ b/missing.txt\n@@ -1 +1 @@\n-a\n+b\n')
    await expect(runPatchedApp(join(examples, 'golden-firebase'), patch)).rejects.toThrow(/git apply/)
  })
})

const apps = goldenApps()

// Empty until a track adds .patch files; vitest rejects a suite with no tests.
describe.skipIf(apps.length === 0)('golden apps with file-patch breakages', () => {
  for (const app of apps) {
    describe(app.name, () => {
      it('passes every expected rule on the clean app', async () => {
        const out = await runPatchedApp(app.dir)
        expect(out.check.json.results.filter(r => r.status !== 'pass')).toEqual([])
        expect(out.check.code).toBe(0)
      })
      for (const patch of app.breakages) {
        const rule = patch.replace(/^.*\//, '').replace(/\.patch$/, '')
        it(`catches ${rule}`, async () => {
          const out = await runPatchedApp(app.dir, patch)
          const failing = out.check.json.results.filter(r => r.status !== 'pass')
          expect([...new Set(failing.map(r => r.rule))]).toEqual([rule])
          expect(failing.every(r => r.status === 'violation')).toBe(true)
          expect(out.check.code).toBe(1)
        })
      }
    })
  }
})
