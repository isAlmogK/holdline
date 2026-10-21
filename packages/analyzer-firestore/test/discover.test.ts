import { describe, expect, it } from 'vitest'
import { discoverRulesFiles } from '../src/discover.js'
import { repo } from './helpers/repo.js'

describe('discoverRulesFiles', () => {
  it('finds root rules files', async () => {
    const r = await repo({ 'firestore.rules': '', 'storage.rules': '' })
    expect(await discoverRulesFiles(r.root, r.files, {})).toEqual({ files: ['firestore.rules', 'storage.rules'], warnings: [] })
  })
  it('follows firebase.json at any depth, including arrays', async () => {
    const r = await repo({
      'app/firebase.json': JSON.stringify({ firestore: { rules: 'rules/db.rules' }, storage: [{ bucket: 'a', rules: 'st.rules' }] }),
      'app/rules/db.rules': '', 'app/st.rules': '',
    })
    expect((await discoverRulesFiles(r.root, r.files, {})).files).toEqual(['app/rules/db.rules', 'app/st.rules'])
  })
  it('reads a multi-database firestore array and deduplicates', async () => {
    const r = await repo({
      'firestore.rules': '',
      'firebase.json': JSON.stringify({ firestore: [{ database: 'a', rules: './firestore.rules' }, { database: 'b', rules: 'b.rules' }] }),
      'b.rules': '',
    })
    expect((await discoverRulesFiles(r.root, r.files, {})).files).toEqual(['b.rules', 'firestore.rules'])
  })
  it('warns about a firebase.json that points at a missing file, outside the repo, or is invalid', async () => {
    const r = await repo({
      'firebase.json': JSON.stringify({ firestore: { rules: 'gone.rules' } }),
      'x/firebase.json': '{',
      'y/firebase.json': JSON.stringify({ storage: { rules: '../../out.rules' } }),
    })
    const d = await discoverRulesFiles(r.root, r.files, {})
    expect(d.files).toEqual([])
    expect(d.warnings).toEqual([
      { file: 'firebase.json', message: 'points at gone.rules, which is not in the repository' },
      { file: 'x/firebase.json', message: expect.stringMatching(/^invalid JSON/) },
      { file: 'y/firebase.json', message: 'points at ../out.rules, which is not in the repository' },
    ])
  })
  it('ignores a firebase.json with an unexpected shape or a non-string rules value, silently', async () => {
    const r = await repo({
      'firebase.json': JSON.stringify({ firestore: 5, storage: { rules: 7 } }),
      'a/firebase.json': JSON.stringify([1]),
      'b/firebase.json': JSON.stringify({ firestore: [null, 'x', { rules: false }] }),
    })
    expect(await discoverRulesFiles(r.root, r.files, {})).toEqual({ files: [], warnings: [] })
  })
  it('uses config globs instead of defaults for that store only', async () => {
    const r = await repo({ 'firestore.rules': '', 'storage.rules': '', 'db/main.rules': '' })
    expect((await discoverRulesFiles(r.root, r.files, { firestore: { rules: ['db/*.rules'] } })).files).toEqual(['db/main.rules', 'storage.rules'])
    expect((await discoverRulesFiles(r.root, r.files, { storage: { rules: ['nothing/*.rules'] } })).warnings)
      .toEqual([{ file: '.holdline/config.yaml', message: 'storage.rules globs match no file' }])
  })
  it('does not consult firebase.json for a store whose globs are configured', async () => {
    const r = await repo({ 'firebase.json': JSON.stringify({ firestore: { rules: 'a.rules' } }), 'a.rules': '', 'db/main.rules': '' })
    expect((await discoverRulesFiles(r.root, r.files, { firestore: { rules: ['db/*.rules'] } })).files).toEqual(['db/main.rules'])
  })
})
