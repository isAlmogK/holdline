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
    expect(expand(fs('match /a/$(x) { allow read: if true; }')).allows[0]!.target).toBe('/a/{_interp1=**}')
  })
  it('numbers interpolated segments per file', () => {
    const e = expand(fs('match /a/$(x) { allow read; } match /b/$(y) { allow read; }'))
    expect(e.allows.map(a => a.target)).toEqual(['/a/{_interp1=**}', '/b/{_interp2=**}'])
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
  it('keeps one MatchSite per store when two services share a target', () => {
    const e = expand(`${fs('match /files/{id} { allow read; }')}
service firebase.storage { match /b/{bucket}/o { match /files/{id} { allow read; } } }`)
    expect(e.matches.map(m => [m.store, m.target])).toEqual([
      ['firestore', '/'], ['firestore', '/files/{id}'], ['storage', '/'], ['storage', '/files/{id}'],
    ])
  })
  it('does not warn when the prefix is split across nested matches', () => {
    const e = expand(`service cloud.firestore { match /databases/{d} { match /documents { match /x/{id} { allow read; } } } }`)
    expect(e.allows[0]!.target).toBe('/x/{id}')
    expect(e.warnings).toEqual([])
  })
  it('warns once per offending top-level match, with Storage text', () => {
    const e = expand(`service firebase.storage { match /files/{id} { match /a { allow read; } match /b { allow read; } } }`)
    expect(e.warnings).toEqual(['match /files/{id} is not under /b/{bucket}/o'])
  })
  it('does not treat a wrong literal as the prefix', () => {
    expect(expand(`service cloud.firestore { match /databases/{d}/docs { allow read; } }`).warnings).toHaveLength(1)
    expect(expand(`service cloud.firestore { match /db/{d}/documents { allow read; } }`).warnings).toHaveLength(1)
    expect(expand(`service firebase.storage { match /b/{bucket}/objects/a { allow read; } }`).warnings).toHaveLength(1)
  })
  it('strips a prefix that names a literal database or bucket', () => {
    const f = expand(`service cloud.firestore { match /databases/(default)/documents { match /users/{uid} { allow read; } } }`)
    expect(f.allows[0]!.target).toBe('/users/{uid}')
    expect(f.matches.map(m => m.target)).toEqual(['/', '/users/{uid}'])
    expect(f.warnings).toEqual([])
    const s = expand(`service firebase.storage { match /b/my-app.appspot.com/o { match /images/{id} { allow write; } } }`)
    expect(s.allows[0]!.target).toBe('/images/{id}')
    expect(s.warnings).toEqual([])
  })
  it('strips a prefix whose first or third segment is a single-segment wildcard, which can match it', () => {
    const e = expand(`service cloud.firestore { match /{a}/{b}/{c}/users/{uid} { allow read; } }`)
    expect(e.allows[0]!.target).toBe('/users/{uid}')
    expect(e.warnings).toEqual([])
  })
  it('gives a rest wildcard within the prefix a target covering every document', () => {
    const target = (src: string) => {
      const e = expand(src)
      expect(e.warnings).toEqual([])
      return e.allows.map(a => a.target)
    }
    expect(target(`service cloud.firestore { match /databases/{db}/{rest=**} { allow read; } }`)).toEqual(['/{rest=**}'])
    expect(target(`service cloud.firestore { match /databases/{d=**}/documents { allow read; } }`)).toEqual(['/{d=**}'])
    expect(target(`service cloud.firestore { match /databases/{rest=**} { allow read; } }`)).toEqual(['/{rest=**}'])
    expect(target(`service firebase.storage { match /b/{bucket}/{rest=**} { allow write; } }`)).toEqual(['/{rest=**}'])
    expect(target(`service firebase.storage { match /b/my-bucket/{rest=**} { allow write; } }`)).toEqual(['/{rest=**}'])
    expect(target(`service cloud.firestore { match /{path=**} { allow read; } }`)).toEqual(['/{path=**}'])
    expect(target(`service cloud.firestore { match /databases/{db}/{rest=**} { match /x/{id} { allow read; } } }`)).toEqual(['/{rest=**}'])
  })
  it('gives an interpolated segment within the prefix a covering target', () => {
    expect(expand(`service cloud.firestore { match /databases/$(x)/documents/a { allow read; } }`).allows[0]!.target).toBe('/{_interp1=**}')
  })
  it('still warns about a rest wildcard after a wrong literal', () => {
    const e = expand(`service cloud.firestore { match /db/{rest=**} { allow read; } }`)
    expect(e.allows[0]!.target).toBe('/db/{rest=**}')
    expect(e.warnings).toHaveLength(1)
  })
  it('keeps the first MatchSite for a repeated target', () => {
    const e = expand(fs('match /a/{x} { allow read; }\n match /a/{x} { allow read; }'))
    expect(e.matches.filter(m => m.target === '/a/{x}')).toEqual([{ store: 'firestore', target: '/a/{x}', line: 1 }])
  })
  it('warns about a function declared twice in one block', () => {
    const e = expand(fs('function f() { return true; } function f() { return false; } allow read: if f();'))
    expect(e.warnings).toEqual(['function f is declared twice in the same block; the last one is used'])
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
