import { describe, expect, it } from 'vitest'
import { discoverRulesFiles } from '../src/discover.js'
import { repo } from './helpers/repo.js'

describe('discoverRulesFiles', () => {
  it('finds root rules files', async () => {
    const r = await repo({ 'firestore.rules': '', 'storage.rules': '' })
    expect(await discoverRulesFiles(r.root, r.files, {})).toEqual({ files: ['firestore.rules', 'storage.rules'], errors: [] })
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
  it('reports an error for a firebase.json that points at a missing file, outside the repo, or is invalid', async () => {
    const r = await repo({
      'firebase.json': JSON.stringify({ firestore: { rules: 'gone.rules' } }),
      'x/firebase.json': '{',
      'y/firebase.json': JSON.stringify({ storage: { rules: '../../out.rules' } }),
    })
    const d = await discoverRulesFiles(r.root, r.files, {})
    expect(d.files).toEqual([])
    expect(d.errors).toEqual([
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
    expect(await discoverRulesFiles(r.root, r.files, {})).toEqual({ files: [], errors: [] })
  })
  it('uses config globs instead of defaults for that store only', async () => {
    const r = await repo({ 'firestore.rules': '', 'storage.rules': '', 'db/main.rules': '' })
    expect((await discoverRulesFiles(r.root, r.files, { firestore: { rules: ['db/*.rules'] } })).files).toEqual(['db/main.rules', 'storage.rules'])
    expect((await discoverRulesFiles(r.root, r.files, { storage: { rules: ['nothing/*.rules'] } })).errors)
      .toEqual([{ file: '.holdline/config.yaml', message: 'storage.rules globs match no file' }])
  })
  it('follows a pointer into an in-repo folder whose name starts with two dots', async () => {
    const r = await repo({ 'firebase.json': JSON.stringify({ firestore: { rules: '..rules/db.rules' } }), '..rules/db.rules': '' })
    expect(await discoverRulesFiles(r.root, r.files, {})).toEqual({ files: ['..rules/db.rules'], errors: [] })
  })
  it('reports an error for a firebase.json pointing at the parent folder itself', async () => {
    const r = await repo({ 'a/firebase.json': JSON.stringify({ firestore: { rules: '../..' } }) })
    expect((await discoverRulesFiles(r.root, r.files, {})).errors).toEqual([{ file: 'a/firebase.json', message: 'points at .., which is not in the repository' }])
  })
  it('reports an error for a firebase.json it cannot read', async () => {
    const r = await repo({ 'firebase.json': '{}' })
    const d = await discoverRulesFiles(r.root, [...r.files, 'gone/firebase.json'], {})
    expect(d.errors).toEqual([{ file: 'gone/firebase.json', message: expect.stringMatching(/^could not read: /) }])
  })
  it('does not consult firebase.json for a store whose globs are configured', async () => {
    const r = await repo({ 'firebase.json': JSON.stringify({ firestore: { rules: 'a.rules' } }), 'a.rules': '', 'db/main.rules': '' })
    expect((await discoverRulesFiles(r.root, r.files, { firestore: { rules: ['db/*.rules'] } })).files).toEqual(['db/main.rules'])
  })
})
