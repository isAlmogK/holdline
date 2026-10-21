import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { runOnEmulator } from '../src/emulator.js'
import { bin } from './helpers.js'

// firebase-tools starts the Firestore emulator JVM detached (its own process group) and orphans it when the CLI
// dies. These fakes do the same with `perl -e 'setpgrp'` and record the pids in $REC.
const detached = (code: string, arg = '') =>
  `perl -e 'setpgrp(0, 0); ${code}' ${arg} >/dev/null 2>&1 </dev/null &`

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const input = { firestoreRules: 'x', files: [] }
const recs: string[] = []
const read = async (rec: string) => (await readFile(rec, 'utf8').catch(() => '')).trim().split(/\s+/).filter(Boolean).map(Number)
// Whatever a failing test left running is killed here, so it does not outlive the suite.
afterEach(async () => { for (const pid of (await Promise.all(recs.splice(0).map(read))).flat()) if (alive(pid)) process.kill(pid, 'SIGKILL') })

async function fake(body: string): Promise<{ env: NodeJS.ProcessEnv; pids: () => Promise<number[]> }> {
  const rec = join(await mkdtemp(join(tmpdir(), 'holdline-rec-')), 'pids')
  recs.push(rec)
  const dir = await bin({ firebase: `if [ "$1" = "--version" ]; then exit 0; fi\n${body}`, java: 'exit 0' })
  return { env: { PATH: `${dir}:/usr/bin:/bin`, REC: rec }, pids: () => read(rec) }
}

it('stops the emulator CLI and the processes it detached when the run times out', async () => {
  const { env, pids } = await fake(`${detached('exec "sleep", "300"')}\necho "$$ $!" > "$REC"\necho starting\nsleep 300`)
  const r = await runOnEmulator(input, env, { timeoutMs: 1_000 })
  expect(r).toEqual({ infra: 'the Firebase emulator run timed out after 1 s: starting' })
  const [cli, child] = await pids()
  expect([alive(cli!), alive(child!)]).toEqual([false, false])
}, 15_000)

it('stops a process the CLI left behind when it died', async () => {
  // Like the JVM after `An unexpected error has occurred.`: orphaned, still naming the run's config ($7).
  const { env, pids } = await fake(`${detached('sleep 300', '"$7"')}\necho "$!" > "$REC"\necho "Error: An unexpected error has occurred." >&2\nexit 2`)
  const r = await runOnEmulator(input, env, { timeoutMs: 10_000 })
  expect(r).toEqual({ infra: 'the Firebase emulator did not start: Error: An unexpected error has occurred.' })
  const [orphan] = await pids()
  expect(alive(orphan!)).toBe(false)
}, 15_000)
