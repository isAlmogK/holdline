import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { Atom, Expr, Literal, Operand } from '../src/expr.js'
import { atomImplies, collectRefs, expand, flattenAnd, implies, mentionsOperand, prove, renameParams } from '../src/logic.js'

const a = (atom: Atom): Expr => ({ atom })
const member = a({ op: 'exists', doc: '/accounts/{param.accountId}/members/{actor.uid}' })
const owner = a({ op: 'eq', left: 'actor.uid', right: 'resource.owner_id' })
const admin = a({ op: 'in', left: 'actor.role', right: { literal: ['admin'] } })
const notDeleted = a({ op: 'isNull', operand: 'resource.deleted_at' })
const noVocab = new Map<string, Expr>()

describe('atomImplies', () => {
  it('treats eq as symmetric and normalizes literal sides', () => {
    expect(atomImplies(
      { op: 'eq', left: 'resource.owner_id', right: 'actor.uid' },
      { op: 'eq', left: 'actor.uid', right: 'resource.owner_id' },
    )).toBe(true)
    expect(atomImplies(
      { op: 'eq', left: { literal: 'admin' }, right: 'actor.role' },
      { op: 'eq', left: 'actor.role', right: { literal: 'admin' } },
    )).toBe(true)
  })
  it('handles in-subsets and eq-into-in', () => {
    const inSet = (xs: string[]): Atom => ({ op: 'in', left: 'actor.role', right: { literal: xs } })
    expect(atomImplies(inSet(['admin']), inSet(['admin', 'owner']))).toBe(true)
    expect(atomImplies(inSet(['admin', 'member']), inSet(['admin', 'owner']))).toBe(false)
    expect(atomImplies({ op: 'eq', left: 'actor.role', right: { literal: 'owner' } }, inSet(['admin', 'owner']))).toBe(true)
  })
  it('only atoms that fail for anonymous callers imply authenticated', () => {
    const auth: Atom = { op: 'authenticated' }
    expect(atomImplies({ op: 'exists', doc: '/m/{actor.uid}' }, auth)).toBe(true)
    expect(atomImplies({ op: 'eq', left: 'actor.role', right: { literal: 'admin' } }, auth)).toBe(true)
    expect(atomImplies({ op: 'in', left: 'actor.role', right: { literal: ['admin'] } }, auth)).toBe(true)
    expect(atomImplies({ op: 'eq', left: 'actor.uid', right: 'resource.owner_id' }, auth)).toBe(false)
    expect(atomImplies({ op: 'isNull', operand: 'actor.uid' }, auth)).toBe(false)
    expect(atomImplies({ op: 'ne', left: 'actor.role', right: { literal: 'admin' } }, auth)).toBe(false)
    expect(atomImplies({ op: 'eq', left: 'actor.uid', right: { literal: null } }, auth)).toBe(false)
    expect(atomImplies({ op: 'isNull', operand: 'resource.deleted_at' }, auth)).toBe(false)
    expect(atomImplies(auth, { op: 'eq', left: 'actor.uid', right: 'resource.owner_id' })).toBe(false)
  })
  it('an in-atom implies itself, whatever its operands', () => {
    const own: Atom = { op: 'in', left: 'actor.uid', right: 'resource.editors' }
    expect(atomImplies(own, own)).toBe(true)
    const claim: Atom = { op: 'in', left: { literal: 'admin' }, right: 'actor.claim.roles' }
    expect(atomImplies(claim, claim)).toBe(true)
    expect(atomImplies(
      { op: 'in', left: 'actor.role', right: { literal: 'admin' } },
      { op: 'in', left: 'actor.role', right: { literal: ['admin', 'owner'] } },
    )).toBe(false)
  })
  it('compares exists docs and isNull operands exactly', () => {
    expect(atomImplies({ op: 'exists', doc: '/a/{x}' }, { op: 'exists', doc: '/a/{x}' })).toBe(true)
    expect(atomImplies({ op: 'exists', doc: '/a/{x}' }, { op: 'exists', doc: '/a/{y}' })).toBe(false)
  })
})

