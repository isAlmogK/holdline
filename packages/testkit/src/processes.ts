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
const signal = (pids: Iterable<number>, s: NodeJS.Signals) => { for (const p of pids) try { process.kill(p, s) } catch { /* gone */ } }

async function exited(pids: Set<number>, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 50))) {
    if (![...pids].some(alive)) return true
  }
  return ![...pids].some(alive)
}

// Stops the process group `group` (a detached child's pid), every process whose command line contains `marker`
// and the descendants of `root` (pass it only while it runs, so its pid is nobody else's): SIGTERM, then SIGKILL.
export async function stopAll(group: number, marker?: string, root?: number): Promise<void> {
  const rows = await processTable()
  const pids = new Set(rows.filter(r => r.pgid === group || (marker !== undefined && r.args.includes(marker))).map(r => r.pid))
  if (root !== undefined) {
    pids.add(root)
    for (let grew = true; grew;) {
      grew = false
      for (const r of rows) if (pids.has(r.ppid) && !pids.has(r.pid)) { pids.add(r.pid); grew = true }
    }
  }
  pids.delete(process.pid)
  if (pids.size === 0) return
  signal(pids, 'SIGTERM')
  if (await exited(pids, GRACE_MS)) return
  signal(pids, 'SIGKILL')
  await exited(pids, 1_000)
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
      stopping = stopAll(child.pid!, marker, child.pid).then(() => {
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
