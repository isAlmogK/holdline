import { describe, expect, it } from 'vitest'
import { canonicalJson, deepEqual } from '../src/canonical.js'
import { ExprSchema, OperandSchema } from '../src/expr.js'
import { formatExpr } from '../src/format.js'

describe('canonicalJson', () => {
  it('sorts keys at every level and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: undefined } }))
      .toBe('{"a":{"d":[2,{"y":2,"z":1}]},"b":1}')
  })
  it('deepEqual ignores key order', () => {
    expect(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true)
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false)
  })
})

describe('OperandSchema', () => {
  it('accepts the documented operand forms', () => {
    for (const o of ['actor.uid', 'actor.role', 'actor.claim.team_id', 'resource.owner_id', 'incoming.name', 'param.accountId']) {
      expect(OperandSchema.safeParse(o).success).toBe(true)
    }
    expect(OperandSchema.safeParse({ literal: ['admin'] }).success).toBe(true)
  })
  it('rejects anything else', () => {
    expect(OperandSchema.safeParse('request.auth.uid').success).toBe(false)
    expect(OperandSchema.safeParse('param.a.b').success).toBe(false)
  })
})

describe('ExprSchema', () => {
  it('parses nested expressions', () => {
    const e = {
      and: [
        { atom: { op: 'authenticated' } },
        { or: [{ ref: 'account-member' }, { not: { opaque: 'x' } }] },
        { atom: { op: 'in', left: 'actor.role', right: { literal: ['admin'] } } },
      ],
    }
    expect(ExprSchema.parse(e)).toEqual(e)
  })
  it('rejects unknown keys and ops', () => {
    expect(ExprSchema.safeParse({ atom: { op: 'like', left: 'actor.uid', right: 'resource.x' } }).success).toBe(false)
    expect(ExprSchema.safeParse({ and: [], extra: 1 }).success).toBe(false)
  })
})

describe('formatExpr', () => {
  it('prints readable conditions', () => {
    expect(formatExpr({
      and: [
        { atom: { op: 'eq', left: 'actor.uid', right: 'resource.owner_id' } },
        { or: [{ ref: 'staff' }, { atom: { op: 'isNull', operand: 'resource.deleted_at' } }] },
      ],
    })).toBe('actor.uid == resource.owner_id and (staff or resource.deleted_at is null)')
    expect(formatExpr({ atom: { op: 'in', left: 'actor.role', right: { literal: ['admin', 'owner'] } } }))
      .toBe('actor.role in ["admin","owner"]')
    expect(formatExpr({ and: [] })).toBe('true')
    expect(formatExpr({ or: [] })).toBe('false')
    expect(formatExpr({ opaque: 'customCheck()' })).toBe('<customCheck()>')
    expect(formatExpr({ atom: { op: 'exists', doc: '/accounts/{param.a}/members/{actor.uid}' } }))
      .toBe('exists(/accounts/{param.a}/members/{actor.uid})')
  })
})
