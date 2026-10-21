import { describe, expect, it } from 'vitest'
import { hashRule } from '../src/hash.js'
import {
  RuleSchema, RulesFileError, emptyRulesFile, nextRuleId, parseRulesFile, serializeRulesFile,
  validateRuleSemantics, vocabularyMap, effectiveEnforce,
} from '../src/rules.js'

const yamlText = `
version: 1
vocabulary:
  - id: account-member
    text: Caller is a member of the record's account
    expr: { atom: { op: exists, doc: "/accounts/{param.accountId}/members/{actor.uid}" } }
    recognize:
      - firestore-function: isAccountMember
rules:
  - id: R-001
    text: Only account members can read the account's dogs
    type: data-access
    target: { store: firestore, path: "/accounts/{accountId}/dogs/{dogId}" }
    ops: [read, list]
    requires: { ref: account-member }
    evidence: ["firestore:/accounts/{accountId}/dogs/{dogId}"]
    status: approved
    approved: { by: almog, at: "2026-10-21", hash: abc }
  - id: R-002
    text: Every dog belongs to a team
    type: invariant
    target: { store: postgres, table: dogs }
    kind: not-null
    columns: [team_id]
    status: pending
`

describe('parseRulesFile', () => {
  it('parses vocabulary and rules', () => {
    const f = parseRulesFile(yamlText)
    expect(f.vocabulary[0]!.id).toBe('account-member')
    expect(f.rules.map(r => r.type)).toEqual(['data-access', 'invariant'])
  })
  it('treats an empty file as empty rules', () => {
    expect(parseRulesFile('')).toEqual(emptyRulesFile())
  })
  it('reports schema problems with the source name', () => {
    expect(() => parseRulesFile('version: 1\nrules: [{ id: X-1 }]', 'holdline.rules')).toThrow(/holdline\.rules/)
    expect(() => parseRulesFile('version: 1\nrules: [{ id: X-1 }]')).toThrow(RulesFileError)
  })
  it('reports invalid YAML', () => {
    expect(() => parseRulesFile('rules: [')).toThrow(/invalid YAML/)
  })
  it('rejects duplicate ids', () => {
    const dup = yamlText.replace('id: R-002', 'id: R-001')
    expect(() => parseRulesFile(dup)).toThrow(/duplicate rule id R-001/)
  })
  it('rejects invariants missing their kind-specific fields', () => {
    const bad = yamlText.replace('kind: not-null', 'kind: fk')
    expect(() => parseRulesFile(bad)).toThrow(/R-002: fk needs references/)
  })
})

describe('serializeRulesFile', () => {
  it('round-trips', () => {
    const f = parseRulesFile(yamlText)
    expect(parseRulesFile(serializeRulesFile(f))).toEqual(f)
  })
  it('writes id and text before other fields', () => {
    const out = serializeRulesFile(parseRulesFile(yamlText))
    expect(out.indexOf('id: R-001')).toBeLessThan(out.indexOf('text: Only account members'))
    expect(out.indexOf('text: Only account members')).toBeLessThan(out.indexOf('type: data-access'))
  })
})

describe('hashRule', () => {
  const file = parseRulesFile(yamlText)
  const vocab = vocabularyMap(file)
  const dataRule = file.rules[0]!
  const invariant = file.rules[1]!
  it('ignores id, status, approval, mute and evidence', () => {
    const same = RuleSchema.parse({ ...dataRule, id: 'R-999', status: 'pending', approved: undefined, evidence: [] })
    expect(hashRule(same, vocab)).toBe(hashRule(dataRule, vocab))
    expect(hashRule(dataRule, vocab)).toMatch(/^[0-9a-f]{12}$/)
  })
  it('changes when the text or the requirement changes', () => {
    expect(hashRule(RuleSchema.parse({ ...dataRule, text: 'Anyone can read dogs' }), vocab)).not.toBe(hashRule(dataRule, vocab))
    expect(hashRule(RuleSchema.parse({ ...dataRule, ops: ['read'] }), vocab)).not.toBe(hashRule(dataRule, vocab))
  })
  it.each([
    ['text', { text: 'Anyone can read dogs' }],
    ['requires', { requires: { atom: { op: 'exists', doc: '/accounts/{param.accountId}/admins/{actor.uid}' } } }],
    ['target', { target: { store: 'firestore', path: '/accounts/{accountId}/cats/{catId}' } }],
    ['ops', { ops: ['read'] }],
    ['enforce', { enforce: ['static'] }],
  ])('changes when data-access field %s changes', (_field, patch) => {
    expect(hashRule(RuleSchema.parse({ ...dataRule, ...patch }), vocab)).not.toBe(hashRule(dataRule, vocab))
  })
  it.each([
    ['kind and references', { kind: 'fk', references: { table: 'teams', columns: ['id'] } }],
    ['columns', { columns: ['owner_id'] }],
    ['values', { kind: 'enum', values: ['a', 'b'] }],
    ['expr', { kind: 'check', expr: 'x > 0' }],
  ])('changes when invariant field %s changes', (_field, patch) => {
    expect(hashRule(RuleSchema.parse({ ...invariant, ...patch }), vocab)).not.toBe(hashRule(invariant, vocab))
  })
  it('does not change when id, status, approval, mute or evidence change', () => {
    const meta = RuleSchema.parse({
      ...dataRule,
      id: 'R-999',
      status: 'muted',
      approved: { by: 'x', at: '2026-01-01', hash: 'y' },
      muted: { by: 'x', at: '2026-01-01', reason: 'noise' },
      evidence: ['firestore:/other'],
    })
    expect(hashRule(meta, vocab)).toBe(hashRule(dataRule, vocab))
  })
  it('changes when the vocabulary expr behind a ref changes', () => {
    const changed = new Map(vocab)
    changed.set('account-member', { atom: { op: 'exists', doc: '/accounts/{param.accountId}/admins/{actor.uid}' } })
    expect(hashRule(dataRule, changed)).not.toBe(hashRule(dataRule, vocab))
  })
  it('hashes an unknown ref deterministically', () => {
    const r = RuleSchema.parse({ ...dataRule, requires: { ref: 'no-such-predicate' } })
    expect(hashRule(r, vocab)).toMatch(/^[0-9a-f]{12}$/)
    expect(hashRule(r, vocab)).toBe(hashRule(r, vocab))
  })
})

describe('helpers', () => {
  it('validateRuleSemantics checks invariant fields', () => {
    const r = RuleSchema.parse({ id: 'R-001', text: 't', type: 'invariant', target: { store: 'postgres', table: 'x' }, kind: 'enum', columns: ['c'], status: 'pending' })
    expect(validateRuleSemantics(r)).toEqual(['enum needs values'])
  })
  it('effectiveEnforce uses per-type defaults', () => {
    const f = parseRulesFile(yamlText)
    expect(effectiveEnforce(f.rules[0]!)).toEqual(['static', 'test'])
  })
  it('vocabularyMap and nextRuleId', () => {
    const f = parseRulesFile(yamlText)
    expect(vocabularyMap(f).has('account-member')).toBe(true)
    expect(nextRuleId(f)).toBe('R-003')
    expect(nextRuleId(emptyRulesFile())).toBe('R-001')
  })
})
