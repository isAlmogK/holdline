import { describe, expect, it } from 'vitest'
import { isUuid, mapValue, stableInt, uuidV5 } from '../src/values.js'

describe('values', () => {
  it('uuidV5 is a stable, valid v5 uuid', () => {
    expect(uuidV5('user-1')).toBe(uuidV5('user-1'))
    expect(uuidV5('user-1')).not.toBe(uuidV5('user-2'))
    expect(uuidV5('user-1')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
  it('maps by column type and records uuid mappings', () => {
    const uuids = new Map<string, string>()
    expect(mapValue('user-1', 'uuid', uuids)).toBe(uuidV5('user-1'))
    expect(uuids.get('user-1')).toBe(uuidV5('user-1'))
    const real = '11111111-1111-4111-8111-111111111111'
    expect(mapValue(real, 'uuid', uuids)).toBe(real)
    expect(mapValue('value-1', 'integer', uuids)).toBe(stableInt('value-1'))
    expect(mapValue(5, 'integer', uuids)).toBe(5)
    expect(mapValue({ a: 1 }, 'jsonb', uuids)).toBe('{"a":1}')
    expect(mapValue(['a'], 'uuid[]', uuids)).toEqual([uuidV5('a')])
    expect(mapValue(null, 'uuid', uuids)).toBeNull()
    expect(mapValue('x', 'text', uuids)).toBe('x')
    expect(isUuid('nope')).toBe(false)
  })
})
