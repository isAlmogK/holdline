import { describe, expect, it } from 'vitest'
import { HOLDLINE_FACTS_VERSION } from '../src/index.js'

describe('core package', () => {
  it('exposes the facts version', () => {
    expect(HOLDLINE_FACTS_VERSION).toBe(1)
  })
})
