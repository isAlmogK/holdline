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
  const rule = parseRulesFile(yamlText).rules[0]!
  it('ignores id, status, approval, mute and evidence', () => {
    const same = RuleSchema.parse({ ...rule, id: 'R-999', status: 'pending', approved: undefined, evidence: [] })
    expect(hashRule(same)).toBe(hashRule(rule))
    expect(hashRule(rule)).toMatch(/^[0-9a-f]{12}$/)
  })
  it('changes when the text or the requirement changes', () => {
    expect(hashRule(RuleSchema.parse({ ...rule, text: 'Anyone can read dogs' }))).not.toBe(hashRule(rule))
    expect(hashRule(RuleSchema.parse({ ...rule, ops: ['read'] }))).not.toBe(hashRule(rule))
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
