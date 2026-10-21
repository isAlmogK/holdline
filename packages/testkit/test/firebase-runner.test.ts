import type { DataStore, TestCase, TestFile } from '@holdline/core'
import { beforeAll, describe, expect, it } from 'vitest'
import { runOnEmulator } from '../src/emulator.js'
import type { FirebaseInput } from '../src/firebase-runner.js'
import { resultsOrSkip, skipReason } from './helpers.js'

const firestoreRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /projects/{projectId} {
      allow read: if request.auth != null
        && exists(/databases/$(database)/documents/orgs/$(resource.data.orgId)/members/$(request.auth.uid));
      allow create: if request.auth != null
        && request.resource.data.orgId in get(/databases/$(database)/documents/users/$(request.auth.uid)).data.orgIds;
    }
    match /notes/{noteId} {
      allow read: if request.auth != null;
      allow update, delete: if request.auth != null && request.auth.uid == resource.data.ownerId;
    }
  }
}`

const storageRules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /orgs/{orgId}/files/{path=**} {
      allow get: if request.auth != null
        && firestore.exists(/databases/(default)/documents/orgs/$(orgId)/members/$(request.auth.uid));
      allow list: if request.auth != null;
      allow create: if request.auth != null && request.resource.metadata.kind == 'doc';
      allow update: if request.auth != null && request.resource.metadata.kind == resource.metadata.kind;
      allow delete: if request.auth != null && request.auth.uid == resource.metadata.owner;
    }
  }
}`

const u1 = { uid: 'u1', claims: {} }
const u2 = { uid: 'u2', claims: {} }
const tc = (name: string, c: Omit<TestCase, 'name' | 'seed'> & { seed?: TestCase['seed'] }): TestCase => ({ name, seed: [], ...c })
const file = (rule: string, store: DataStore, cases: TestCase[]): TestFile => ({ rule, generatedFrom: 'h', store, cases, skipped: [] })

const project = { path: '/projects/p1', data: { orgId: 'o1' } }
const membership = { path: '/orgs/o1/members/u1', data: { role: 'member' } }
const note = { path: '/notes/n1', data: { ownerId: 'u1', body: 'b' } }
const object = { path: '/orgs/o1/files/f1', store: 'storage' as const, data: { kind: 'doc', owner: 'u1' } }
const storedMembership = { ...membership, store: 'firestore' as const }

const input: FirebaseInput = {
  firestoreRules,
  storageRules,
  files: [
    file('project-read', 'firestore', [
      tc('member allowed', { as: u1, seed: [project, membership], do: { op: 'read', path: '/projects/p1' }, expect: 'allow' }),
      tc('non-member denied', { as: u2, seed: [project, membership], do: { op: 'read', path: '/projects/p1' }, expect: 'deny' }),
      tc('anonymous denied', { as: null, seed: [project, membership], do: { op: 'read', path: '/projects/p1' }, expect: 'deny' }),
    ]),
    file('project-create', 'firestore', [
      tc('own org', { as: u1, seed: [{ path: '/users/u1', data: { orgIds: ['o1'] } }], do: { op: 'create', path: '/projects/p2', data: { orgId: 'o1' } }, expect: 'allow' }),
      tc('other org', { as: u1, seed: [{ path: '/users/u1', data: { orgIds: ['o1'] } }], do: { op: 'create', path: '/projects/p2', data: { orgId: 'o2' } }, expect: 'deny' }),
      tc('invariant', { as: u1, seed: [{ path: '/users/u1', data: { orgIds: ['o1'] } }], do: { op: 'create', path: '/projects/p2', data: { orgId: 'o9' } }, expect: 'reject' }),
    ]),
    file('file-read', 'storage', [
      tc('member allowed', { as: u1, seed: [object, storedMembership], do: { op: 'read', path: '/orgs/o1/files/f1' }, expect: 'allow' }),
      tc('non-member denied', { as: u2, seed: [object, storedMembership], do: { op: 'read', path: '/orgs/o1/files/f1' }, expect: 'deny' }),
    ]),
    file('file-create', 'storage', [
      tc('doc kind allowed', { as: u1, do: { op: 'create', path: '/orgs/o1/files/f2', data: { kind: 'doc', pages: 3 } }, expect: 'allow' }),
      tc('other kind denied', { as: u1, do: { op: 'create', path: '/orgs/o1/files/f2', data: { kind: 'other' } }, expect: 'deny' }),
    ]),
    file('wrong', 'firestore', [
      tc('expects allow, rule denies', { as: u2, seed: [project, membership], do: { op: 'read', path: '/projects/p1' }, expect: 'allow' }),
      tc('expects deny, rule allows', { as: u1, seed: [project, membership], do: { op: 'read', path: '/projects/p1' }, expect: 'deny' }),
    ]),
    file('notes-ops', 'firestore', [
      tc('owner updates without data', { as: u1, seed: [note], do: { op: 'update', path: '/notes/n1', data: {} }, expect: 'allow' }),
      tc('other updates', { as: u2, seed: [note], do: { op: 'update', path: '/notes/n1', data: { body: 'x' } }, expect: 'deny' }),
      tc('other updates without data', { as: u2, seed: [note], do: { op: 'update', path: '/notes/n1', data: {} }, expect: 'deny' }),
      tc('owner deletes', { as: u1, seed: [note], do: { op: 'delete', path: '/notes/n1' }, expect: 'allow' }),
      tc('member lists', { as: u1, seed: [note], do: { op: 'list', path: '/notes' }, expect: 'allow' }),
      tc('anonymous lists', { as: null, seed: [note], do: { op: 'list', path: '/notes' }, expect: 'deny' }),
    ]),
    file('files-ops', 'storage', [
      tc('member lists', { as: u1, seed: [object], do: { op: 'list', path: '/orgs/o1/files' }, expect: 'allow' }),
      tc('anonymous lists', { as: null, seed: [object], do: { op: 'list', path: '/orgs/o1/files' }, expect: 'deny' }),
      tc('same kind updates', { as: u1, seed: [object], do: { op: 'update', path: '/orgs/o1/files/f1', data: { kind: 'doc' } }, expect: 'allow' }),
      tc('kind change denied', { as: u1, seed: [object], do: { op: 'update', path: '/orgs/o1/files/f1', data: { kind: 'img' } }, expect: 'deny' }),
      tc('owner deletes', { as: u1, seed: [object], do: { op: 'delete', path: '/orgs/o1/files/f1' }, expect: 'allow' }),
      tc('other deletes', { as: u2, seed: [object], do: { op: 'delete', path: '/orgs/o1/files/f1' }, expect: 'deny' }),
    ]),
  ],
}

