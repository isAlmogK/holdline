import { execFile } from 'node:child_process'
import { cp, mkdtemp } from 'node:fs/promises'
import { existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { runCli } from './project.js'

const examples = fileURLToPath(new URL('../../../../examples/', import.meta.url))

export interface PatchedAppRun {
  root: string
  scan: { code: number; stdout: string; stderr: string }
  check: { code: number; json: { summary: Record<string, number>; results: { rule: string; status: string }[] } }
}

export async function runPatchedApp(appDir: string, patchFile?: string): Promise<PatchedAppRun> {
  const root = await mkdtemp(join(tmpdir(), 'holdline-golden-'))
  await cp(appDir, root, {
    recursive: true,
    filter: src => !/[/\\](breakages|node_modules)([/\\]|$)/.test(src.slice(appDir.length)),
  })
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
  return { root, scan, check: { code: checkOut.code, json: JSON.parse(checkOut.stdout) } }
}

export function goldenApps(): { name: string; dir: string; breakages: string[] }[] {
  return readdirSync(examples)
    .filter(name => name.startsWith('golden-'))
    .map(name => ({ name, dir: join(examples, name) }))
    .filter(app => existsSync(join(app.dir, 'breakages')))
    .map(app => ({
      ...app,
      breakages: readdirSync(join(app.dir, 'breakages')).filter(f => f.endsWith('.patch')).sort().map(f => join(app.dir, 'breakages', f)),
    }))
    .filter(app => app.breakages.length > 0)
}
