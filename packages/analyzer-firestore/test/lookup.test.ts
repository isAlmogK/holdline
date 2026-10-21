import { describe, expect, it } from 'vitest'
import { lookupPath } from '../src/lookup-path.js'
import { parseExpressionSource } from '../src/parse-expr.js'
import { rootEnv, Scope, type Binding, type Env } from '../src/scope.js'
import { cond } from './helpers/cond.js'

const auth = { atom: { op: 'authenticated' } }
const DB = '/databases/$(database)/documents'

describe('lookups', () => {
  it('get(P).data.f is doc(P\').f with placeholders for the caller, wildcards and fields', () => {
    expect(cond(`resource.data.orgId in get(${DB}/users/$(request.auth.uid)).data.orgIds`))
      .toEqual({ and: [auth, { atom: { op: 'in', left: 'resource.orgId', right: 'doc(/users/{actor.uid}).orgIds' } }] })
    expect(cond(`get(${DB}/orgs/$(thingId)).data.plan == 'pro'`))
      .toEqual({ atom: { op: 'eq', left: 'doc(/orgs/{param.thingId}).plan', right: { literal: 'pro' } } })
    expect(cond(`get(${DB}/orgs/$(resource.data.orgId)/members/$(request.auth.uid)).data.role == 'admin'`))
      .toEqual({ and: [auth, { atom: { op: 'eq', left: 'doc(/orgs/{resource.orgId}/members/{actor.uid}).role', right: { literal: 'admin' } } }] })
    expect(cond(`get(${DB}/orgs/$(request.resource.data.orgId)).data.open == true`))
      .toEqual({ atom: { op: 'eq', left: 'doc(/orgs/{incoming.orgId}).open', right: { literal: true } } })
  })
  it('get(P).data.get(f, d) follows the default rule', () => {
    expect(cond(`get(${DB}/orgs/$(thingId)).data.get('plan', 'free') == 'pro'`))
      .toEqual({ atom: { op: 'eq', left: 'doc(/orgs/{param.thingId}).plan', right: { literal: 'pro' } } })
  })
  it('exists(P) is exists(P\')', () => {
    expect(cond(`exists(${DB}/orgs/$(thingId)/members/$(request.auth.uid))`))
      .toEqual({ and: [auth, { atom: { op: 'exists', doc: '/orgs/{param.thingId}/members/{actor.uid}' } }] })
    expect(cond(`!exists(${DB}/banned/$(thingId))`)).toEqual({ not: { atom: { op: 'exists', doc: '/banned/{param.thingId}' } } })
  })
  it('literal segments and string interpolations stay literal', () => {
    expect(cond(`exists(${DB}/config/$('global'))`)).toEqual({ atom: { op: 'exists', doc: '/config/global' } })
  })
  it('Storage uses firestore.get and firestore.exists with (default)', () => {
    const DEF = '/databases/(default)/documents'
    expect(cond(`firestore.exists(${DEF}/orgs/$(orgId)/members/$(request.auth.uid))`, { store: 'storage', path: '/orgs/{orgId}/files/{f=**}' }))
      .toEqual({ and: [auth, { atom: { op: 'exists', doc: '/orgs/{param.orgId}/members/{actor.uid}' } }] })
    expect(cond(`firestore.get(${DEF}/orgs/$(orgId)).data.plan == 'pro'`, { store: 'storage', path: '/orgs/{orgId}/files/{f=**}' }))
      .toEqual({ atom: { op: 'eq', left: 'doc(/orgs/{param.orgId}).plan', right: { literal: 'pro' } } })
    expect(cond(`exists(${DEF}/orgs/$(orgId))`, { store: 'storage', path: '/orgs/{orgId}' })).toMatchObject({ opaque: expect.any(String) })
  })
  it('getAfter and existsAfter are opaque', () => {
    expect(cond(`getAfter(${DB}/a/$(thingId)).data.x == 1`)).toMatchObject({ opaque: expect.any(String) })
    expect(cond(`existsAfter(${DB}/a/$(thingId))`)).toMatchObject({ opaque: expect.any(String) })
  })
  it('a segment that cannot be an operand makes the lookup opaque', () => {
    for (const src of [
      `exists(${DB}/a/$(request.time))`,                      // not an operand
      `exists(${DB}/a/x$(thingId))`,                          // mixed segment
      `exists(${DB}/a/$(resource.data.a.b))`,                 // placeholder two fields deep
      `exists(/other/$(thingId))`,                            // no database prefix
      `get(${DB}/a/$(thingId)).id == 'x'`,                     // not .data
    ]) expect(cond(src)).toEqual({ opaque: src })
  })
})

