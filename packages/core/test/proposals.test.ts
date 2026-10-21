import { describe, expect, it } from 'vitest'
import { runChecks } from '../src/check/run.js'
import { parseFacts } from '../src/facts.js'
import { PendingFileError, addToPending, approve, emptyPending, mute, parsePendingFile, reject, serializePendingFile } from '../src/pending.js'
import { ProposalError, validateProposals } from '../src/proposals.js'
import { hashVocabulary } from '../src/hash.js'
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
    expect(runChecks(facts, again.file).results.find(r => r.rule === 'R-001')!.status).toBe('violation')
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
  it('guards vocabulary clashes and duplicates in pending', () => {
    const redefined = { ...staffVocab, expr: { atom: { op: 'in', left: 'actor.role', right: { literal: ['owner'] } } } }
    const second = validateProposals({ vocabulary: [redefined], rules: [{ ...transferRule, text: 'Other wording', evidence: ['h:transfer'], target: { routes: 'POST /dogs/*/transfer' } }] }, facts, emptyRulesFile())
    const out = addToPending(pending, second)
    expect(out.added).toEqual([])
    expect(out.pending).toEqual(pending)
    expect(out.conflicts[0]!.reason).toMatch(/vocabulary staff is already pending with a different definition/)
  })
  it('does not duplicate pending rules or same-definition vocabulary', () => {
    const again = addToPending(pending, report)
    expect(again.pending.rules.map(r => r.key)).toEqual(['P-1', 'P-2'])
    expect(again.pending.vocabulary).toHaveLength(1)
    expect(again.added).toEqual([])
    expect(again.conflicts.map(c => c.reason)).toEqual(['duplicate of pending P-1', 'duplicate of pending P-2'])
  })
  it('approve throws when pending vocabulary clashes with the file', () => {
    const { file } = approve(emptyRulesFile(), pending, ['P-2'], { by: 'a', at: 'b' })
    expect(() => approve(file, pending, ['P-1'], { by: 'a', at: 'b' })).toThrow(/staff/)
  })
  it('approve de-duplicates keys', () => {
    const out = approve(emptyRulesFile(), pending, ['P-2', 'P-2'], { by: 'a', at: 'b' })
    expect(out.file.rules).toHaveLength(1)
    expect(out.approved).toHaveLength(1)
  })
  it('approve stamps the vocabulary it moves into the file', () => {
    const out = approve(emptyRulesFile(), pending, ['P-2'], { by: 'almog', at: '2026-10-21' })
    const staff = out.file.vocabulary[0]!
    expect(staff.approved).toEqual({ by: 'almog', at: '2026-10-21', hash: hashVocabulary(staff) })
  })
  it('flags edited or unstamped vocabulary, and approve vocabulary:<id> clears it', () => {
    const { file } = approve(emptyRulesFile(), pending, 'all', { by: 'almog', at: '2026-10-21' })
    const status = (f: typeof file) => runChecks(facts, f).results.filter(r => r.rule === 'vocabulary:staff')
    expect(status(file)).toEqual([])
    const edited = { ...file, vocabulary: file.vocabulary.map(v => ({ ...v, recognize: [{ symbol: 'h:staffOnly' }] })) }
    expect(status(edited)).toEqual([{
      rule: 'vocabulary:staff', status: 'unapproved-edit', target: 'vocabulary',
      message: 'vocabulary staff was changed without approval. Approve it with `holdline approve vocabulary:staff`, or restore it.',
    }])
    const handAdded = { ...file, vocabulary: [...file.vocabulary, { id: 'owner', text: 'Caller owns it', expr: { atom: { op: 'authenticated' as const } }, recognize: [] }] }
    expect(runChecks(facts, handAdded).results.filter(r => r.status === 'unapproved-edit').map(r => r.rule)).toEqual(['vocabulary:owner'])
    const again = approve(edited, { ...pending, rules: [], vocabulary: [] }, ['vocabulary:staff'], { by: 'almog', at: '2026-10-22' })
    expect(again.approved).toEqual([{ key: 'vocabulary:staff', id: 'vocabulary:staff' }])
    expect(status(again.file)).toEqual([])
    expect(again.file.vocabulary[0]!.approved).toMatchObject({ by: 'almog', at: '2026-10-22' })
    expect(() => approve(file, pending, ['vocabulary:ghost'], { by: 'a', at: 'b' })).toThrow(/vocabulary:ghost/)
  })
  it('rejects proposed or pending vocabulary that carries approval', () => {
    const r = validateProposals({ vocabulary: [{ ...staffVocab, approved: { by: 'x', at: 'y', hash: 'z' } }], rules: [] }, facts, emptyRulesFile())
    expect(r.vocabulary.map(v => v.accepted)).toEqual([false])
    const text = serializePendingFile({ ...pending, vocabulary: [{ ...pending.vocabulary[0]!, approved: { by: 'x', at: 'y', hash: 'z' } } as never] })
    expect(() => parsePendingFile(text)).toThrow(/approved/)
  })
  it('throws PendingFileError for malformed YAML and schema errors', () => {
    expect(() => parsePendingFile('rules: [')).toThrow(PendingFileError)
    expect(() => parsePendingFile('rules: [')).toThrow(/\.holdline\/pending\.yaml: invalid YAML/)
    expect(() => parsePendingFile('version: 1\nrules: [{ key: X }]')).toThrow(PendingFileError)
  })
  it('rejects proposals that carry approval state, and clamps limit', () => {
    const r = validateProposals({ vocabulary: [staffVocab], rules: [{ ...transferRule, status: 'approved' }, { ...transferRule, approved: { by: 'x', at: 'y', hash: 'z' } }] }, facts, emptyRulesFile())
    expect(r.rules.map(o => o.classification)).toEqual(['rejected', 'rejected'])
    const neg = validateProposals({ vocabulary: [staffVocab], rules: [transferRule] }, facts, emptyRulesFile(), { limit: -3 })
    expect(neg.dropped).toBe(1)
  })
})
