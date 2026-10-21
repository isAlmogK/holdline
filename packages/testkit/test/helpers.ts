import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A temp project directory holding the given files (path → content).
export async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holdline-tk-'))
  for (const [p, c] of Object.entries(files)) {
    await mkdir(join(root, p, '..'), { recursive: true })
    await writeFile(join(root, p), c)
  }
  return root
}

// PGlite boots a WASM Postgres per test; allow for parallel-suite load.
export const SLOW = 30_000
