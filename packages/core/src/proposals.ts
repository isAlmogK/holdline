import { z } from 'zod'
import { canonicalJson } from './canonical.js'
import { evaluateRule } from './check/run.js'
import { FactIndex } from './fact-index.js'
import type { Facts } from './facts.js'
import { collectRefs } from './logic.js'
import {
  ProposedRuleSchema, ProposedVocabularySchema, validateRuleSemantics, vocabularyMap,
  type ProposedRule, type ProposedVocabulary, type Rule, type RulesFile,
} from './rules.js'

export const ProposalBatchSchema = z.strictObject({
  vocabulary: z.array(ProposedVocabularySchema).default([]),
  rules: z.array(ProposedRuleSchema).default([]),
})

export class ProposalError extends Error {}

export type Classification = 'holds' | 'broken' | 'rejected'
export type RuleOutcome = { classification: Classification; rule?: ProposedRule; raw: unknown; reason?: string; violations?: string[] }
export type VocabularyOutcome = { accepted: boolean; entry?: ProposedVocabulary; raw: unknown; reason?: string }
export type ProposalReport = { rules: RuleOutcome[]; vocabulary: VocabularyOutcome[]; dropped: number }

const RawBatch = z.object({ vocabulary: z.array(z.unknown()).default([]), rules: z.array(z.unknown()).default([]) })

export function ruleKey(rule: ProposedRule | Rule): string {
  const { text: _t, evidence: _e, enforce: _f, ...rest } = rule as Record<string, unknown>
  for (const k of ['id', 'status', 'approved', 'muted']) delete rest[k]
  return canonicalJson(rest)
}

export function validateProposals(input: unknown, facts: Facts, file: RulesFile, opts: { limit?: number } = {}): ProposalReport {
  const batch = RawBatch.safeParse(input)
  if (!batch.success) throw new ProposalError(`proposals must be an object with "vocabulary" and "rules" arrays: ${z.prettifyError(batch.error)}`)

  const knownVocab = new Set(file.vocabulary.map(v => v.id))
  const vocabulary: VocabularyOutcome[] = batch.data.vocabulary.map(raw => {
    const parsed = ProposedVocabularySchema.safeParse(raw)
    if (!parsed.success) return { accepted: false, raw, reason: z.prettifyError(parsed.error) }
    if (knownVocab.has(parsed.data.id)) return { accepted: false, raw, entry: parsed.data, reason: `vocabulary id ${parsed.data.id} already exists` }
    knownVocab.add(parsed.data.id)
    return { accepted: true, raw, entry: parsed.data }
  })
  const accepted = vocabulary.filter(v => v.accepted).map(v => v.entry!)
  const vocab = vocabularyMap(file, accepted)
  const index = new FactIndex(facts)
  const existing = new Map(file.rules.map(r => [ruleKey(r), r.id]))
  const seen = new Set<string>()

  const outcomes: RuleOutcome[] = batch.data.rules.map(raw => {
    const parsed = ProposedRuleSchema.safeParse(raw)
    if (!parsed.success) return { classification: 'rejected', raw, reason: z.prettifyError(parsed.error) }
    const rule = parsed.data
    const reject = (reason: string): RuleOutcome => ({ classification: 'rejected', raw, rule, reason })
    const semantic = validateRuleSemantics(rule)
    if (semantic.length > 0) return reject(semantic.join('; '))
    const refs = 'requires' in rule ? collectRefs(rule.requires) : []
    const unknownRef = refs.find(r => !vocab.has(r))
    if (unknownRef) return reject(`unknown predicate ${unknownRef}; propose it in "vocabulary"`)
    const missing = rule.evidence.filter(id => !index.hasId(id))
    if (missing.length > 0) return reject(`evidence not found: ${missing.join(', ')}`)
    const key = ruleKey(rule)
    if (existing.has(key)) return reject(`duplicate of ${existing.get(key)}`)
    if (seen.has(key)) return reject('duplicate of another proposal in this batch')
    seen.add(key)
    const outcome = evaluateRule(rule, { index, vocab })
    if ('stale' in outcome) return reject(`target not found: ${outcome.stale}`)
    if (outcome.violations.length > 0) {
      return { classification: 'broken', raw, rule, violations: outcome.violations.map(v => v.message) }
    }
    return { classification: 'holds', raw, rule }
  })

  const limit = Math.max(0, opts.limit ?? 25)
  const kept = outcomes
    .filter(o => o.classification !== 'rejected')
    .sort((a, b) => Number(b.classification === 'broken') - Number(a.classification === 'broken')
      || b.rule!.evidence.length - a.rule!.evidence.length)
  return {
    vocabulary,
    rules: [...kept.slice(0, limit), ...outcomes.filter(o => o.classification === 'rejected')],
    dropped: Math.max(0, kept.length - limit),
  }
}
