import { describe, expect, it } from 'vitest'
import { expandOps, expandRules, policyIds } from '../src/expand.js'
import { parseRules } from '../src/parser.js'

const expand = (src: string) => {
  const r = parseRules(src)
  if (!r.ok) throw new Error(r.error.message)
  return expandRules(r.ast)
}
const fs = (body: string) => `service cloud.firestore { match /databases/{database}/documents { ${body} } }`

describe('expandOps', () => {
  it('maps rules ops to Holdline ops', () => {
    expect(expandOps(['read'])).toEqual(['read', 'list'])
    expect(expandOps(['get'])).toEqual(['read'])
    expect(expandOps(['list'])).toEqual(['list'])
    expect(expandOps(['write'])).toEqual(['create', 'update', 'delete'])
    expect(expandOps(['update', 'read', 'get'])).toEqual(['read', 'list', 'update'])
  })
})

describe('expandRules', () => {
  it('concatenates nested matches and strips the Firestore prefix', () => {
    const e = expand(fs('match /orgs/{orgId} { match /projects/{projectId} { allow read: if true; } }'))
    expect(e.allows.map(a => [a.store, a.target, a.ops])).toEqual([['firestore', '/orgs/{orgId}/projects/{projectId}', ['read', 'list']]])
    expect(e.matches.map(m => m.target)).toEqual(['/', '/orgs/{orgId}', '/orgs/{orgId}/projects/{projectId}'])
  })
  it('strips the Storage prefix and keeps rest wildcards', () => {
    const e = expand(`service firebase.storage { match /b/{bucket}/o { match /files/{path=**} { allow write: if true; } } }`)
    expect(e.allows[0]).toMatchObject({ store: 'storage', target: '/files/{path=**}', ops: ['create', 'update', 'delete'] })
  })
  it('handles a prefix and a path written in one match', () => {
    const e = expand(`service cloud.firestore { match /databases/{db}/documents/users/{uid} { allow get: if true; } }`)
    expect(e.allows[0]).toMatchObject({ target: '/users/{uid}', ops: ['read'] })
  })
  it('warns about a match outside the document prefix and keeps it', () => {
    const e = expand(`service cloud.firestore { match /users/{uid} { allow read: if true; } }`)
    expect(e.allows[0]!.target).toBe('/users/{uid}')
    expect(e.warnings).toEqual([expect.stringContaining('not under /databases/{database}/documents')])
  })
  it('gives allows in the service block or the prefix match the target /', () => {
    const e = expand(`service cloud.firestore { allow read; match /databases/{d}/documents { allow write; } }`)
    expect(e.allows.map(a => a.target)).toEqual(['/', '/'])
    expect(e.warnings).toEqual([])
  })
  it('renders an interpolated match segment as a conservative wildcard', () => {
    expect(expand(fs('match /a/$(x) { allow read: if true; }')).allows[0]!.target).toBe('/a/{_interp1}')
  })
  it('numbers interpolated segments per file', () => {
    const e = expand(fs('match /a/$(x) { allow read; } match /b/$(y) { allow read; }'))
    expect(e.allows.map(a => a.target)).toEqual(['/a/{_interp1}', '/b/{_interp2}'])
  })
  it('ignores other services with a warning', () => {
    const e = expand(`service other.thing { match /a { allow read; } }`)
    expect(e.allows).toEqual([])
    expect(e.warnings).toEqual(['service other.thing is not Firestore or Storage; skipped'])
  })
  it('builds lexical scopes with wildcards and functions declared anywhere in a block', () => {
    const e = expand(fs('match /orgs/{orgId} { allow read: if f(); function f() { return true; } }'))
    const scope = e.allows[0]!.scope
    expect(scope.isWildcard('orgId')).toBe(true)
    expect(scope.isWildcard('database')).toBe(true)
    expect(scope.findFunction('f')?.decl.name).toBe('f')
  })
  it('gives one policy id per allow and op, disambiguating same-line duplicates', () => {
    const src = fs('match /a/{id} {\n allow read: if true; allow get: if false;\n allow write; }')
    const col = src.split('\n')[1]!.indexOf('allow get') + 1
    const e = expand(src)
    expect(policyIds(e.allows)).toEqual([
      'firestore:/a/{id}#read@2', 'firestore:/a/{id}#list@2', `firestore:/a/{id}#read@2:${col}`,
      'firestore:/a/{id}#create@3', 'firestore:/a/{id}#update@3', 'firestore:/a/{id}#delete@3',
    ])
  })
})
