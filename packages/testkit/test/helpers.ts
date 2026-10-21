import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { toolsMissing } from '../src/emulator.js'

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

// Shared by every @emulator suite. A suite skips only when the tools are missing (`toolsMissing`): it says why once,
// on stderr (the default reporter hides console output of skipped tests), and each test skips with the reason for
// verbose and CI reporters. Any other infrastructure failure fails the suite with its message.
type Outcome<T> = { results: T } | { infra: string }
export function skipReason(outcome: Outcome<unknown>): string | undefined {
  if (!('infra' in outcome)) return undefined
  if (!toolsMissing(outcome.infra)) throw new Error(`the Firebase emulator could not run the suite: ${outcome.infra}`)
  process.stderr.write(`@emulator tests skipped: ${outcome.infra}\n`)
  return outcome.infra
}
export function resultsOrSkip<T>(outcome: Outcome<T>, ctx: { skip: (note?: string) => void }): T {
  if ('infra' in outcome) {
    if (toolsMissing(outcome.infra)) ctx.skip(outcome.infra)
    throw new Error(`the Firebase emulator could not run the suite: ${outcome.infra}`)
  }
  return outcome.results
}
