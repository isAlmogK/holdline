import { canonicalJson, sha256Hex } from './canonical.js'
import type { Rule } from './rules.js'

const UNHASHED = new Set(['id', 'status', 'approved', 'muted', 'evidence'])

// Hash parsed rules only (RuleSchema output), so defaults such as `via: []` are always present.
export function hashRule(rule: Rule): string {
  const fields = Object.fromEntries(Object.entries(rule).filter(([k]) => !UNHASHED.has(k)))
  return sha256Hex(canonicalJson(fields)).slice(0, 12)
}
