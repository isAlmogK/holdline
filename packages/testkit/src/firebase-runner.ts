// Runs Firestore and Storage test files against running emulators (spec 5.3). Needs FIRESTORE_EMULATOR_HOST
// (and FIREBASE_STORAGE_EMULATOR_HOST for Storage files); `emulator.ts` starts them when they are not set.
import { initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing'
import { TestFileSchema, type TestCase, type TestFile } from '@holdline/core'
import { z } from 'zod'
import { attempt, describeError, operate, seed, type Run } from './firebase-ops.js'
import type { CaseResult } from './report.js'

// Rules are file contents, not paths.
export const FirebaseInputSchema = z.strictObject({
  firestoreRules: z.string().optional(),
  storageRules: z.string().optional(),
  files: z.array(TestFileSchema),
})
export type FirebaseInput = { firestoreRules?: string; storageRules?: string; files: TestFile[] }

async function runCase(env: RulesTestEnvironment, file: TestFile, c: TestCase, storage: boolean): Promise<Run> {
  try {
    await env.clearFirestore()
    if (storage) await env.clearStorage()
    await env.withSecurityRulesDisabled(ctx => seed(ctx, c.seed))
  } catch (e) {
    return { actual: 'error', error: `seeding failed: ${describeError(e)}` }
  }
  // `as.role` has no Firestore meaning: only the uid and the token claims reach the rules.
  const ctx = c.as ? env.authenticatedContext(c.as.uid, c.as.claims) : env.unauthenticatedContext()
  return attempt(() => operate(ctx, file.store, c.do))
}

function result(c: TestCase, run: Run): CaseResult {
  // deny and reject both mean the emulator refused the request (assertFails).
  const passed = c.expect === 'allow' ? run.actual === 'allow' : run.actual === 'deny'
  const out: CaseResult = { name: c.name, expect: c.expect, actual: run.actual, passed }
  if (!passed) out.detail = `expected ${c.expect}, got ${run.actual}${run.error ? `: ${run.error}` : ''}`
  return out
}

export async function runFirebaseFiles(input: FirebaseInput): Promise<Record<string, CaseResult[]>> {
  const storage = input.storageRules !== undefined || input.files.some(f => f.store === 'storage')
  // A section without rules is left out: the emulator keeps the rules it started with.
  const env = await initializeTestEnvironment({
    projectId: 'holdline-test',
    ...(input.firestoreRules !== undefined ? { firestore: { rules: input.firestoreRules } } : {}),
    ...(input.storageRules !== undefined ? { storage: { rules: input.storageRules } } : {}),
  })
  const results: Record<string, CaseResult[]> = {}
  try {
    for (const file of input.files) {
      const cases = (results[file.rule] ??= [])
      for (const c of file.cases) cases.push(result(c, await runCase(env, file, c, storage)))
    }
  } finally {
    await env.cleanup()
  }
  return results
}
