import { execFileSync } from 'node:child_process'
import { mkdtemp, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FIREBASE_INSTALL_HINT, runOnEmulator, shellQuote, toolsMissing, workerCommand } from '../src/emulator.js'
import { toMetadata } from '../src/firebase-ops.js'

// A directory holding fake executables (name → shell script body).
async function bin(scripts: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'holdline-bin-'))
  for (const [name, body] of Object.entries(scripts)) {
    await writeFile(join(dir, name), `#!/bin/sh\n${body}\n`)
    await chmod(join(dir, name), 0o755)
  }
  return dir
}

describe('runOnEmulator', () => {
  it('reports a missing firebase binary as infrastructure with the install hint', async () => {
    const r = await runOnEmulator({ firestoreRules: 'x', files: [] }, { PATH: '/nonexistent' })
    expect(r).toEqual({ infra: expect.stringMatching(/^firebase-tools is not installed: install firebase-tools/) })
  })
  it('reports a missing java as infrastructure with the install hint', async () => {
    const dir = await bin({ firebase: 'echo 13.0.0' })
    const r = await runOnEmulator({ firestoreRules: 'x', files: [] }, { PATH: dir })
    expect(r).toEqual({ infra: `Java is not installed: ${FIREBASE_INSTALL_HINT}` })
  })
  it('reports an emulator that does not start with the output tail and the hint when Java is mentioned', async () => {
    const dir = await bin({
      firebase: 'if [ "$1" = "--version" ]; then echo 15.0.0; exit 0; fi\necho starting\necho "firebase-tools no longer supports Java version before 21" >&2\nexit 1',
      java: 'echo "openjdk 19" >&2',
    })
    const r = await runOnEmulator({ firestoreRules: 'x', files: [] }, { PATH: dir })
    expect('infra' in r && r.infra).toMatch(/^the Firebase emulator did not start: starting\nfirebase-tools no longer supports Java version before 21/)
    expect('infra' in r && r.infra).toContain(FIREBASE_INSTALL_HINT)
  })
  it('leaves the hint out when the output does not mention Java', async () => {
    const dir = await bin({
      firebase: 'if [ "$1" = "--version" ]; then exit 0; fi\necho "port taken"\nexit 1',
      java: 'exit 0',
    })
    const r = await runOnEmulator({ firestoreRules: 'x', files: [] }, { PATH: dir })
    expect(r).toEqual({ infra: 'the Firebase emulator did not start: port taken' })
  })
})

// The words a POSIX shell (as `firebase emulators:exec` runs its command) makes of `command`.
const shellWords = (command: string) =>
  execFileSync('/bin/sh', ['-c', `set -- ${command}; for a; do printf '%s\\0' "$a"; done`]).toString().split('\0').slice(0, -1)

describe('worker command quoting', () => {
  const nasty = "/tmp/a dir/$HOME/`echo hi`/it's \"q\"/in.json"
  it('keeps every character of a path through the shell', () => {
    expect(shellWords(shellQuote(nasty))).toEqual([nasty])
    expect(shellQuote("it's")).toBe("'it'\\''s'")
  })
  it('passes the input and output paths to the worker unchanged', () => {
    const words = shellWords(workerCommand(nasty, `${nasty}.out`))
    expect(words[0]).toBe(process.execPath)
    expect(words.slice(-2)).toEqual([nasty, `${nasty}.out`])
  })
})

describe('toolsMissing', () => {
  it('is true only when firebase-tools or a usable Java is missing', () => {
    expect(toolsMissing(`firebase-tools is not installed: ${FIREBASE_INSTALL_HINT}`)).toBe(true)
    expect(toolsMissing(`Java is not installed: ${FIREBASE_INSTALL_HINT}`)).toBe(true)
    expect(toolsMissing(`the Firebase emulator did not start: starting\nfirebase-tools no longer supports Java version before 21\n${FIREBASE_INSTALL_HINT}`)).toBe(true)
  })
  it('is false for every other infrastructure failure', () => {
    expect(toolsMissing('the Firebase emulator did not start: port taken')).toBe(false)
    // The hint alone (added whenever the output mentions Java) does not say the Java version is wrong.
    expect(toolsMissing(`the Firebase emulator did not start: java.lang.OutOfMemoryError\n${FIREBASE_INSTALL_HINT}`)).toBe(false)
    expect(toolsMissing('the Firebase emulator run timed out after 180 s: ...')).toBe(false)
    expect(toolsMissing('the Firebase worker wrote an invalid result: ...')).toBe(false)
    expect(toolsMissing('the emulator worker returned no results for R-001')).toBe(false)
    expect(toolsMissing('the Firebase emulator could not be used: ECONNREFUSED')).toBe(false)
    expect(toolsMissing('no firestore rules file found')).toBe(false)
  })
})

describe('toMetadata', () => {
  it('converts storage seed data to custom metadata', () => {
    expect(toMetadata({ a: 'x', n: 1, b: true, z: null, o: { k: 1 } })).toEqual({ a: 'x', n: '1', b: 'true', o: '{"k":1}' })
  })
})