const summary = (cases: { name: string; actual: string; passed: boolean }[]) => cases.map(c => [c.name, c.actual, c.passed])

describe('@emulator firebase runner', () => {
  let outcome: Awaited<ReturnType<typeof runOnEmulator>>
  beforeAll(async () => {
    outcome = await runOnEmulator(input)
    skipReason(outcome)
  }, 240_000)
  const results = (ctx: { skip: (note?: string) => void }) => resultsOrSkip(outcome, ctx)

  it('firestore read: member allowed, non-member denied, anonymous denied', ctx => {
    expect(results(ctx)['project-read']).toEqual([
      { name: 'member allowed', expect: 'allow', actual: 'allow', passed: true },
      { name: 'non-member denied', expect: 'deny', actual: 'deny', passed: true },
      { name: 'anonymous denied', expect: 'deny', actual: 'deny', passed: true },
    ])
  })
  it('firestore create: allowed into own org, denied otherwise', ctx => {
    expect(summary(results(ctx)['project-create']!)).toEqual([
      ['own org', 'allow', true], ['other org', 'deny', true], ['invariant', 'deny', true],
    ])
  })
  it('storage read: reads the firestore membership doc', ctx => {
    expect(summary(results(ctx)['file-read']!)).toEqual([['member allowed', 'allow', true], ['non-member denied', 'deny', true]])
  })
  it('storage create with metadata', ctx => {
    expect(summary(results(ctx)['file-create']!)).toEqual([['doc kind allowed', 'allow', true], ['other kind denied', 'deny', true]])
  })
  it('a wrong expectation fails', ctx => {
    const [denied, allowed] = results(ctx)['wrong']!
    expect(denied).toMatchObject({ expect: 'allow', actual: 'deny', passed: false, detail: expect.stringMatching(/^expected allow, got deny/) })
    expect(allowed).toEqual({ name: 'expects deny, rule allows', expect: 'deny', actual: 'allow', passed: false, detail: 'expected deny, got allow' })
  })
  it('update, delete and list reach both emulators', ctx => {
    const r = results(ctx)
    expect(summary(r['notes-ops']!)).toEqual([
      ['owner updates without data', 'allow', true], ['other updates', 'deny', true],
      ['other updates without data', 'deny', true], ['owner deletes', 'allow', true],
      ['member lists', 'allow', true], ['anonymous lists', 'deny', true],
    ])
    expect(summary(r['files-ops']!)).toEqual([
      ['member lists', 'allow', true], ['anonymous lists', 'deny', true], ['same kind updates', 'allow', true],
      ['kind change denied', 'deny', true], ['owner deletes', 'allow', true], ['other deletes', 'deny', true],
    ])
  })
})
