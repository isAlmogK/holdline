import YAML from 'yaml'
import { z } from 'zod'
import { ExprSchema, type Expr } from './expr.js'
import { OpSchema } from './facts.js'

const RuleIdSchema = z.string().regex(/^R-\d{3,}$/, 'rule ids look like R-001')
const SlugSchema = z.string().regex(/^[a-z][a-z0-9-]*$/, 'vocabulary ids are lowercase slugs')

export const RecognizerSchema = z.union([
  z.strictObject({ 'firestore-function': z.string().min(1) }),
  z.strictObject({ symbol: z.string().min(1) }),
])

const ApprovalSchema = z.strictObject({ by: z.string(), at: z.string(), hash: z.string() })

export const VocabularyEntrySchema = z.strictObject({
  id: SlugSchema,
  text: z.string().min(1),
  expr: ExprSchema,
  recognize: z.array(RecognizerSchema).default([]),
  approved: ApprovalSchema.optional(),
})
export type VocabularyEntry = z.output<typeof VocabularyEntrySchema>

// Proposals and pending entries never carry approval: only `approve` stamps it.
export const ProposedVocabularySchema = VocabularyEntrySchema.omit({ approved: true })
export type ProposedVocabulary = z.output<typeof ProposedVocabularySchema>

export const RouteTargetSchema = z.strictObject({ routes: z.string().min(1) })
export const SymbolTargetSchema = z.strictObject({ symbol: z.string().min(1) })
export const DocTargetSchema = z.strictObject({ store: z.enum(['firestore', 'storage']), path: z.string().startsWith('/') })
export const TableTargetSchema = z.strictObject({ store: z.literal('postgres'), table: z.string().min(1) })
export const DataTargetSchema = z.union([DocTargetSchema, TableTargetSchema])
export type DataTarget = z.output<typeof DataTargetSchema>

export const ENFORCE = ['static', 'test', 'audit'] as const
export type Enforce = (typeof ENFORCE)[number]

const head = { id: RuleIdSchema, text: z.string().min(1) }
const tail = {
  evidence: z.array(z.string()).default([]),
  enforce: z.array(z.enum(ENFORCE)).optional(),
  status: z.enum(['pending', 'approved', 'muted']),
  approved: ApprovalSchema.optional(),
  muted: z.strictObject({ by: z.string(), at: z.string(), reason: z.string().min(1) }).optional(),
}

export const AccessRuleSchema = z.strictObject({
  ...head,
  type: z.literal('access'),
  target: z.union([RouteTargetSchema, SymbolTargetSchema]),
  requires: ExprSchema,
  ...tail,
})

export const DataAccessRuleSchema = z.strictObject({
  ...head,
  type: z.literal('data-access'),
  target: DataTargetSchema,
  ops: z.array(OpSchema).min(1),
  requires: ExprSchema,
  ...tail,
})

export const VisibilityRuleSchema = z.strictObject({
  ...head,
  type: z.literal('visibility'),
  target: DataTargetSchema,
  requires: ExprSchema,
  via: z.array(z.string()).default([]),
  ...tail,
})

export const FlowRuleSchema = z.strictObject({
  ...head,
  type: z.literal('flow'),
  target: DataTargetSchema,
  ops: z.array(OpSchema).min(1),
  via: z.array(z.string()).min(1),
  ...tail,
})

export const InvariantRuleSchema = z.strictObject({
  ...head,
  type: z.literal('invariant'),
  target: DataTargetSchema,
  kind: z.enum(['not-null', 'fk', 'unique', 'check', 'enum']),
  columns: z.array(z.string()).min(1),
  references: z.strictObject({ table: z.string().min(1), columns: z.array(z.string()).min(1) }).optional(),
  values: z.array(z.string()).min(1).optional(),
  expr: z.string().min(1).optional(),
  ...tail,
})

export const RuleSchema = z.discriminatedUnion('type', [
  AccessRuleSchema, DataAccessRuleSchema, VisibilityRuleSchema, FlowRuleSchema, InvariantRuleSchema,
])

const META = { id: true, status: true, approved: true, muted: true } as const
export const ProposedRuleSchema = z.discriminatedUnion('type', [
  AccessRuleSchema.omit(META), DataAccessRuleSchema.omit(META), VisibilityRuleSchema.omit(META),
  FlowRuleSchema.omit(META), InvariantRuleSchema.omit(META),
])

