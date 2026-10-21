import { z } from 'zod'
import { ExprSchema } from './expr.js'

export const OPS = ['read', 'list', 'create', 'update', 'delete'] as const
export const OpSchema = z.enum(OPS)
export type Op = z.infer<typeof OpSchema>

export const DataStoreSchema = z.enum(['postgres', 'firestore', 'storage'])
export type DataStore = z.infer<typeof DataStoreSchema>

export const LocationSchema = z.strictObject({
  file: z.string(),
  line: z.number().int().positive(),
  endLine: z.number().int().positive().optional(),
})
export type Location = z.infer<typeof LocationSchema>

export const SymbolFactSchema = z.strictObject({
  id: z.string().min(1),
  kind: z.enum(['function', 'method', 'class', 'route', 'middleware', 'table', 'column', 'policy', 'match', 'collection']),
  lang: z.enum(['ts', 'go', 'py', 'sql', 'firestore', 'storage']),
  location: LocationSchema.optional(),
  hash: z.string().optional(),
})

export const RouteSchema = z.strictObject({
  id: z.string().min(1),
  method: z.string().min(1),
  path: z.string().startsWith('/'),
  handler: z.string().min(1),
  middleware: z.array(z.string()).default([]),
  framework: z.string().min(1),
  kind: z.enum(['http', 'callable', 'trigger']).default('http'),
})

export const GuardSchema = z.strictObject({
  at: z.string().min(1),
  requires: ExprSchema,
  evidence: LocationSchema.optional(),
})

export const DataOpSchema = z.strictObject({
  in: z.string().min(1),
  store: DataStoreSchema,
  target: z.string().min(1),
  op: OpSchema,
  filters: ExprSchema.optional(),
  evidence: LocationSchema.optional(),
})

export const TableSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  columns: z.array(z.strictObject({
    name: z.string(), type: z.string(), nullable: z.boolean(), default: z.string().optional(),
  })),
  primaryKey: z.array(z.string()).default([]),
  foreignKeys: z.array(z.strictObject({
    columns: z.array(z.string()).min(1),
    references: z.strictObject({ table: z.string(), columns: z.array(z.string()).min(1) }),
  })).default([]),
  uniques: z.array(z.array(z.string()).min(1)).default([]),
  checks: z.array(z.strictObject({ name: z.string().optional(), expr: z.string() })).default([]),
  enums: z.array(z.strictObject({ column: z.string(), values: z.array(z.string()) })).default([]),
  rlsEnabled: z.boolean().default(false),
  location: LocationSchema.optional(),
})

export const CollectionSchema = z.strictObject({
  path: z.string().startsWith('/'),
  fields: z.array(z.string()).default([]),
  source: z.enum(['converter', 'inferred']),
})

export const PolicySchema = z.strictObject({
  id: z.string().min(1),
  store: z.enum(['pg-rls', 'firestore', 'storage']),
  target: z.string().min(1),
  ops: z.array(OpSchema).min(1),
  condition: ExprSchema,
  functions: z.array(z.string()).default([]),
  evidence: LocationSchema.optional(),
})

export const DiagnosticSchema = z.strictObject({
  analyzer: z.string(),
  file: z.string(),
  message: z.string(),
  severity: z.enum(['error', 'warning']),
})

export const FactsSchema = z.strictObject({
  version: z.literal(1),
  analyzers: z.array(z.strictObject({ name: z.string(), version: z.string() })).default([]),
  symbols: z.array(SymbolFactSchema).default([]),
  routes: z.array(RouteSchema).default([]),
  guards: z.array(GuardSchema).default([]),
  dataOps: z.array(DataOpSchema).default([]),
  calls: z.array(z.tuple([z.string(), z.string()])).default([]),
  tables: z.array(TableSchema).default([]),
  collections: z.array(CollectionSchema).default([]),
  policies: z.array(PolicySchema).default([]),
  diagnostics: z.array(DiagnosticSchema).default([]),
})

export type SymbolFact = z.output<typeof SymbolFactSchema>
export type Route = z.output<typeof RouteSchema>
export type Guard = z.output<typeof GuardSchema>
export type DataOp = z.output<typeof DataOpSchema>
export type Table = z.output<typeof TableSchema>
export type Collection = z.output<typeof CollectionSchema>
export type Policy = z.output<typeof PolicySchema>
export type Diagnostic = z.output<typeof DiagnosticSchema>
export type Facts = z.output<typeof FactsSchema>
export type FactsInput = z.input<typeof FactsSchema>

export class FactsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FactsError'
  }
}

export function parseFacts(json: unknown, source = 'facts'): Facts {
  const parsed = FactsSchema.safeParse(json)
  if (!parsed.success) throw new FactsError(`${source}: ${z.prettifyError(parsed.error)}`)
  return parsed.data
}

export function emptyFacts(): Facts {
  return FactsSchema.parse({ version: 1 })
}

const LIST_KEYS = ['analyzers', 'symbols', 'routes', 'guards', 'dataOps', 'calls', 'tables', 'collections', 'policies', 'diagnostics'] as const

export function mergeFacts(parts: Facts[]): Facts {
  const out = emptyFacts()
  for (const part of parts) {
    for (const key of LIST_KEYS) (out[key] as unknown[]).push(...part[key])
  }
  return out
}
