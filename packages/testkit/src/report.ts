import type { DataStore } from '@holdline/core'
import { z } from 'zod'

export type Outcome = 'allow' | 'deny' | 'reject' | 'error'
export type CaseResult = { name: string; expect: 'allow' | 'deny' | 'reject'; actual: Outcome; passed: boolean; detail?: string }
// `store` is unset only for a note on a rule without a data target (an access rule named with --rule).
export type FileReport = { rule: string; store?: DataStore; generated?: 'missing' | 'changed' | 'refreshed'; cases: CaseResult[]; skipped: string[] }
export type InfraFailure = { store: DataStore; message: string }
export type TestReport = { files: FileReport[]; infrastructure: InfraFailure[] }

export const CaseResultSchema = z.strictObject({
  name: z.string(),
  expect: z.enum(['allow', 'deny', 'reject']),
  actual: z.enum(['allow', 'deny', 'reject', 'error']),
  passed: z.boolean(),
  detail: z.string().optional(),
})
