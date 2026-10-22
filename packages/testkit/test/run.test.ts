import type { TestFile } from '@holdline/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runTests } from '../src/run.js'
import { project } from './helpers.js'

// A PGlite that fails to start (construction or the auth shim) and an emulator run that drops a rule's
// results: runner failures the real tools do not produce on demand.
const state = vi.hoisted(() => ({ fail: 'constructor' as 'constructor' | 'exec', closed: 0 }))
vi.mock('@electric-sql/pglite', () => ({
  PGlite: class {
    constructor() { if (state.fail === 'constructor') throw new Error('wasm failed') }
    static async create() { return new this() }
    async exec() { throw new Error('shim failed') }
    async close() { state.closed++ }
  },
}))
vi.mock('../src/emulator.js', () => ({ runOnEmulator: vi.fn(async () => ({ results: { 'R-2': [] } })) }))

const file = (rule: string, store: TestFile['store'], path: string): TestFile => ({
  rule, generatedFrom: 'h', store, skipped: [],
  cases: [{ name: 'read', as: null, seed: [], do: { op: 'read', path }, expect: 'deny' }],
})

describe('runTests runner failures', () => {
  beforeEach(() => { state.closed = 0 })

  it('reports a PGlite that cannot be constructed as postgres infrastructure', async () => {
    state.fail = 'constructor'
    const root = await project({ 'supabase/migrations/1.sql': 'create table t (id int);' })
    const r = await runTests(root, {}, [{ file: file('R-1', 'postgres', 'public.t'), kind: 'access' }])
    expect(r).toEqual({ files: [], infrastructure: [{ store: 'postgres', message: 'the Postgres runner could not start: wasm failed' }] })
  })

  it('reports a failing auth shim as postgres infrastructure and closes the database', async () => {
    state.fail = 'exec'
    const root = await project({ 'supabase/migrations/1.sql': 'create table t (id int);' })
    const r = await runTests(root, {}, [{ file: file('R-1', 'postgres', 'public.t'), kind: 'access' }])
    expect(r).toEqual({ files: [], infrastructure: [{ store: 'postgres', message: 'the Postgres runner could not start: shim failed' }] })
    expect(state.closed).toBe(1)
  })

  it('reports a rule the emulator returned no results for as infrastructure of its store', async () => {
    const root = await project({ 'firestore.rules': "rules_version = '2';" })
    const r = await runTests(root, {}, [
      { file: file('R-1', 'firestore', '/a/b'), kind: 'access' },
      { file: file('R-2', 'firestore', '/a/c'), kind: 'access' },
    ])
    expect(r).toEqual({ files: [], infrastructure: [{ store: 'firestore', message: 'the emulator worker returned no results for R-1' }] })
  })
})
