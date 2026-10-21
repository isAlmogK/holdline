import { describe, expect, it } from 'vitest'
import { checkLiteral, fillerValue } from '../src/testgen-filler.js'

describe('fillerValue', () => {
  it.each([
    ['uuid', 'filler'], ['text', 'x'], ['character varying(20)', 'x'], ['integer', 1], ['bigint', 1],
    ['numeric(10,2)', 1], ['double precision', 1], ['boolean', false],
    ['timestamp with time zone', '1970-01-01T00:00:00Z'], ['date', '1970-01-01'], ['jsonb', {}], ['text[]', []],
  ])('%s → %j', (type, value) => {
    expect(fillerValue({ name: 'c', type })).toEqual(value)
  })
  it('uses the first enum label', () => {
    expect(fillerValue({ name: 'role', type: 'member_role' }, { enumLabels: ['owner', 'admin'] })).toBe('owner')
  })
  it('uses the first literal of an IN or ANY check on the column', () => {
    const checks = ["((role = ANY (ARRAY['owner'::text, 'admin'::text])))"]
    expect(fillerValue({ name: 'role', type: 'text' }, { checks })).toBe('owner')
    expect(checkLiteral('status', ["(status IN ('active', 'archived'))"])).toBe('active')
    expect(checkLiteral('status', ["((role = ANY (ARRAY['owner'::text])))"])).toBeUndefined()
  })
})
