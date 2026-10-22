import { describe, expect, it } from 'vitest'
import { evaluateRule, FactIndex, parseFacts, ProposedRuleSchema } from '@holdline/core'
import { analyzeRulesFile } from '../src/analyze-file.js'

/** Runs core's data-access check on one rules file's facts. */
function check(file: string, src: string, path: string, op: 'create' | 'read') {
  const out = analyzeRulesFile(file, src, [])
  const facts = parseFacts({ version: 1, analyzers: [{ name: 'firestore', version: '0' }], ...out })
  const store = file.startsWith('storage') ? 'storage' : 'firestore'
  const rule = ProposedRuleSchema.parse({
    text: `${op} requires a signed-in user`, type: 'data-access', target: { store, path }, ops: [op], requires: { atom: { op: 'authenticated' } },
  })
  return evaluateRule(rule, { index: new FactIndex(facts), vocab: new Map() })
}

describe('prefixes end to end (data-access)', () => {
  it('reports a literal-bucket block that allows anyone', () => {
    const src = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o { match /images/{id} { allow write: if request.auth != null; } }
  match /b/my-app.appspot.com/o { match /images/{id} { allow write: if true; } }
}`
    const outcome = check('storage.rules', src, '/images/{id}', 'create')
    expect(outcome).toMatchObject({ violations: [expect.objectContaining({ message: expect.stringContaining('create on') })] })
  })
  it('reports a literal-database block that allows anyone', () => {
    const src = `service cloud.firestore {
  match /databases/{database}/documents { match /notes/{id} { allow read: if request.auth != null; } }
  match /databases/(default)/documents { match /notes/{id} { allow read: if true; } }
}`
    expect(check('firestore.rules', src, '/notes/{id}', 'read')).toMatchObject({ violations: [expect.anything()] })
  })
  it('reports a rest wildcard within the prefix that allows anyone', () => {
    const src = `service cloud.firestore {
  match /databases/{database}/documents { match /notes/{id} { allow read: if request.auth != null; } }
  match /databases/{database}/{rest=**} { allow read: if true; }
}`
    expect(check('firestore.rules', src, '/notes/{id}', 'read')).toMatchObject({ violations: [expect.anything()] })
  })
})
