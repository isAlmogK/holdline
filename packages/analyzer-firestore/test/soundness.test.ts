import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { evalExpr } from './helpers/eval-expr.js'
import { interpret } from './helpers/interpret.js'
import { normalize, ROWS, vocabularyOf, type Row } from './helpers/rows.js'
import { worldArb, type World } from './helpers/world.js'

const world = (over: Partial<World>): World => ({ actor: null, params: { thingId: 't1' }, resource: undefined, incoming: undefined, docs: {}, ...over })
const row = (condition: string, store: Row['store'] = 'firestore'): Row => ({ name: condition, store, condition })

describe('the Firestore model (interpret)', () => {
  it('errors on a missing field and on a member of null request.auth', () => {
    expect(interpret(row(`resource.data.status == 'open'`), world({ resource: {} }))).toBe('error')
    expect(interpret(row(`resource.data.status == 'open'`), world({}))).toBe('error')
    expect(interpret(row('request.auth.uid == thingId'), world({}))).toBe('error')
  })
  it('lets && and || absorb errors, and nothing else', () => {
    const anonymousOpen = world({ resource: { a: 1 } })
    expect(interpret(row('resource.data.a == 1 || request.auth.uid == resource.data.owner'), anonymousOpen)).toBe(true)
    expect(interpret(row('request.auth.uid == resource.data.owner || resource.data.a == 1'), anonymousOpen)).toBe(true)
    expect(interpret(row('resource.data.a == 2 && request.auth.uid == resource.data.owner'), anonymousOpen)).toBe(false)
    expect(interpret(row('request.auth.uid == resource.data.owner && resource.data.a == 2'), anonymousOpen)).toBe(false)
    expect(interpret(row('!(request.auth.uid == resource.data.owner)'), anonymousOpen)).toBe('error')
    expect(interpret(row('resource.data.a == 2 || request.auth.uid == resource.data.owner'), anonymousOpen)).toBe('error')
  })
  it('errors on an ordering across types and on a non-boolean condition', () => {
    expect(interpret(row('resource.data.n < 3'), world({ resource: { n: 'a' } }))).toBe('error')
    expect(interpret(row('resource.data.n < 3'), world({ resource: { n: null } }))).toBe('error')
    expect(interpret(row(`resource.data.n == 'a'`), world({ resource: { n: 1 } }))).toBe(false)
    expect(interpret(row('resource.data.published'), world({ resource: { published: 'yes' } }))).toBe('error')
  })
  it('throws on forms it does not model, rather than calling them errors', () => {
    const anyone = world({ resource: { a: 1 }, actor: { uid: 'u1', claims: {} } })
    expect(() => interpret(row('request.time == null'), anyone)).toThrow('unsupported member request.time')
    expect(() => interpret(row(`resource.id == 'x'`), anyone)).toThrow('unsupported member resource.id')
    expect(() => interpret(row('resource.data[1] == 1'), anyone)).toThrow('unsupported index key')
  })
  it('reads documents, map defaults and Storage metadata', () => {
    const uid = { actor: { uid: 'u1', claims: {} } }
    const inOrgs = row(`thingId in get(/databases/$(database)/documents/users/$(request.auth.uid)).data.orgIds`)
    expect(interpret(inOrgs, world({ ...uid, docs: { '/users/u1': { orgIds: ['t1'] } } }))).toBe(true)
    expect(interpret(inOrgs, world({ ...uid, docs: {} }))).toBe('error')
    expect(interpret(row(`resource.data.get('role', '') == ''`), world({ resource: {} }))).toBe(true)
    expect(interpret(row('resource.metadata.owner == request.auth.uid', 'storage'), world({ ...uid, resource: { owner: 'u1' } }))).toBe(true)
  })
})

describe('soundness: Firestore true implies the Expr is not false', () => {
  // A fixed sample to show each row is exercised.
  const sample = fc.sample(worldArb, { numRuns: 1000, seed: 7 })

  for (const r of ROWS) {
    describe(r.name, () => {
      const expr = normalize(r)
      const vocab = vocabularyOf(r)

      it('is allowed by Firestore in some sampled world, where the Expr is exactly true', () => {
        // Guards against a vacuous property: the row allows somewhere, and the Expr decides it (not only unknowns).
        const allowing = sample.filter(w => interpret(r, w) === true)
        if (r.condition === 'false') return expect(allowing).toEqual([])
        expect(allowing.length).toBeGreaterThan(0)
        expect(allowing.some(w => evalExpr(expr, w, vocab) === true)).toBe(true)
      })

      it('never gives false where Firestore allows', () => {
        fc.assert(
          fc.property(worldArb, w => {
            if (interpret(r, w) === true) expect(evalExpr(expr, w, vocab)).not.toBe(false)
          }),
          { numRuns: 200 },
        )
      })
    })
  }
})
