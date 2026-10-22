import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface Emulator { host: string; port: number; stop(): Promise<void> }

export const PROJECT_ID = 'demo-holdline'
const HOST = '127.0.0.1'
const START_TIMEOUT_MS = 60_000
const OUTPUT_TAIL_CHARS = 2000

/** The Java major version (`1.8` → 8, `21.0.2` → 21), or undefined when `java -version` fails. */
function javaMajor(): number | undefined {
  const r = spawnSync('java', ['-version'], { encoding: 'utf8', timeout: 30_000 })
  if (r.status !== 0) return undefined
  const m = /version "(\d+)(?:\.(\d+))?/.exec(`${r.stderr}${r.stdout}`)
  if (!m) return undefined
  const first = Number(m[1])
  return first === 1 ? Number(m[2]) : first
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, HOST, () => {
      const address = server.address()
      server.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port'))))
    })
  })
}

const accepts = (port: number): Promise<boolean> => new Promise(resolve => {
  const socket = connect(port, HOST)
  socket.once('connect', () => { socket.destroy(); resolve(true) })
  socket.once('error', () => resolve(false))
})

/**
 * A running Firestore emulator, or the reason the emulator suite is skipped. `FIRESTORE_EMULATOR_HOST`, when set,
 * names an emulator that is already running. Otherwise firebase-tools starts one in a temp dir on a free port.
 */
export async function startEmulator(): Promise<Emulator | { skip: string }> {
  const existing = process.env['FIRESTORE_EMULATOR_HOST']
  if (existing) {
    const [host, port] = existing.split(':')
    return { host: host!, port: Number(port), stop: async () => {} }
  }
  const major = javaMajor()
  if (major === undefined || major < 21) return { skip: 'Java 21 or newer is required by firebase-tools' }
  if (spawnSync('firebase', ['--version'], { encoding: 'utf8', timeout: 30_000 }).status !== 0) {
    return { skip: 'firebase-tools not installed' }
  }

  const dir = await mkdtemp(join(tmpdir(), 'holdline-emulator-'))
  const [port, hubPort, websocketPort] = [await freePort(), await freePort(), await freePort()]
  await writeFile(join(dir, 'firestore.rules'), `rules_version = '2';\nservice cloud.firestore { match /{path=**} { allow read, write: if false; } }\n`)
  await writeFile(join(dir, 'firebase.json'), JSON.stringify({
    firestore: { rules: 'firestore.rules' },
    emulators: { firestore: { host: HOST, port, websocketPort }, hub: { host: HOST, port: hubPort }, ui: { enabled: false } },
  }))
  const child = spawn('firebase', ['emulators:start', '--only', 'firestore', '--project', PROJECT_ID], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
  // The tail of the emulator's output, for the error when it does not start. Reading the pipes also keeps them from filling.
  let output = ''
  const keep = (chunk: Buffer) => { output = (output + chunk.toString('utf8')).slice(-OUTPUT_TAIL_CHARS) }
  child.stdout.on('data', keep)
  child.stderr.on('data', keep)
  let exited = false
  const exit = new Promise<void>(resolve => child.once('exit', () => { exited = true; resolve() }))
  const stop = async () => {
    if (!exited) {
      child.kill('SIGINT')
      const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
      await exit
      clearTimeout(timer)
    }
    await rm(dir, { recursive: true, force: true })
  }

  const deadline = Date.now() + START_TIMEOUT_MS
  while (!(await accepts(port))) {
    if (exited || Date.now() > deadline) {
      await stop()
      const reason = exited ? 'the Firestore emulator exited before it started' : `the Firestore emulator did not start within ${START_TIMEOUT_MS / 1000} s`
      throw new Error(`${reason}; its output ended with:\n${output}`)
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  return { host: HOST, port, stop }
}
