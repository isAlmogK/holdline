import { mkdtemp, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FIREBASE_INSTALL_HINT, runOnEmulator } from '../src/emulator.js'
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

describe('toMetadata', () => {
  it('converts storage seed data to custom metadata', () => {
    expect(toMetadata({ a: 'x', n: 1, b: true, z: null, o: { k: 1 } })).toEqual({ a: 'x', n: '1', b: 'true', o: '{"k":1}' })
  })
})
