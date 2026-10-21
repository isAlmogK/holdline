import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { Atom, Expr } from '../src/expr.js'
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
