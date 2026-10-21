import { mkdtemp, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestCase, TestFile } from '@holdline/core'
import { describe, expect, it } from 'vitest'
import { runOnEmulator } from '../src/emulator.js'
import type { FirebaseInput } from '../src/firebase-runner.js'
import { bin, skipReason } from './helpers.js'

// A fake firebase that records, per run, the config it got, the TMPDIR it saw, whether that exists, and its run
// directory (where the config lives). `emulators:exec --only … --project … --config <path> <command>`: $7 is the path.
const recorder = [
  'if [ "$1" = "--version" ]; then exit 0; fi',
  'cp "$7" "$REC/$$.json"',
  'if [ -d "$TMPDIR" ]; then made=yes; else made=no; fi',
  'printf "%s\\n%s\\n%s" "$TMPDIR" "$made" "$(dirname "$7")" > "$REC/$$.env"',
  'sleep 1',
  'exit 1',
].join('\n')

// Two emulator suites share os.tmpdir(): the Storage emulator keeps its blobs in <tmp>/firebase/storage/blobs and
// deletes that directory when it stops, which crashes the other suite's next upload. The Firestore websocket port
// defaults to 9150 for every suite. Each run gets its own of both.
it('gives runs side by side their own temp directory and Firestore websocket port', async () => {
  const rec = await mkdtemp(join(tmpdir(), 'holdline-rec-'))
  const dir = await bin({ firebase: recorder, java: 'exit 0' })
  const env = { PATH: `${dir}:/usr/bin:/bin`, REC: rec }
  const input = { firestoreRules: 'x', files: [] }
  await Promise.all([runOnEmulator(input, env), runOnEmulator(input, env)])

  const pids = (await readdir(rec)).filter(f => f.endsWith('.json')).map(f => f.slice(0, -'.json'.length))
  expect(pids).toHaveLength(2)
  const runs = await Promise.all(pids.map(async pid => {
    const config = JSON.parse(await readFile(join(rec, `${pid}.json`), 'utf8')) as { emulators: { firestore: { websocketPort?: number } } }
    const [tmp, made, runDir] = (await readFile(join(rec, `${pid}.env`), 'utf8')).split('\n')
    return { websocket: config.emulators.firestore.websocketPort, tmp: tmp!, made, runDir: runDir! }
  }))
  for (const run of runs) {
    expect(run.tmp.startsWith(`${run.runDir}/`), `${run.tmp} is inside ${run.runDir}`).toBe(true)
    expect(run.made).toBe('yes')
    expect(run.websocket).toEqual(expect.any(Number))
  }
  expect(runs[0]!.tmp).not.toBe(runs[1]!.tmp)
  expect(runs[0]!.websocket).not.toBe(runs[1]!.websocket)
})

const storageRules = `rules_version = '2';
service firebase.storage { match /b/{bucket}/o { match /f/{name} { allow read, write: if request.auth != null; } } }`
const firestoreRules = `rules_version = '2';
service cloud.firestore { match /databases/{database}/documents { match /n/{id} { allow read: if request.auth != null; } } }`
const u1 = { uid: 'u1', claims: {} }
const object = (i: number) => ({ path: `/f/o${i}`, store: 'storage' as const, data: { kind: 'doc' } })
const tc = (name: string, c: Omit<TestCase, 'name'>): TestCase => ({ name, ...c })
const file = (rule: string, store: TestFile['store'], cases: TestCase[]): TestFile => ({ rule, generatedFrom: 'h', store, cases, skipped: [] })
// A short run that stops (and cleans up) while a long Storage run is still uploading.
const short: FirebaseInput = { firestoreRules, files: [file('short', 'firestore', [
  tc('reads', { as: u1, seed: [{ path: '/n/1', data: {} }], do: { op: 'read', path: '/n/1' }, expect: 'allow' }),
])] }
const long: FirebaseInput = { firestoreRules, storageRules, files: [file('long', 'storage', Array.from({ length: 200 }, (_, i) =>
  tc(`upload ${i}`, { as: u1, seed: [object(i)], do: { op: 'create', path: `/f/new${i}`, data: { kind: 'doc' } }, expect: 'allow' })))] }

describe('@emulator runs side by side', () => {
  it('both return results', async ctx => {
    const [a, b] = await Promise.all([runOnEmulator(long), runOnEmulator(short)])
    const reason = skipReason(a) ?? skipReason(b)
    if (reason !== undefined) return ctx.skip(reason)
    expect(b).toEqual({ results: { short: [{ name: 'reads', expect: 'allow', actual: 'allow', passed: true }] } })
    expect('results' in a && a.results['long']!.map(c => c.passed)).toEqual(Array.from({ length: 200 }, () => true))
  }, 240_000)
})
