import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { scan } from '@holdline/core'
import { analyzeRulesFile } from '../src/analyze-file.js'
import { firestoreAnalyzer } from '../src/analyzer.js'
import { repo } from './helpers/repo.js'

const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function signedIn() { return request.auth != null; }
    match /notes/{noteId} {
      allow read: if signedIn() && resource.data.owner == request.auth.uid;
      allow delete: if false;
    }
  }
}`

describe('analyzeRulesFile', () => {
  it('emits one policy per allow and op, match symbols and evidence', () => {
    const out = analyzeRulesFile('firestore.rules', RULES, [])
    expect(out.policies).toEqual([
      expect.objectContaining({ id: 'firestore:/notes/{noteId}#read@6', store: 'firestore', target: '/notes/{noteId}', ops: ['read'], functions: ['signedIn'], evidence: { file: 'firestore.rules', line: 6 } }),
      expect.objectContaining({ id: 'firestore:/notes/{noteId}#list@6', ops: ['list'] }),
      expect.objectContaining({ id: 'firestore:/notes/{noteId}#delete@7', condition: { or: [] } }),
    ])
    expect(out.policies![0]!.condition).toEqual({ and: [{ atom: { op: 'authenticated' } }, { atom: { op: 'eq', left: 'resource.owner', right: 'actor.uid' } }] })
    expect(out.symbols).toEqual([
      { id: 'firestore:/', kind: 'match', lang: 'firestore', location: { file: 'firestore.rules', line: 3 } },
      { id: 'firestore:/notes/{noteId}', kind: 'match', lang: 'firestore', location: { file: 'firestore.rules', line: 5 } },
    ])
  })
  it('uses approved recognizers for zero-parameter functions', () => {
    const out = analyzeRulesFile('firestore.rules', RULES, [{ id: 'signed-in', recognize: [{ 'firestore-function': 'signedIn' }] }])
    expect(out.policies![0]!.condition).toEqual({ and: [{ ref: 'signed-in' }, { atom: { op: 'authenticated' } }, { atom: { op: 'eq', left: 'resource.owner', right: 'actor.uid' } }] })
  })
  it('lets the first recognizer win on a duplicate function name', () => {
    const out = analyzeRulesFile('firestore.rules', RULES, [
      { id: 'first', recognize: [{ 'firestore-function': 'signedIn' }] },
      { id: 'second', recognize: [{ 'firestore-function': 'signedIn' }] },
    ])
    expect(out.policies![0]!.condition).toMatchObject({ and: [{ ref: 'first' }, expect.anything(), expect.anything()] })
  })
  it('gives an unconditional allow the TRUE condition', () => {
    const out = analyzeRulesFile('firestore.rules', 'service cloud.firestore { match /databases/{database}/documents { match /a/{id} { allow get; } } }', [])
    expect(out.policies).toEqual([expect.objectContaining({ ops: ['read'], condition: { and: [] }, functions: [] })])
  })
  it('turns a parse error into one error diagnostic and no policies', () => {
    const out = analyzeRulesFile('firestore.rules', 'service cloud.firestore {\n  match /a {\n    allow reed;\n  }\n}', [])
    expect(out.policies ?? []).toEqual([])
    expect(out.symbols ?? []).toEqual([])
    expect(out.diagnostics).toEqual([{ analyzer: 'firestore', file: 'firestore.rules', severity: 'error', message: expect.stringMatching(/^line 3, column 11: unknown operation 'reed'/) }])
  })
  it('warns about a file with no service block', () => {
    const out = analyzeRulesFile('firestore.rules', "rules_version = '2';", [])
    expect(out.diagnostics).toEqual([{ analyzer: 'firestore', file: 'firestore.rules', severity: 'warning', message: 'no service block' }])
  })
  it('turns expansion warnings into warning diagnostics', () => {
    const out = analyzeRulesFile('firestore.rules', 'service cloud.firestore { match /a/{id} { allow read: if true; } }', [])
    expect(out.diagnostics).toEqual([expect.objectContaining({ analyzer: 'firestore', file: 'firestore.rules', severity: 'warning', message: expect.stringContaining('is not under') })])
  })
  it('emits Storage policies with storage ids', () => {
    const out = analyzeRulesFile('storage.rules', `service firebase.storage { match /b/{bucket}/o { match /u/{uid}/{f=**} { allow write: if request.auth.uid == uid; } } }`, [])
    expect(out.policies!.map(p => p.id)).toEqual(['storage:/u/{uid}/{f=**}#create@1', 'storage:/u/{uid}/{f=**}#update@1', 'storage:/u/{uid}/{f=**}#delete@1'])
    expect(out.symbols!.map(s => [s.id, s.lang])).toContainEqual(['storage:/u/{uid}/{f=**}', 'storage'])
  })
})

describe('firestoreAnalyzer through scan', () => {
  it('detects and scans a project, producing valid facts', async () => {
    const r = await repo({ 'firestore.rules': RULES })
    const { facts, ran } = await scan(r.root, [firestoreAnalyzer])
    expect(ran).toEqual(['firestore'])
    expect(facts.policies).toHaveLength(3)
    expect(facts.diagnostics).toEqual([])
  })
  it('does not run without rules files or config', async () => {
    const r = await repo({ 'README.md': '' })
    expect((await scan(r.root, [firestoreAnalyzer])).ran).toEqual([])
  })
  it('runs when config sets rules globs even if they match nothing, and reports it', async () => {
    const r = await repo({ '.holdline/config.yaml': 'firestore:\n  rules: [nope/*.rules]\n' })
    const { facts, ran } = await scan(r.root, [firestoreAnalyzer])
    expect(ran).toEqual(['firestore'])
    expect(facts.diagnostics).toEqual([{ analyzer: 'firestore', file: '.holdline/config.yaml', severity: 'warning', message: 'firestore.rules globs match no file' }])
  })
  it('reports discovery warnings as diagnostics', async () => {
    const r = await repo({ 'firebase.json': '{' })
    const { facts } = await scan(r.root, [firestoreAnalyzer])
    expect(facts.diagnostics).toEqual([expect.objectContaining({ file: 'firebase.json', severity: 'warning', message: expect.stringMatching(/^invalid JSON/) })])
  })
  it('caches by path, content and recognizers', async () => {
    const r = await repo({ 'firestore.rules': RULES })
    await scan(r.root, [firestoreAnalyzer])
    const again = await scan(r.root, [firestoreAnalyzer], { recognizers: [{ id: 'signed-in', recognize: [{ 'firestore-function': 'signedIn' }] }] })
    expect(again.facts.policies[0]!.condition).toMatchObject({ and: [{ ref: 'signed-in' }, expect.anything(), expect.anything()] })
    const plain = await scan(r.root, [firestoreAnalyzer])
    expect(plain.facts.policies[0]!.condition).toMatchObject({ and: [{ atom: { op: 'authenticated' } }, expect.anything()] })
  })
  it('recomputes a file whose content changed', async () => {
    const r = await repo({ 'firestore.rules': RULES })
    await scan(r.root, [firestoreAnalyzer])
    await writeFile(join(r.root, 'firestore.rules'), RULES.replace('allow delete: if false', 'allow delete: if true'))
    const changed = await scan(r.root, [firestoreAnalyzer])
    expect(changed.facts.policies.find(p => p.ops[0] === 'delete')!.condition).toEqual({ and: [] })
    expect(await readFile(join(r.root, 'firestore.rules'), 'utf8')).toContain('if true')
  })
  it('reports a rules file that vanished as an error diagnostic', async () => {
    const r = await repo({ 'firebase.json': JSON.stringify({ firestore: { rules: 'gone.rules' } }), 'gone.rules': '' })
    const ctx = { root: r.root, files: ['firebase.json', 'gone.rules'], cache: new (await import('@holdline/core')).FileCache(r.root), config: {}, recognizers: [] }
    await import('node:fs/promises').then(fs => fs.rm(join(r.root, 'gone.rules')))
    const out = await firestoreAnalyzer.analyze(ctx)
    expect(out.diagnostics).toEqual([expect.objectContaining({ file: 'gone.rules', severity: 'error', message: expect.stringMatching(/^could not read: /) })])
  })
})
