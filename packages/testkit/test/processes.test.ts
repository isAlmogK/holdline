import { spawn, type ChildProcess } from 'node:child_process'
import { afterEach, expect, it } from 'vitest'
import { stopAll } from '../src/processes.js'

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const marker = () => `holdline-emulator-test${Math.random().toString(36).slice(2)}`
const started: ChildProcess[] = []
afterEach(() => { for (const c of started.splice(0)) try { process.kill(-c.pid!, 'SIGKILL') } catch { /* gone */ } })

// A detached process: its own process group, with its pid as the group id.
function detached(command: string, args: string[]): ChildProcess {
  const child = spawn(command, args, { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
  started.push(child)
  return child
}
const closed = (c: ChildProcess) => new Promise(resolve => c.on('close', resolve))

it('returns at once when the run left nothing behind', async () => {
  const cli = detached('/bin/sh', ['-c', 'exit 0'])
  await closed(cli)
  const t = Date.now()
  await stopAll({ group: cli.pid!, marker: marker() })
  expect(Date.now() - t).toBeLessThan(1_000)
})

it('never signals a process that has the pid of a group that is gone', async () => {
  // A live group leader with the old CLI's pid: our group is gone (POSIX does not reuse the id of a live group).
  const decoy = detached('/bin/sleep', ['300'])
  await stopAll({ group: decoy.pid!, marker: marker() })
  expect(alive(decoy.pid!)).toBe(true)
})

it('kills what ignores SIGTERM after the grace', async () => {
  const name = marker()
  const stubborn = detached('/usr/bin/perl', ['-e', '$SIG{TERM} = "IGNORE"; print "ready\\n"; $| = 1; sleep 300', name])
  await new Promise(resolve => stubborn.stdout!.once('data', resolve))
  const t = Date.now()
  await stopAll({ group: -1, marker: name, graceMs: 300 })
  expect(alive(stubborn.pid!)).toBe(false)
  expect(Date.now() - t).toBeLessThan(3_000)
})

it('stops the group of a running CLI when ps is not available', async () => {
  const cli = detached('/bin/sh', ['-c', '/bin/sleep 300 & echo $!; wait'])
  const child = Number(await new Promise<string>(resolve => cli.stdout!.once('data', d => resolve(String(d)))))
  const done = closed(cli)
  const path = process.env.PATH
  process.env.PATH = '/nonexistent'
  try {
    await stopAll({ group: cli.pid!, root: cli.pid!, graceMs: 2_000 })
  } finally {
    process.env.PATH = path
  }
  await done
  expect(alive(child)).toBe(false)
})
