// Runs a command and stops every process it started. firebase-tools starts the Firestore emulator JVM detached (its
// own process group) and leaves it running, re-parented to init, when the CLI dies, so killing the CLI's process
// group alone misses it.
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'

export type Exit = { code: number | null; output: string; missing: boolean; timedOut: boolean }

const GRACE_MS = 5_000

type Row = { pid: number; ppid: number; pgid: number; args: string }

async function processTable(): Promise<Row[]> {
  try {
    const { stdout } = await promisify(execFile)('ps', ['-A', '-ww', '-o', 'pid=,ppid=,pgid=,args='], { maxBuffer: 64 * 1024 * 1024 })
    return stdout.split('\n').flatMap(line => {
      const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s(.*)$/.exec(line)
      return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), args: m[4]! }] : []
    })
  } catch {
    return []
  }
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const signal = (pids: number[], s: NodeJS.Signals) => { for (const p of pids) try { process.kill(p, s) } catch { /* gone */ } }

// Polls every 100 ms until every pid (and the group, when given) is gone, for at most `ms`.
async function gone(pids: number[], group: number | undefined, ms: number): Promise<boolean> {
  const left = () => pids.some(alive) || (group !== undefined && alive(-group))
  for (const end = Date.now() + ms; left(); await new Promise(r => setTimeout(r, 100))) if (Date.now() >= end) return false
  return true
}

export type Stop = { group: number; marker?: string; root?: number; graceMs?: number }

// Stops the members of process group `group` (a detached child's pid), every process whose command line contains
// `marker`, and `root` with its descendants: SIGTERM, then SIGKILL after `graceMs` for whatever is still the same
// process. Pass `root` only while that child runs: once it has exited its pid can belong to anyone.
export async function stopAll({ group, marker, root, graceMs = GRACE_MS }: Stop): Promise<void> {
  const rows = await processTable()
  // A group id is not reused as a pid while the group exists, so a live process with that pid (other than our running
  // root) means our group is gone.
  const ownGroup = root === group || !rows.some(r => r.pid === group)
  const targets = new Map(rows.filter(r => (ownGroup && r.pgid === group) || (marker !== undefined && r.args.includes(marker))).map(r => [r.pid, r.args]))
  if (root !== undefined) {
    const args = new Map(rows.map(r => [r.pid, r.args]))
    targets.set(root, args.get(root) ?? '')
    for (let grew = true; grew;) {
      grew = false
      for (const r of rows) if (targets.has(r.ppid) && !targets.has(r.pid)) { targets.set(r.pid, r.args); grew = true }
    }
  }
  targets.delete(process.pid)
  // Without a process table (no `ps`), the group of a root that still runs is certainly ours.
  const byGroup = rows.length === 0 && root === group ? group : undefined
  if (targets.size === 0 && byGroup === undefined) return
  const signalled = [...targets.keys()]
  signal(signalled, 'SIGTERM')
  if (byGroup !== undefined) signal([-byGroup], 'SIGTERM')
  if (await gone(signalled, byGroup, graceMs)) return
  // SIGKILL only processes that are still the ones signalled: same pid and same command line.
  const still = (await processTable()).filter(r => targets.has(r.pid) && targets.get(r.pid) === r.args).map(r => r.pid)
  signal(still, 'SIGKILL')
  if (byGroup !== undefined) signal([-byGroup], 'SIGKILL')
  await gone(still, byGroup, 1_000)
}

// With `timeout`, the command runs in its own process group; when it runs out, everything it started is stopped
// (`marker` names the run's files, which the detached emulator JVM's command line contains).
export function run(command: string, args: string[], env: NodeJS.ProcessEnv, opts: { cwd?: string; timeout?: number; marker?: string } = {}): Promise<Exit & { pid?: number }> {
  return new Promise(resolve => {
    const { cwd, timeout, marker } = opts
    const child = spawn(command, args, { env, cwd, detached: timeout !== undefined, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let timedOut = false
    let stopping: Promise<void> | undefined
    const collect = (chunk: Buffer) => { output += chunk.toString() }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    const timer = timeout === undefined ? undefined : setTimeout(() => {
      timedOut = true
      // The child may have exited while something it started holds the pipes: then its pid is no longer ours.
      const running = child.exitCode === null && child.signalCode === null
      stopping = stopAll({ group: child.pid!, marker, root: running ? child.pid : undefined }).then(() => {
        // Whatever still holds the pipes must not keep the run open.
        child.stdout.destroy()
        child.stderr.destroy()
      })
    }, timeout)
    child.on('error', e => {
      clearTimeout(timer)
      resolve({ code: null, output: output + e.message, missing: (e as NodeJS.ErrnoException).code === 'ENOENT', timedOut })
    })
    child.on('close', code => {
      clearTimeout(timer)
      void Promise.resolve(stopping).then(() => resolve({ code, output, missing: false, timedOut, pid: child.pid }))
    })
  })
}
