import { describe, expect, it } from 'vitest'
import { simplify } from '../src/simplify.js'

const A = { atom: { op: 'authenticated' } } as const
const B = { atom: { op: 'eq', left: 'resource.a', right: { literal: 1 } } } as const
const O = { opaque: 'x' }

describe('simplify', () => {
  it('flattens, dedupes and unwraps', () => {
    expect(simplify({ and: [A, { and: [A, B] }] })).toEqual({ and: [A, B] })
    expect(simplify({ or: [{ or: [B] }, B] })).toEqual(B)
    expect(simplify({ and: [{ and: [] }, B] })).toEqual(B)
    expect(simplify({ not: { not: B } })).toEqual(B)
  })
  it('keeps opaque and keeps true and false', () => {
    expect(simplify({ and: [O, O] })).toEqual({ and: [O, O] })
    expect(simplify({ and: [] })).toEqual({ and: [] })
    expect(simplify({ or: [] })).toEqual({ or: [] })
    expect(simplify({ and: [B, { or: [] }] })).toEqual({ and: [B, { or: [] }] })
  })
  it('keeps duplicate members that contain opaque', () => {
    expect(simplify({ or: [{ not: O }, { not: O }] })).toEqual({ or: [{ not: O }, { not: O }] })
  })
})