describe('implies', () => {
  it('and implies each of its parts; or needs every branch', () => {
    expect(implies({ and: [member, owner] }, member, noVocab)).toEqual({ ok: true })
    expect(implies({ or: [member, owner] }, member, noVocab).ok).toBe(false)
    expect(implies({ or: [{ and: [member, admin] }, { and: [member, owner] }] }, member, noVocab)).toEqual({ ok: true })
  })
  it('proves or-requirements from and-conditions holding an or', () => {
    expect(implies({ and: [notDeleted, { or: [member, owner] }] }, { or: [member, owner] }, noVocab)).toEqual({ ok: true })
  })
  it('reports the unproven top-level parts', () => {
    expect(implies(member, { and: [member, owner] }, noVocab)).toEqual({ ok: false, unproven: owner })
    expect(implies({ and: [] }, { and: [member, owner] }, noVocab)).toEqual({ ok: false, unproven: { and: [member, owner] } })
  })
  it('false (no policies) implies anything; nothing implies false', () => {
    expect(implies({ or: [] }, member, noVocab)).toEqual({ ok: true })
    expect(implies(member, { or: [] }, noVocab).ok).toBe(false)
    expect(implies({ or: [] }, { opaque: 'x' }, noVocab)).toEqual({ ok: true })
  })
  it('opaque never proves anything, not even itself', () => {
    expect(implies({ opaque: 'x' }, { opaque: 'x' }, noVocab).ok).toBe(false)
    expect(implies({ opaque: 'x' }, member, noVocab).ok).toBe(false)
  })
  it('expands vocabulary refs on both sides and reports them unexpanded', () => {
    const vocab = new Map<string, Expr>([['account-member', member], ['staff', admin]])
    expect(implies({ ref: 'account-member' }, member, vocab)).toEqual({ ok: true })
    expect(implies(member, { and: [{ ref: 'account-member' }, { ref: 'staff' }] }, vocab))
      .toEqual({ ok: false, unproven: { ref: 'staff' } })
  })
  it('unknown and circular refs become opaque', () => {
    expect(expand({ ref: 'nope' }, noVocab)).toEqual({ opaque: 'unknown predicate "nope"' })
    const loop = new Map<string, Expr>([['a', { ref: 'b' }], ['b', { ref: 'a' }]])
    expect(expand({ ref: 'a' }, loop)).toEqual({ opaque: 'circular predicate "a"' })
  })
})

describe('properties', () => {
  const atoms: Expr[] = [member, owner, admin, notDeleted, a({ op: 'authenticated' }), a({ op: 'in', left: 'actor.uid', right: 'resource.editors' })]
  const expr: fc.Arbitrary<Expr> = fc.letrec<{ e: Expr }>(tie => ({
    e: fc.oneof(
      { depthSize: 'small', withCrossShrink: true },
      fc.constantFrom(...atoms),
      fc.array(tie('e'), { maxLength: 3 }).map(xs => ({ and: xs })),
      fc.array(tie('e'), { maxLength: 3 }).map(xs => ({ or: xs })),
    ),
  })).e

  it('every expression implies itself unless it contains opaque', () => {
    fc.assert(fc.property(expr, e => prove(e, e)))
  })
  it('and[x, y] implies x, and x implies or[x, y]', () => {
    fc.assert(fc.property(expr, expr, (x, y) => prove({ and: [x, y] }, x) && prove(x, { or: [x, y] })))
  })
})

describe('helpers', () => {
  it('renameParams renames operands and doc placeholders', () => {
    const e: Expr = { and: [
      a({ op: 'exists', doc: '/accounts/{param.acct}/members/{actor.uid}' }),
      a({ op: 'eq', left: 'param.acct', right: 'resource.account_id' }),
    ] }
    expect(renameParams(e, new Map([['acct', 'accountId']]))).toEqual({ and: [
      a({ op: 'exists', doc: '/accounts/{param.accountId}/members/{actor.uid}' }),
      a({ op: 'eq', left: 'param.accountId', right: 'resource.account_id' }),
    ] })
  })
  it('collectRefs, mentionsOperand and flattenAnd', () => {
    const e: Expr = { and: [{ ref: 'x' }, { and: [owner, { not: { ref: 'y' } }] }] }
    expect(collectRefs(e).sort()).toEqual(['x', 'y'])
    expect(mentionsOperand(e, 'resource.owner_id')).toBe(true)
    expect(mentionsOperand(e, 'incoming.owner_id')).toBe(false)
    expect(flattenAnd(e)).toEqual([{ ref: 'x' }, owner, { not: { ref: 'y' } }])
  })
})

