import { execFile } from 'node:child_process'
import { cp, mkdtemp } from 'node:fs/promises'
import { existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect } from 'vitest'
import { z } from 'zod'
import { runCli } from './project.js'

const defaultExamples = fileURLToPath(new URL('../../../../examples/', import.meta.url))

const checkJson = z.looseObject({
  summary: z.record(z.string(), z.number()),
  results: z.array(z.looseObject({ rule: z.string(), status: z.string() })),
})

export interface PatchedAppRun {
  root: string
  scan: { code: number; stdout: string; stderr: string }
  check: { code: number; json: { summary: Record<string, number>; results: { rule: string; status: string }[] } }
}

function skipCopy(appDir: string, src: string): boolean {
  const rel = relative(appDir, src)
  if (rel === '') return false
  const parts = rel.split(sep)
  return parts[0] === 'breakages' || parts.includes('node_modules')
}

export async function runPatchedApp(appDir: string, patchFile?: string): Promise<PatchedAppRun> {
  const root = await mkdtemp(join(tmpdir(), 'holdline-golden-'))
  await cp(appDir, root, { recursive: true, filter: src => !skipCopy(appDir, src) })
  await cp(join(appDir, 'expected-rules.yaml'), join(root, 'holdline.rules'))
  if (patchFile) {
    try {
      await promisify(execFile)('git', ['apply', '--whitespace=nowarn', patchFile], { cwd: root })
    } catch (e) {
      throw new Error(`git apply ${patchFile} failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  const scan = await runCli(['scan'], { cwd: root })
  const checkOut = await runCli(['check', '--format', 'json', '--strict'], { cwd: root })
  let json: PatchedAppRun['check']['json']
  try {
    json = checkJson.parse(JSON.parse(checkOut.stdout))
  } catch (e) {
    throw new Error(
      `holdline check did not print valid JSON (exit ${checkOut.code}): ${e instanceof Error ? e.message : String(e)}\nstderr: ${checkOut.stderr}`,
    )
  }
  return { root, scan, check: { code: checkOut.code, json } }
}

function expectScanOk(out: PatchedAppRun): void {
  expect(out.scan.code, `holdline scan exited ${out.scan.code}\nstdout: ${out.scan.stdout}\nstderr: ${out.scan.stderr}`).toBe(0)
}

export function expectClean(out: PatchedAppRun): void {
  expectScanOk(out)
  expect(out.check.json.results.filter(r => r.status !== 'pass')).toEqual([])
  expect(out.check.code).toBe(0)
}

export function expectCaught(out: PatchedAppRun, rule: string): void {
  expectScanOk(out)
  const failing = out.check.json.results.filter(r => r.status !== 'pass')
  expect([...new Set(failing.map(r => r.rule))]).toEqual([rule])
  expect(failing.every(r => r.status === 'violation'), `non-violation results: ${JSON.stringify(failing)}`).toBe(true)
  expect(out.check.code).toBe(1)
}

export function goldenApps(examplesDir: string = defaultExamples): { name: string; dir: string; breakages: string[] }[] {
  return readdirSync(examplesDir)
    .filter(name => name.startsWith('golden-'))
    .map(name => ({ name, dir: join(examplesDir, name) }))
    .filter(app => existsSync(join(app.dir, 'breakages')))
    .map(app => {
      const files = readdirSync(join(app.dir, 'breakages')).filter(f => f !== '.gitkeep').sort()
      const stray = files.filter(f => !f.endsWith('.patch'))
      if (stray.length > 0) {
        throw new Error(`${app.name}/breakages has files that are not *.patch: ${stray.join(', ')}`)
      }
      return { ...app, breakages: files.map(f => join(app.dir, 'breakages', f)) }
    })
    .filter(app => app.breakages.length > 0)
}
