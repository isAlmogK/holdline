// Runs Firestore and Storage cases on the emulators (spec 5.3): in-process when they are already running,
// otherwise inside `firebase emulators:exec` with a worker. Missing tools are infrastructure failures.
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { z } from 'zod'
import { runFirebaseFiles, type FirebaseInput } from './firebase-runner.js'
import { run, stopAll } from './processes.js'
import { CaseResultSchema, type CaseResult } from './report.js'

export const FIREBASE_INSTALL_HINT =
  'install firebase-tools (npm install -g firebase-tools) and a JDK 21 or later, or start the emulators yourself and set FIRESTORE_EMULATOR_HOST and FIREBASE_STORAGE_EMULATOR_HOST'

// True when an infrastructure message says the tools are missing: no firebase-tools, no Java, or an emulator that
// did not start because the Java version is too old. Every other message is a real failure. The @emulator test
// suites skip only on these.
export function toolsMissing(infra: string): boolean {
  if (infra.startsWith('firebase-tools is not installed') || infra.startsWith('Java is not installed')) return true
  return infra.startsWith('the Firebase emulator did not start:') && /\bJava version\b/i.test(infra)
}

export type EmulatorOutcome = { results: Record<string, CaseResult[]> } | { infra: string }
export type EmulatorOptions = { timeoutMs?: number }

const TIMEOUT_MS = 180_000
const TAIL_LINES = 15
const DENY_ALL = {
  firestore: "rules_version = '2';\nservice cloud.firestore { match /databases/{database}/documents { match /{doc=**} { allow read, write: if false; } } }\n",
  storage: "rules_version = '2';\nservice firebase.storage { match /b/{bucket}/o { match /{object=**} { allow read, write: if false; } } }\n",
}
const ResultsSchema = z.record(z.string(), z.array(CaseResultSchema))

async function freePorts(n: number): Promise<number[]> {
  const servers = await Promise.all(Array.from({ length: n }, () => new Promise<ReturnType<typeof createServer>>((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })))
  const ports = servers.map(s => (s.address() as AddressInfo).port)
  await Promise.all(servers.map(s => new Promise(resolve => s.close(resolve))))
  return ports
}

function tail(output: string): string {
  return output.split(/\r?\n/).filter(l => l.trim() !== '').slice(-TAIL_LINES).join('\n')
}

// `emulators:exec` runs its command through a shell: each word is single-quoted, a `'` as `'\''`, so `$`, backticks
// and spaces in a path stay literal.
export const shellQuote = (a: string) => `'${a.replace(/'/g, "'\\''")}'`

export function workerCommand(inPath: string, outPath: string): string {
  const tsxDir = dirname(createRequire(import.meta.url).resolve('tsx/package.json'))
  const loader = pathToFileURL(join(tsxDir, 'dist/loader.mjs')).href
  const worker = fileURLToPath(new URL('./firebase-worker.ts', import.meta.url))
  return [process.execPath, '--import', loader, worker, inPath, outPath].map(shellQuote).join(' ')
}

// Every port is pinned, the Firestore websocket too (it defaults to 9150), so runs side by side do not collide.
async function prepare(dir: string, input: FirebaseInput): Promise<void> {
  const [firestore, websocket, storage, hub, logging] = await freePorts(5)
  const config = {
    emulators: {
      firestore: { host: '127.0.0.1', port: firestore, websocketPort: websocket },
      storage: { host: '127.0.0.1', port: storage },
      hub: { port: hub },
      logging: { port: logging },
      ui: { enabled: false },
    },
    firestore: { rules: 'firestore.rules' },
    storage: { rules: 'storage.rules' },
  }
  await writeFile(join(dir, 'firebase.json'), JSON.stringify(config, null, 2))
  await writeFile(join(dir, 'firestore.rules'), input.firestoreRules ?? DENY_ALL.firestore)
  await writeFile(join(dir, 'storage.rules'), input.storageRules ?? DENY_ALL.storage)
  await writeFile(join(dir, 'input.json'), JSON.stringify(input))
}

async function exec(input: FirebaseInput, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<EmulatorOutcome> {
  const dir = await mkdtemp(join(tmpdir(), 'holdline-emulator-'))
  let cli: number | undefined
  try {
    await prepare(dir, input)
    const outPath = join(dir, 'out.json')
    const args = ['emulators:exec', '--only', 'firestore,storage', '--project', 'holdline-test',
      '--config', join(dir, 'firebase.json'), workerCommand(join(dir, 'input.json'), outPath)]
    // firebase-tools keeps per-machine state in os.tmpdir(): the Storage emulator's blobs (deleted when it stops,
    // which crashes another suite's next upload) and the hub locator. A private TMPDIR keeps each run's own.
    const tmp = join(dir, 'tmp')
    await mkdir(tmp)
    const exit = await run('firebase', args, { ...env, TMPDIR: tmp }, { cwd: dir, timeout: timeoutMs, marker: basename(dir) })
    cli = exit.pid
    if (exit.timedOut) return { infra: `the Firebase emulator run timed out after ${timeoutMs / 1000} s: ${tail(exit.output)}` }
    if (existsSync(outPath)) {
      const text = await readFile(outPath, 'utf8')
      let raw: unknown
      try { raw = JSON.parse(text) } catch { raw = undefined }
      const parsed = ResultsSchema.safeParse(raw)
      if (parsed.success) return { results: parsed.data }
      return { infra: `the Firebase worker wrote an invalid result: ${z.prettifyError(parsed.error)}` }
    }
    const hint = /java/i.test(exit.output) ? `\n${FIREBASE_INSTALL_HINT}` : ''
    return { infra: `the Firebase emulator did not start: ${tail(exit.output)}${hint}` }
  } finally {
    // However the run ended (a CLI that crashed leaves the Firestore JVM running), nothing it started outlives it.
    if (cli !== undefined) await stopAll({ group: cli, marker: basename(dir) })
    await rm(dir, { recursive: true, force: true })
  }
}

// `env` is used for the emulator-variable check, the tool probes and the spawn. In-process runs read
// process.env (as @firebase/rules-unit-testing does).
export async function runOnEmulator(input: FirebaseInput, env: NodeJS.ProcessEnv = process.env, options: EmulatorOptions = {}): Promise<EmulatorOutcome> {
  const needsStorage = input.files.some(f => f.store === 'storage')
  if (env.FIRESTORE_EMULATOR_HOST && (!needsStorage || env.FIREBASE_STORAGE_EMULATOR_HOST)) {
    try {
      return { results: await runFirebaseFiles(input) }
    } catch (e) {
      return { infra: `the Firebase emulator could not be used: ${e instanceof Error ? e.message : String(e)}` }
    }
  }
  if ((await run('firebase', ['--version'], env)).missing) return { infra: `firebase-tools is not installed: ${FIREBASE_INSTALL_HINT}` }
  if ((await run('java', ['-version'], env)).missing) return { infra: `Java is not installed: ${FIREBASE_INSTALL_HINT}` }
  return exec(input, env, options.timeoutMs ?? TIMEOUT_MS)
}
