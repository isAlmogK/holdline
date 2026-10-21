import YAML from 'yaml'
import { z } from 'zod'
import { DataStoreSchema, OpSchema } from './facts.js'

export const ActorSchema = z.strictObject({
  uid: z.string(),
  role: z.string().optional(),
  claims: z.record(z.string(), z.unknown()).default({}),
})

export const SeedSchema = z.strictObject({ path: z.string(), data: z.record(z.string(), z.unknown()) })

export const TestCaseSchema = z.strictObject({
  name: z.string(),
  as: ActorSchema.nullable(),
  seed: z.array(SeedSchema).default([]),
  do: z.strictObject({ op: OpSchema, path: z.string(), data: z.record(z.string(), z.unknown()).optional() }),
  // reject: a write the database must refuse (invariant cases; generated from Phase 1).
  expect: z.enum(['allow', 'deny', 'reject']),
})

export const TestFileSchema = z.strictObject({
  rule: z.string(),
  generatedFrom: z.string(),
  store: DataStoreSchema,
  cases: z.array(TestCaseSchema),
  skipped: z.array(z.string()).default([]),
})

export type TestCase = z.output<typeof TestCaseSchema>
export type TestFile = z.output<typeof TestFileSchema>

export function parseTestFile(text: string, source = 'test file'): TestFile {
  const parsed = TestFileSchema.safeParse(YAML.parse(text))
  if (!parsed.success) throw new Error(`${source}: ${z.prettifyError(parsed.error)}`)
  return parsed.data
}

export function serializeTestFile(file: TestFile): string {
  return YAML.stringify(file, { lineWidth: 0, aliasDuplicateObjects: false })
}
