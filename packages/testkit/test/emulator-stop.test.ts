import { execFileSync, spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { runOnEmulator } from '../src/emulator.js'
import { bin, FAKE_CLI, removeScratch, scratch } from './helpers.js'

// firebase-tools starts the Firestore emulator JVM detached (its own process group) and orphans it when the CLI
// dies. These fakes do the same with `perl -e 'setpgrp'` and record the pids in $REC.
const detached = (code: string, arg = '') =>
  `perl -e 'setpgrp(0, 0); ${code}' ${arg} >/dev/null 2>&1 </dev/null &`

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const args = (pid: number) => { try { return execFileSync('ps', ['-o', 'args=', '-p', String(pid)]).toString() } catch { return '' } }
const input = { firestoreRules: 'x', files: [] }
const recs: string[] = []
const read = async (rec: string) => (await readFile(rec, 'utf8').catch(() => '')).trim().split(/\s+/).filter(Boolean).map(Number)
// Whatever a failing test left running is killed here (only while the pid is still one of the fakes).
afterEach(async () => {
  for (const pid of (await Promise.all(recs.splice(0).map(read))).flat()) {
    if (/sleep|holdline-bin-/.test(args(pid))) process.kill(pid, 'SIGKILL')
  }
  await removeScratch()
})

async function fake(body: string): Promise<{ env: NodeJS.ProcessEnv; pids: () => Promise<number[]> }> {
  const rec = join(await scratch('holdline-rec-'), 'pids')
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
}, FAKE_CLI)

it('stops a process the CLI left behind when it died', async () => {
  // Like the JVM after `An unexpected error has occurred.`: orphaned, still naming the run's config ($7).
  const { env, pids } = await fake(`${detached('sleep 300', '"$7"')}\necho "$!" > "$REC"\necho "Error: An unexpected error has occurred." >&2\nexit 2`)
  const r = await runOnEmulator(input, env, { timeoutMs: 10_000 })
  expect(r).toEqual({ infra: 'the Firebase emulator did not start: Error: An unexpected error has occurred.' })
  const [orphan] = await pids()
  expect(alive(orphan!)).toBe(false)
}, FAKE_CLI)

it('stops what a dead CLI left when the run times out, and nothing else', async () => {
  // The CLI exits; a child in its group keeps our pipe open, so the run only ends at the timeout, when the CLI's
  // pid is free to be reused. An unrelated process must survive.
  const decoy = spawn('/bin/sleep', ['300'], { stdio: 'ignore' })
  try {
    const body = `${detached('sleep 300', '"$7"')}\norphan=$!\nsleep 300 &\necho "$orphan $!" > "$REC"\necho exiting\nexit 0`
    const { env, pids } = await fake(body)
    const r = await runOnEmulator(input, env, { timeoutMs: 1_000 })
    expect(r).toEqual({ infra: 'the Firebase emulator run timed out after 1 s: exiting' })
    const [orphan, child] = await pids()
    expect([alive(orphan!), alive(child!), alive(decoy.pid!)]).toEqual([false, false, true])
  } finally {
    decoy.kill('SIGKILL')
  }
}, FAKE_CLI)
