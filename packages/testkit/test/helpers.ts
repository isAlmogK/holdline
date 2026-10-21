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

// Shared by every @emulator suite: say once, on stderr (the default reporter hides console output of
// skipped tests), why the suite is skipped, and skip each test with the reason for verbose and CI reporters.
type Outcome<T> = { results: T } | { infra: string }
export function announceSkip(outcome: Outcome<unknown>): void {
  if ('infra' in outcome) process.stderr.write(`@emulator tests skipped: ${outcome.infra}\n`)
}
export function resultsOrSkip<T>(outcome: Outcome<T>, ctx: { skip: (note?: string) => void }): T {
  if ('infra' in outcome) { ctx.skip(outcome.infra); throw new Error('unreachable') }
  return outcome.results
}
