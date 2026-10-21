import { describe, expect, it } from 'vitest'
import { emptyFacts, type Facts, type Policy } from '@holdline/core'
import { policySummary } from '../src/format/policy-summary.js'
import { makeProject, runCli } from './helpers/project.js'

const pol = (id: string, file: string, line: number, condition: Policy['condition'], store: Policy['store'] = 'firestore'): Policy =>
  ({ id, store, target: '/a/{b}', ops: ['read'], condition, functions: [], evidence: { file, line } })

describe('policySummary', () => {
  it('counts policies and distinct opaque sub-conditions per rules file', () => {
    const facts: Facts = { ...emptyFacts(), policies: [
      pol('p1', 'firestore.rules', 3, { and: [{ opaque: 'request.time < x' }, { atom: { op: 'authenticated' } }] }),
      pol('p2', 'firestore.rules', 3, { and: [{ opaque: 'request.time < x' }, { atom: { op: 'authenticated' } }] }),
      pol('p3', 'firestore.rules', 9, { not: { opaque: 'request.time < x' } }),
      pol('p4', 'storage.rules', 2, { and: [] }, 'storage'),
      pol('p5', 'db.sql', 1, { opaque: 'ignored' }, 'pg-rls'),
    ] }
    expect(policySummary(facts)).toBe([
      'firestore.rules: 3 policies, 2 opaque sub-conditions',
      '  opaque: request.time < x (lines 3, 9)',
      'storage.rules: 1 policy, 0 opaque sub-conditions',
      '',
    ].join('\n'))
  })
  it('is empty without Firestore or Storage policies', () => {
    expect(policySummary(emptyFacts())).toBe('')
  })
  it('cuts long opaque text', () => {
    const long = 'x'.repeat(200)
    const out = policySummary({ ...emptyFacts(), policies: [pol('p', 'f.rules', 1, { opaque: long })] })
    expect(out).toContain(`  opaque: ${'x'.repeat(119)}… (line 1)`)
  })
  it('groups policies without evidence under an unknown file', () => {
    const p = { ...pol('p', 'x', 1, { opaque: 'a' }), evidence: undefined } as Policy
    expect(policySummary({ ...emptyFacts(), policies: [p] })).toContain('(unknown file): 1 policy, 1 opaque sub-condition')
  })
})

describe('holdline scan summary', () => {
  it('prints the policy summary after the Scanned line', async () => {
    const root = await makeProject({
      'firebase.json': JSON.stringify({ firestore: { rules: 'firestore.rules' } }),
      'firestore.rules': `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /notes/{id} {
      allow read: if request.auth != null && request.time < timestamp.date(2030, 1, 1);
    }
  }
}
`,
    })
    const out = await runCli(['scan'], { cwd: root })
    expect(out.stdout).toContain('Scanned with')
    expect(out.stdout).toContain('firestore.rules: 2 policies, 1 opaque sub-condition')
  })
})