// Soundness against a finite model: whenever implies(c, r) is ok, r holds in every world where c holds.
describe('prover soundness (model based)', () => {
  type Actor = { uid: string; role: string; claims: Record<string, string> } | null
  type World = { actor: Actor; resource: Record<string, string | null>; present: ReadonlySet<string> }
  const NO_ACTOR = Symbol('no actor')

  const memberDoc = '/teams/{resource.team_id}/members/{actor.uid}'
  const adminDoc = '/admins/{actor.uid}'
  const vocab = new Map<string, Expr>([['staff', a({ op: 'in', left: 'actor.role', right: { literal: ['admin', 'member'] } })]])

  const actors: Actor[] = [null]
  for (const uid of ['u1', 'u2']) for (const role of ['admin', 'member']) for (const t of ['a', 'b']) actors.push({ uid, role, claims: { t } })
  const resources: Record<string, string | null>[] = []
  for (const owner_id of ['u1', 'u2', null]) for (const team_id of ['t1', null]) for (const deleted_at of [null, 'd1']) resources.push({ owner_id, team_id, deleted_at })
  const paths = [
    ...['t1', 'null'].flatMap(team => ['u1', 'u2'].map(uid => `/teams/${team}/members/${uid}`)),
    '/admins/u1', '/admins/u2',
  ]
  const worlds: World[] = []
  for (const actor of actors) for (const resource of resources) for (let mask = 0; mask < 1 << paths.length; mask++) {
    worlds.push({ actor, resource, present: new Set(paths.filter((_, i) => mask & (1 << i))) })
  }

  const value = (o: Operand, w: World): Literal | typeof NO_ACTOR => {
    if (typeof o !== 'string') return o.literal
    if (o.startsWith('actor.')) {
      if (!w.actor) return NO_ACTOR
      if (o === 'actor.uid') return w.actor.uid
      if (o === 'actor.role') return w.actor.role
      return w.actor.claims[o.slice('actor.claim.'.length)] ?? null
    }
    if (o.startsWith('resource.')) return w.resource[o.slice('resource.'.length)] ?? null
    return null
  }
  // Atoms with actor operands are false for an anonymous caller (actor null).
  const evalAtom = (at: Atom, w: World): boolean => {
    switch (at.op) {
      case 'authenticated': return w.actor !== null
      case 'exists': {
        if (at.doc.includes('{actor.') && !w.actor) return false
        const path = at.doc.replace(/\{([^}]+)\}/g, (_, op: string) => String(value(op, w)))
        return w.present.has(path)
      }
      case 'isNull': {
        const v = value(at.operand, w)
        return v !== NO_ACTOR && v === null
      }
      default: {
        const l = value(at.left, w)
        const r = value(at.right, w)
        if (l === NO_ACTOR || r === NO_ACTOR) return false
        if (at.op === 'eq') return l === r
        if (at.op === 'ne') return l !== r
        if (at.op === 'in') return Array.isArray(r) && (r as Literal[]).includes(l)
        return typeof l === 'number' && typeof r === 'number' && (at.op === 'lt' ? l < r : l > r)
      }
    }
  }
  // `opaque` (and an unknown ref, which expands to opaque) takes the value `opaqueAs`.
  const evalExpr = (e: Expr, w: World, opaqueAs: boolean): boolean => {
    if ('and' in e) return e.and.every(x => evalExpr(x, w, opaqueAs))
    if ('or' in e) return e.or.some(x => evalExpr(x, w, opaqueAs))
    if ('not' in e) return !evalExpr(e.not, w, opaqueAs)
    if ('atom' in e) return evalAtom(e.atom, w)
    if ('ref' in e) { const d = vocab.get(e.ref); return d ? evalExpr(d, w, opaqueAs) : opaqueAs }
    return opaqueAs
  }

  const pool: Expr[] = [
    a({ op: 'authenticated' }),
    a({ op: 'in', left: 'actor.role', right: { literal: ['admin'] } }),
    a({ op: 'in', left: 'actor.role', right: { literal: ['admin', 'member'] } }),
    a({ op: 'in', left: 'actor.role', right: { literal: [] } }),
    a({ op: 'eq', left: { literal: 'admin' }, right: 'actor.role' }),
    a({ op: 'eq', left: 'actor.role', right: { literal: 'member' } }),
    a({ op: 'eq', left: 'actor.uid', right: 'resource.owner_id' }),
    a({ op: 'eq', left: 'resource.owner_id', right: 'actor.uid' }),
    a({ op: 'ne', left: 'actor.uid', right: 'resource.owner_id' }),
    a({ op: 'ne', left: 'actor.role', right: { literal: 'admin' } }),
    a({ op: 'eq', left: 'actor.claim.t', right: { literal: true } }),
    a({ op: 'eq', left: 'actor.uid', right: { literal: 'u1' } }),
    a({ op: 'eq', left: 'actor.uid', right: { literal: null } }),
    a({ op: 'eq', left: 'actor.claim.t', right: { literal: 'a' } }),
    a({ op: 'in', left: 'actor.claim.t', right: { literal: ['a', 'b'] } }),
    a({ op: 'isNull', operand: 'resource.deleted_at' }),
    a({ op: 'isNull', operand: 'resource.team_id' }),
    a({ op: 'isNull', operand: 'actor.uid' }),
    a({ op: 'exists', doc: memberDoc }),
    a({ op: 'exists', doc: adminDoc }),
    { ref: 'staff' }, { ref: 'ghost' },
    { opaque: 'o1' }, { opaque: 'o2' },
  ]
  // True when the claim "c implies r" holds in every world, with opaque taken as true and as false on each side.
  const sound = (c: Expr, r: Expr): boolean => {
    for (const w of worlds) {
      for (const cOpaque of [true, false]) {
        if (!evalExpr(c, w, cOpaque)) continue
        for (const rOpaque of [true, false]) if (!evalExpr(r, w, rOpaque)) return false
      }
    }
    return true
  }

  it('is sound for every pair of pool atoms and their negations', () => {
    const leaves = [...pool, ...pool.map(x => ({ not: x }))]
    const unsound: string[] = []
    for (const c of leaves) for (const r of leaves) {
      if (implies(c, r, vocab).ok && !sound(c, r)) unsound.push(`${JSON.stringify(c)} => ${JSON.stringify(r)}`)
    }
    expect(unsound).toEqual([])
  })

  const leaf = fc.constantFrom(...pool)
  const expr: fc.Arbitrary<Expr> = fc.letrec<{ e: Expr }>(tie => ({
    e: fc.oneof(
      { depthSize: 'small', withCrossShrink: true },
      leaf,
      fc.array(tie('e'), { maxLength: 3 }).map(xs => ({ and: xs })),
      fc.array(tie('e'), { maxLength: 3 }).map(xs => ({ or: xs })),
      tie('e').map(x => ({ not: x })),
    ),
  })).e
  // Bias towards pairs the prover can prove, so the property is exercised, not vacuous.
  const pair: fc.Arbitrary<[Expr, Expr]> = fc.oneof(
    fc.tuple(expr, expr),
    fc.tuple(leaf, leaf, expr, expr).map(([p, q, y, z]): [Expr, Expr] => [{ and: [y, p] }, { or: [z, q] }]),
    fc.tuple(expr, expr).map(([x, y]): [Expr, Expr] => [{ and: [y, x] }, x]),
    fc.tuple(expr, expr).map(([x, y]): [Expr, Expr] => [x, { or: [y, x] }]),
    expr.map((x): [Expr, Expr] => [x, x]),
    fc.tuple(expr, expr, expr).map(([x, y, z]): [Expr, Expr] => [{ or: [{ and: [x, y] }, { and: [z, x] }] }, { or: [x, y] }]),
  )

  it('never proves a requirement that some world violates', () => {
    let proved = 0
    fc.assert(fc.property(pair, ([c, r]) => {
      if (!implies(c, r, vocab).ok) return true
      proved++
      return sound(c, r)
    }), { numRuns: 300 })
    expect(proved).toBeGreaterThan(50)
  })
})
