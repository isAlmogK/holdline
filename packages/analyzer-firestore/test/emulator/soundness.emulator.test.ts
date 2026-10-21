import fc from 'fast-check'
import type { RulesTestEnvironment, TokenOptions } from '@firebase/rules-unit-testing'
import { afterAll, describe, expect, it } from 'vitest'
import { evalExpr } from '../helpers/eval-expr.js'
import { normalize, readsIncoming, ROWS, rulesSource, vocabularyOf, type Row } from '../helpers/rows.js'
import { worldArb, type World } from '../helpers/world.js'
import { PROJECT_ID, startEmulator } from './emulator.js'

/**
 * The soundness property against the real rules engine: whenever the Firestore emulator allows a request, the
 * Expr the analyzer emits is not false in the Holdline model. Storage rows are model-only (the Storage emulator
 * is a second service).
 */
const emu = await startEmulator()
const TITLE = '@emulator soundness against the Firestore emulator'
const skipped = 'skip' in emu

const WORLDS = fc.sample(worldArb, { numRuns: 30, seed: 20261021 })
const thingPath = (w: World) => `things/${w.params['thingId']}`

/** The world as the request sees it: a read has no incoming record; a create has no stored one. */
const forOp = (w: World, op: 'read' | 'create'): World =>
  op === 'read' ? { ...w, incoming: undefined } : { ...w, resource: undefined, incoming: w.incoming ?? {} }

async function succeeds(request: Promise<unknown>): Promise<boolean> {
  try {
    await request
    return true
  } catch (e) {
    if ((e as { code?: string }).code === 'permission-denied') return false
    throw e
  }
}

async function seed(env: RulesTestEnvironment, w: World): Promise<void> {
  await env.clearFirestore()
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore()
    if (w.resource) await db.doc(thingPath(w)).set(w.resource)
    for (const [path, data] of Object.entries(w.docs)) await db.doc(path.slice(1)).set(data)
  })
}

/** True when the emulator allows the row's request in world `w`. */
async function allowed(env: RulesTestEnvironment, w: World, op: 'read' | 'create'): Promise<boolean> {
  const ctx = w.actor ? env.authenticatedContext(w.actor.uid, w.actor.claims as TokenOptions) : env.unauthenticatedContext()
  const ref = ctx.firestore().doc(thingPath(w))
  return succeeds(op === 'read' ? ref.get() : ref.set(w.incoming ?? {}))
}

const variants = (row: Row): ('read' | 'create')[] => (readsIncoming(row) ? ['read', 'create'] : ['read'])

describe.skipIf(skipped)(skipped ? `${TITLE} (skipped: ${emu.skip})` : TITLE, () => {
  afterAll(async () => {
    if (!('skip' in emu)) await emu.stop()
  })

  for (const row of ROWS.filter(r => r.store === 'firestore')) {
    for (const op of variants(row)) {
      it(`${row.name} (allow ${op})`, async () => {
        if ('skip' in emu) return
        const { initializeTestEnvironment } = await import('@firebase/rules-unit-testing')
        const expr = normalize(row)
        const vocab = vocabularyOf(row)
        const env = await initializeTestEnvironment({
          projectId: PROJECT_ID,
          firestore: { host: emu.host, port: emu.port, rules: rulesSource(row, op) },
        })
        try {
          for (const sampled of WORLDS) {
            const w = forOp(sampled, op)
            await seed(env, w)
            if (await allowed(env, w, op)) expect(evalExpr(expr, w, vocab), JSON.stringify(w)).not.toBe(false)
          }
        } finally {
          await env.cleanup()
        }
      }, 120_000)
    }
  }
})