describe('lookups: edges', () => {
  const storage = { store: 'storage' as const, path: '/orgs/{orgId}' }
  const DEF = '/databases/(default)/documents'

  it('the database segment may be any single segment', () => {
    expect(cond(`exists(/databases/other/documents/a/$(thingId))`)).toEqual({ atom: { op: 'exists', doc: '/a/{param.thingId}' } })
  })
  it('a wrong prefix or no document segments is opaque', () => {
    for (const src of [
      `exists(/databases/$(database)/documents)`,
      `exists(/databases/$(database)/docs/a/$(thingId))`,
      `exists(/db/$(database)/documents/a/$(thingId))`,
    ]) expect(cond(src)).toEqual({ opaque: src })
  })
  it('a text segment with path-grammar characters is opaque', () => {
    const src = `exists(${DB}/a/(x))`
    expect(cond(src)).toEqual({ opaque: src })
  })
  it('a claim, an integer and getters by index give placeholders and text', () => {
    expect(cond(`exists(${DB}/teams/$(request.auth.token.team))`))
      .toEqual({ and: [auth, { atom: { op: 'exists', doc: '/teams/{actor.claim.team}' } }] })
    expect(cond(`exists(${DB}/slots/$(3))`)).toEqual({ atom: { op: 'exists', doc: '/slots/3' } })
    expect(cond(`get(${DB}/orgs/$(thingId))['data']['plan'] == 'pro'`))
      .toEqual({ atom: { op: 'eq', left: 'doc(/orgs/{param.thingId}).plan', right: { literal: 'pro' } } })
  })
  it('a float, a fallback, a rest wildcard, an empty string or a slash in an interpolation is opaque', () => {
    for (const src of [
      `exists(${DB}/slots/$(1.0))`,
      `exists(${DB}/a/$(resource.data.get('o', 'x')))`,
      `exists(${DB}/a/$(''))`,
      `exists(${DB}/a/$('b/c'))`,
      `exists(${DB}/a/$(get(${DB}/b/$(thingId)).data.c))`,
    ]) expect(cond(src)).toEqual({ opaque: src })
    const rest = `exists(${DB}/a/$(rest))`
    expect(cond(rest, { path: '/things/{rest=**}' })).toEqual({ opaque: rest })
  })
  it('a lookup that is not a comparison side or a condition is opaque', () => {
    for (const src of [`get(${DB}/a/$(thingId)) == null`, `exists(${DB}/a/$(thingId)) == true`, `get(${DB}/a/$(thingId)).data == 1`])
      expect(cond(src)).toEqual({ opaque: src })
  })
  it('a bare get(P).data.f is eq true', () => {
    expect(cond(`get(${DB}/a/$(thingId)).data.on`)).toEqual({ atom: { op: 'eq', left: 'doc(/a/{param.thingId}).on', right: { literal: true } } })
  })
  it('the built-ins follow the store', () => {
    for (const src of [`firestore.exists(${DB}/a/$(thingId))`, `firestore.get(${DB}/a/$(thingId)).data.x == 1`])
      expect(cond(src)).toEqual({ opaque: src })
    for (const src of [`get(${DEF}/a/$(orgId)).data.x == 1`, `firestore.getAfter(${DEF}/a/$(orgId)).data.x == 1`, `firestore.existsAfter(${DEF}/a/$(orgId))`])
      expect(cond(src, storage)).toEqual({ opaque: src })
  })
  it('a wildcard named firestore shadows the Storage object', () => {
    const src = `firestore.exists(${DEF}/a/$(orgId))`
    expect(cond(src, { store: 'storage', path: '/x/{firestore}/{orgId}' })).toEqual({ opaque: src })
  })
})

describe('lookupPath', () => {
  const ctx = (src: string) => ({ store: 'firestore' as const, src, recognizers: new Map<string, string>(), functionCounts: new Map<string, number>(), functionsUsed: new Set<string>() })
  const outerEnv: Env = rootEnv(new Scope(undefined, new Set(['thingId'])))

  it('follows a binding to a path literal, in the binding\'s env', () => {
    const bindings = new Map<string, Binding>([
      ['p', { node: parseExpressionSource(`${DB}/users/$(request.auth.uid)/items/$(thingId)`), env: outerEnv }],
      ['q', { node: parseExpressionSource(`'not a path'`), env: outerEnv }],
    ])
    const env: Env = { ...rootEnv(new Scope(undefined, new Set())), bindings, depth: 1 }
    expect(lookupPath(parseExpressionSource('p'), env, ctx('p'))).toEqual({ path: '/users/{actor.uid}/items/{param.thingId}', auth: true })
    expect(lookupPath(parseExpressionSource('q'), env, ctx('q'))).toBeUndefined()
    expect(lookupPath(parseExpressionSource('r'), env, ctx('r'))).toBeUndefined()
  })
})
