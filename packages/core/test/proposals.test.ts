import { describe, expect, it } from 'vitest'
import { runChecks } from '../src/check/run.js'
import { parseFacts } from '../src/facts.js'
import { addToPending, approve, emptyPending, mute, parsePendingFile, reject, serializePendingFile } from '../src/pending.js'
import { ProposalError, validateProposals } from '../src/proposals.js'
import { emptyRulesFile } from '../src/rules.js'

const facts = parseFacts({
  version: 1,
  symbols: [{ id: 'h:transfer', kind: 'function', lang: 'ts' }, { id: 'h:archive', kind: 'function', lang: 'ts' }],
  routes: [
    { id: 'route:POST /dogs/:id/transfer', method: 'POST', path: '/dogs/:id/transfer', handler: 'h:transfer', framework: 'express' },
    { id: 'route:POST /dogs/:id/archive', method: 'POST', path: '/dogs/:id/archive', handler: 'h:archive', framework: 'express' },
  ],
  guards: [{ at: 'h:transfer', requires: { ref: 'staff' } }],
})
const staffVocab = { id: 'staff', text: 'Caller is staff', expr: { atom: { op: 'in', left: 'actor.role', right: { literal: ['admin'] } } } }
const transferRule = { text: 'Only staff transfer dogs', type: 'access', target: { routes: 'POST /dogs/*/transfer' }, requires: { ref: 'staff' }, evidence: ['h:transfer'] }
const archiveRule = { text: 'Only staff archive dogs', type: 'access', target: { routes: 'POST /dogs/*/archive' }, requires: { ref: 'staff' }, evidence: ['h:archive'] }

describe('validateProposals', () => {
  it('classifies holds, broken and rejected', () => {
    const report = validateProposals({
      vocabulary: [staffVocab],
      rules: [
        transferRule,
        archiveRule,
        { ...transferRule, text: 'Duplicate wording' },
        { text: 'Cats', type: 'access', target: { routes: 'GET /cats' }, requires: { ref: 'staff' } },
        { text: 'Bad evidence', type: 'access', target: { routes: 'POST /dogs/*/transfer' }, requires: { ref: 'staff' }, evidence: ['h:nope'] },
        { text: 'Unknown predicate', type: 'access', target: { routes: 'POST /dogs/*/transfer' }, requires: { ref: 'ghost' } },
        { type: 'access' },
      ],
    }, facts, emptyRulesFile())
    expect(report.vocabulary.map(v => v.accepted)).toEqual([true])
    const byText = Object.fromEntries(report.rules.map(r => [(r.rule?.text ?? 'invalid'), r]))
    expect(byText['Only staff archive dogs']!.classification).toBe('broken')
    expect(byText['Only staff archive dogs']!.violations![0]).toMatch(/archive does not check staff/)
    expect(byText['Only staff transfer dogs']!.classification).toBe('holds')
    expect(byText['Duplicate wording']!.reason).toMatch(/duplicate/)
    expect(byText['Cats']!.reason).toMatch(/target not found/)
    expect(byText['Bad evidence']!.reason).toMatch(/evidence not found: h:nope/)
    expect(byText['Unknown predicate']!.reason).toMatch(/unknown predicate ghost/)
    expect(byText['invalid']!.classification).toBe('rejected')
  })
  it('ranks broken first and keeps the top N', () => {
    const report = validateProposals({ vocabulary: [staffVocab], rules: [transferRule, archiveRule] }, facts, emptyRulesFile(), { limit: 1 })
    const kept = report.rules.filter(r => r.classification !== 'rejected')
    expect(kept.map(r => r.rule!.text)).toEqual(['Only staff archive dogs'])
    expect(report.dropped).toBe(1)
  })
  it('throws ProposalError for input that is not a proposal batch', () => {
    expect(() => validateProposals([1, 2], facts, emptyRulesFile())).toThrow(ProposalError)
  })
})

describe('pending and approval', () => {
  const report = validateProposals({ vocabulary: [staffVocab], rules: [transferRule, archiveRule] }, facts, emptyRulesFile())
  const { pending, added } = addToPending(emptyPending(), report)

  it('assigns pending keys and round-trips', () => {
    expect(added.map(a => a.key)).toEqual(['P-1', 'P-2'])
    expect(parsePendingFile(serializePendingFile(pending))).toEqual(pending)
  })
  it('approves rules with ids, hashes and their vocabulary', () => {
    const out = approve(emptyRulesFile(), pending, ['P-2'], { by: 'almog', at: '2026-10-21' })
    expect(out.approved).toEqual([{ key: 'P-2', id: 'R-001' }])
    expect(out.file.vocabulary.map(v => v.id)).toEqual(['staff'])
    expect(out.pending.rules.map(r => r.key)).toEqual(['P-1'])
    expect(out.pending.vocabulary).toEqual([])
    const results = runChecks(facts, out.file).results
    expect(results.map(r => r.status)).toEqual(['pass'])
  })
  it('re-approves an edited rule by its R id', () => {
    const first = approve(emptyRulesFile(), pending, 'all', { by: 'almog', at: '2026-10-21' })
    const edited = { ...first.file, rules: first.file.rules.map(r => (r.id === 'R-001' ? { ...r, text: 'Only staff may transfer a dog' } : r)) }
    expect(runChecks(facts, edited).results.find(r => r.rule === 'R-001')!.status).toBe('unapproved-edit')
    const again = approve(edited, first.pending, ['R-001'], { by: 'almog', at: '2026-10-22' })
    expect(runChecks(facts, again.file).results.find(r => r.rule === 'R-001')!.status).not.toBe('unapproved-edit')
  })
  it('rejects unknown keys, and reject removes pending rules', () => {
    expect(() => approve(emptyRulesFile(), pending, ['P-9'], { by: 'a', at: 'b' })).toThrow(/P-9/)
    expect(reject(pending, ['P-1']).rules.map(r => r.key)).toEqual(['P-2'])
  })
  it('mute records who, when and why', () => {
    const { file } = approve(emptyRulesFile(), pending, 'all', { by: 'almog', at: '2026-10-21' })
    const muted = mute(file, 'R-001', { by: 'almog', at: '2026-10-22', reason: 'migrating' })
    expect(muted.rules[0]).toMatchObject({ status: 'muted', muted: { reason: 'migrating' } })
    expect(() => mute(file, 'R-404', { by: 'a', at: 'b', reason: 'c' })).toThrow(/R-404/)
  })
})
