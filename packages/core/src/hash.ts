import { canonicalJson, sha256Hex } from './canonical.js'
import { expand, type Vocabulary } from './logic.js'
import type { Rule, VocabularyEntry } from './rules.js'

const UNHASHED = new Set(['id', 'status', 'approved', 'muted', 'evidence'])

// Hash parsed rules only (RuleSchema output), so defaults such as `via: []` are always present.
// `requires` is hashed after expanding its refs against `vocab`, so editing a vocabulary entry
// changes the hash of every rule that uses it. Pass the same vocabulary `check` uses: vocabularyMap(file).
export function hashRule(rule: Rule, vocab: Vocabulary): string {
  const expanded = 'requires' in rule ? { ...rule, requires: expand(rule.requires, vocab) } : rule
  const fields = Object.fromEntries(Object.entries(expanded).filter(([k]) => !UNHASHED.has(k)))
  return sha256Hex(canonicalJson(fields)).slice(0, 12)
}

// Approval hash of a vocabulary entry: everything but its approval stamp. `recognize` is included
// because it changes what analyzers emit, and so which code a rule accepts.
export function hashVocabulary(entry: VocabularyEntry): string {
  const { id, text, expr, recognize } = entry
  return sha256Hex(canonicalJson({ id, text, expr, recognize })).slice(0, 12)
}
