import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { main } from '../../src/main.js'

export async function makeProject(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holdline-cli-'))
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }
  return root
}

export async function runCli(argv: string[], opts: { cwd: string; stdin?: string }): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = ''
  let stderr = ''
  const code = await main(argv, {
    cwd: opts.cwd,
    env: { HOLDLINE_USER: 'tester' },
    stdout: t => { stdout += t },
    stderr: t => { stderr += t },
    stdin: opts.stdin === undefined ? undefined : Readable.from([opts.stdin]),
    now: () => new Date('2026-10-21T12:00:00Z'),
  })
  return { code, stdout, stderr }
}
