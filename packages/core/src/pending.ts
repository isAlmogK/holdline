import YAML from 'yaml'
import { z } from 'zod'
import { hashRule } from './hash.js'
import { collectRefs } from './logic.js'
import type { ProposalReport } from './proposals.js'
import { ProposedRuleSchema, RuleSchema, VocabularyEntrySchema, nextRuleId, vocabularyMap, type Rule, type RulesFile } from './rules.js'

const PendingRuleSchema = z.strictObject({
  key: z.string().regex(/^P-\d+$/),
  classification: z.enum(['holds', 'broken']),
  violations: z.array(z.string()).default([]),
  rule: ProposedRuleSchema,
})

export const PendingFileSchema = z.strictObject({
  version: z.literal(1),
  vocabulary: z.array(VocabularyEntrySchema).default([]),
  rules: z.array(PendingRuleSchema).default([]),
})

export type PendingRule = z.output<typeof PendingRuleSchema>
export type PendingFile = z.output<typeof PendingFileSchema>

export function emptyPending(): PendingFile {
  return { version: 1, vocabulary: [], rules: [] }
}

export function parsePendingFile(text: string): PendingFile {
  const parsed = PendingFileSchema.safeParse(YAML.parse(text) ?? { version: 1 })
  if (!parsed.success) throw new Error(`.holdline/pending.yaml: ${z.prettifyError(parsed.error)}`)
  return parsed.data
}

export function serializePendingFile(p: PendingFile): string {
  return YAML.stringify(p, { lineWidth: 0 })
}

export function addToPending(pending: PendingFile, report: ProposalReport): { pending: PendingFile; added: PendingRule[] } {
  let n = pending.rules.reduce((m, r) => Math.max(m, Number(r.key.slice(2))), 0)
  const added: PendingRule[] = report.rules
    .filter(o => o.classification !== 'rejected')
    .map(o => ({ key: `P-${++n}`, classification: o.classification as 'holds' | 'broken', violations: o.violations ?? [], rule: o.rule! }))
  const vocabIds = new Set(pending.vocabulary.map(v => v.id))
  const vocabulary = [...pending.vocabulary, ...report.vocabulary.filter(v => v.accepted && !vocabIds.has(v.entry!.id)).map(v => v.entry!)]
  return { pending: { ...pending, vocabulary, rules: [...pending.rules, ...added] }, added }
}

export function approve(
  file: RulesFile, pending: PendingFile, keys: string[] | 'all', approval: { by: string; at: string },
): { file: RulesFile; pending: PendingFile; approved: { key: string; id: string }[] } {
  const wanted = keys === 'all' ? pending.rules.map(r => r.key) : keys
  const unknown = wanted.filter(k => !pending.rules.some(r => r.key === k) && !file.rules.some(r => r.id === k))
  if (unknown.length > 0) throw new Error(`nothing pending or approved with key ${unknown.join(', ')}`)

  let next: RulesFile = { ...file, rules: [...file.rules], vocabulary: [...file.vocabulary] }
  const approved: { key: string; id: string }[] = []
  // Pending vocabulary ids never clash with approved ones (validateProposals rejects clashes).
  const vocab = vocabularyMap(file, pending.vocabulary)
  const stamp = (rule: Rule): Rule => ({ ...rule, status: 'approved', muted: undefined, approved: { ...approval, hash: hashRule(rule, vocab) } })

  for (const key of wanted) {
    const existingIndex = next.rules.findIndex(r => r.id === key)
    if (existingIndex >= 0) {
      next.rules[existingIndex] = stamp(next.rules[existingIndex]!)
      approved.push({ key, id: key })
      continue
    }
    const p = pending.rules.find(r => r.key === key)!
    const id = nextRuleId(next)
    next.rules.push(stamp(RuleSchema.parse({ ...p.rule, id, status: 'approved' })))
    approved.push({ key, id })
  }

  const needed = keys === 'all' ? new Set(pending.vocabulary.map(v => v.id)) : vocabularyNeeded(next.rules, pending)
  next = { ...next, vocabulary: [...next.vocabulary, ...pending.vocabulary.filter(v => needed.has(v.id))] }
  const done = new Set(approved.map(a => a.key))
  return {
    file: next,
    pending: { ...pending, rules: pending.rules.filter(r => !done.has(r.key)), vocabulary: pending.vocabulary.filter(v => !needed.has(v.id)) },
    approved,
  }
}

function vocabularyNeeded(rules: Rule[], pending: PendingFile): Set<string> {
  const byId = new Map(pending.vocabulary.map(v => [v.id, v]))
  const needed = new Set<string>()
  const visit = (ids: string[]) => {
    for (const id of ids) {
      if (needed.has(id) || !byId.has(id)) continue
      needed.add(id)
      visit(collectRefs(byId.get(id)!.expr))
    }
  }
  for (const rule of rules) if ('requires' in rule) visit(collectRefs(rule.requires))
  return needed
}

export function reject(pending: PendingFile, keys: string[]): PendingFile {
  const unknown = keys.filter(k => !pending.rules.some(r => r.key === k))
  if (unknown.length > 0) throw new Error(`nothing pending with key ${unknown.join(', ')}`)
  return { ...pending, rules: pending.rules.filter(r => !keys.includes(r.key)) }
}

export function mute(file: RulesFile, id: string, m: { by: string; at: string; reason: string }): RulesFile {
  if (!file.rules.some(r => r.id === id)) throw new Error(`no rule ${id}`)
  return { ...file, rules: file.rules.map(r => (r.id === id ? { ...r, status: 'muted', muted: m } : r)) }
}