export type Rule = z.output<typeof RuleSchema>
export type RuleType = Rule['type']
export type AccessRule = z.output<typeof AccessRuleSchema>
export type DataAccessRule = z.output<typeof DataAccessRuleSchema>
export type VisibilityRule = z.output<typeof VisibilityRuleSchema>
export type FlowRule = z.output<typeof FlowRuleSchema>
export type InvariantRule = z.output<typeof InvariantRuleSchema>
export type ProposedRule = z.output<typeof ProposedRuleSchema>

export const RulesFileSchema = z.strictObject({
  version: z.literal(1),
  vocabulary: z.array(VocabularyEntrySchema).default([]),
  rules: z.array(RuleSchema).default([]),
  // Highest rule id ever assigned, so a deleted rule's id is never reused.
  lastRuleId: z.number().int().min(0).optional(),
})
export type RulesFile = z.output<typeof RulesFileSchema>

export class RulesFileError extends Error {}

export function validateRuleSemantics(rule: Rule | ProposedRule): string[] {
  if (rule.type !== 'invariant') return []
  const problems: string[] = []
  if (rule.kind === 'fk' && !rule.references) problems.push('fk needs references')
  if (rule.kind === 'enum' && !rule.values) problems.push('enum needs values')
  if (rule.kind === 'check' && !rule.expr) problems.push('check needs expr')
  if (rule.kind === 'fk' && rule.target.store !== 'postgres') problems.push('fk applies to postgres tables only')
  if (rule.kind === 'unique' && rule.target.store !== 'postgres') problems.push('unique applies to postgres tables only')
  if (rule.kind === 'check' && rule.target.store !== 'postgres') problems.push('check applies to postgres tables only')
  return problems
}

export function parseRulesFile(text: string, source = 'holdline.rules'): RulesFile {
  let raw: unknown
  try {
    raw = YAML.parse(text)
  } catch (e) {
    throw new RulesFileError(`${source}: invalid YAML: ${(e as Error).message}`)
  }
  const parsed = RulesFileSchema.safeParse(raw ?? { version: 1 })
  if (!parsed.success) throw new RulesFileError(`${source}: ${z.prettifyError(parsed.error)}`)
  const seen = new Set<string>()
  const problems: string[] = []
  const vocabIds = new Set<string>()
  for (const v of parsed.data.vocabulary) {
    if (vocabIds.has(v.id)) problems.push(`duplicate vocabulary id ${v.id}`)
    vocabIds.add(v.id)
  }
  for (const rule of parsed.data.rules) {
    if (seen.has(rule.id)) problems.push(`duplicate rule id ${rule.id}`)
    seen.add(rule.id)
    problems.push(...validateRuleSemantics(rule).map(p => `${rule.id}: ${p}`))
    if (rule.status === 'pending') problems.push(`${rule.id}: pending rules belong in .holdline/pending.yaml; approve them with holdline approve`)
    if (rule.status === 'muted' && !rule.muted) problems.push(`${rule.id}: status muted needs a muted block (by, at, reason)`)
    if (rule.status !== 'muted' && rule.muted) problems.push(`${rule.id}: a muted block needs status: muted`)
  }
  if (problems.length > 0) throw new RulesFileError(`${source}: ${problems.join('; ')}`)
  return parsed.data
}

export function serializeRulesFile(file: RulesFile): string {
  return YAML.stringify(file, { lineWidth: 0 })
}

export function emptyRulesFile(): RulesFile {
  return { version: 1, vocabulary: [], rules: [] }
}

export const DEFAULT_ENFORCE: Record<RuleType, Enforce[]> = {
  access: ['static'],
  'data-access': ['static', 'test'],
  visibility: ['static'],
  flow: ['static'],
  invariant: ['static', 'test'],
}

export function effectiveEnforce(rule: Rule): Enforce[] {
  return rule.enforce ?? DEFAULT_ENFORCE[rule.type]
}

export function vocabularyMap(file: RulesFile, extra: ProposedVocabulary[] = []): Map<string, Expr> {
  return new Map([...file.vocabulary, ...extra].map(v => [v.id, v.expr]))
}

export function nextRuleId(file: RulesFile): string {
  const max = file.rules.reduce((m, r) => Math.max(m, Number(r.id.slice(2))), file.lastRuleId ?? 0)
  return `R-${String(max + 1).padStart(3, '0')}`
}
