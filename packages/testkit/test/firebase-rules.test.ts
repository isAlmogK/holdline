import { ConfigError } from '@holdline/core'
import { describe, expect, it } from 'vitest'
import { resolveRulesFile } from '../src/firebase-rules.js'
import { project } from './helpers.js'

describe('resolveRulesFile', () => {
  it('uses the config glob', async () => {
    const root = await project({ 'rules/app.rules': 'x', 'firestore.rules': 'y' })
    expect(await resolveRulesFile(root, { firestore: { rules: ['rules/*.rules'] } }, 'firestore')).toBe('rules/app.rules')
  })
  it('refuses a config glob that matches more than one file', async () => {
    const root = await project({ 'rules/a.rules': 'x', 'rules/b.rules': 'y' })
    const run = resolveRulesFile(root, { storage: { rules: ['rules/*.rules'] } }, 'storage')
    await expect(run).rejects.toThrow(ConfigError)
    await expect(run).rejects.toThrow('testing needs exactly one storage rules file; 2 match')
  })
  it('follows firebase.json pointers', async () => {
    const root = await project({
      'firebase.json': JSON.stringify({ firestore: { rules: 'fb/fs.rules' }, storage: { rules: 'fb/st.rules' } }),
      'fb/fs.rules': 'x', 'fb/st.rules': 'y', 'firestore.rules': 'z',
    })
    expect(await resolveRulesFile(root, {}, 'firestore')).toBe('fb/fs.rules')
    expect(await resolveRulesFile(root, {}, 'storage')).toBe('fb/st.rules')
  })
  it('follows a firebase.json storage array', async () => {
    const root = await project({
      'firebase.json': JSON.stringify({ storage: [{ bucket: 'b', rules: 'fb/st.rules' }] }),
      'fb/st.rules': 'y',
    })
    expect(await resolveRulesFile(root, {}, 'storage')).toBe('fb/st.rules')
  })
  it('falls back to the rules file at the root', async () => {
    const root = await project({ 'firestore.rules': 'x', 'storage.rules': 'y' })
    expect(await resolveRulesFile(root, {}, 'firestore')).toBe('firestore.rules')
    expect(await resolveRulesFile(root, {}, 'storage')).toBe('storage.rules')
  })
  it('does not fall back when the config glob matches nothing', async () => {
    const root = await project({ 'firestore.rules': 'x' })
    expect(await resolveRulesFile(root, { firestore: { rules: ['rules/*.rules'] } }, 'firestore')).toBeUndefined()
  })
  it('returns undefined when there is no rules file', async () => {
    const root = await project({ 'README.md': 'x' })
    expect(await resolveRulesFile(root, {}, 'firestore')).toBeUndefined()
  })
})
