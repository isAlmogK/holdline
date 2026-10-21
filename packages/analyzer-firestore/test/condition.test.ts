import { describe, expect, it } from 'vitest'
import type { Expr } from '@holdline/core'
import { normalizeCondition } from '../src/condition.js'
import { parseExpressionSource } from '../src/parse-expr.js'
import { rootEnv, Scope, type Binding, type Env } from '../src/scope.js'
import { simplify } from '../src/simplify.js'
import { cond } from './helpers/cond.js'

const auth: Expr = { atom: { op: 'authenticated' } }
const atom = (a: object): Expr => ({ atom: a } as Expr)

describe('normalizeCondition: spec 4.4 rows', () => {
  it('request.auth != null is authenticated; == null is its negation', () => {
    expect(cond('request.auth != null')).toEqual(auth)
    expect(cond('null != request.auth')).toEqual(auth)
    expect(cond('request.auth == null')).toEqual({ not: auth })
  })
  it('request.auth.uid is actor.uid, with authenticated', () => {
    expect(cond('request.auth.uid == thingId')).toEqual({ and: [auth, atom({ op: 'eq', left: 'actor.uid', right: 'param.thingId' })] })
  })
  it('request.auth.token.k is actor.claim.k', () => {
    expect(cond('request.auth.token.admin == true')).toEqual({ and: [auth, atom({ op: 'eq', left: 'actor.claim.admin', right: { literal: true } })] })
    expect(cond('request.auth.token.firebase.sign_in_provider == "password"')).toMatchObject({ and: [auth, { atom: { left: 'actor.claim.firebase.sign_in_provider' } }] })
  })
  it('resource.data.f is resource.f; request.resource.data.f is incoming.f', () => {
    expect(cond(`resource.data.status == 'open'`)).toEqual(atom({ op: 'eq', left: 'resource.status', right: { literal: 'open' } }))
    expect(cond(`request.resource.data.status != 'x'`)).toEqual(atom({ op: 'ne', left: 'incoming.status', right: { literal: 'x' } }))
    expect(cond(`resource.data['status'] == 'open'`)).toEqual(atom({ op: 'eq', left: 'resource.status', right: { literal: 'open' } }))
  })
  it('Storage reads metadata', () => {
    expect(cond(`resource.metadata.owner == request.auth.uid`, { store: 'storage' }))
      .toEqual({ and: [auth, atom({ op: 'eq', left: 'resource.owner', right: 'actor.uid' })] })
    expect(cond(`request.resource.metadata.owner == 'a'`, { store: 'storage' })).toEqual(atom({ op: 'eq', left: 'incoming.owner', right: { literal: 'a' } }))
    expect(cond(`resource.data.owner == 'a'`, { store: 'storage' })).toEqual({ opaque: `resource.data.owner == 'a'` })
  })
  it('a path wildcard is param.x', () => {
    expect(cond(`thingId == 'a'`)).toEqual(atom({ op: 'eq', left: 'param.thingId', right: { literal: 'a' } }))
  })
  it('maps == != < > and in with a list', () => {
    expect(cond('resource.data.n < 3')).toEqual(atom({ op: 'lt', left: 'resource.n', right: { literal: 3 } }))
    expect(cond('resource.data.n > -1')).toEqual(atom({ op: 'gt', left: 'resource.n', right: { literal: -1 } }))
    expect(cond(`resource.data.s in ['a', 'b']`)).toEqual(atom({ op: 'in', left: 'resource.s', right: { literal: ['a', 'b'] } }))
    expect(cond(`request.auth.uid in resource.data.editors`)).toEqual({ and: [auth, atom({ op: 'in', left: 'actor.uid', right: 'resource.editors' })] })
  })
  it('maps && || ! true false and the ternary', () => {
    expect(cond('true')).toEqual({ and: [] })
    expect(cond('false')).toEqual({ or: [] })
    const a = atom({ op: 'eq', left: 'resource.a', right: { literal: 1 } })
    const b = atom({ op: 'eq', left: 'resource.b', right: { literal: 2 } })
    const c = atom({ op: 'eq', left: 'resource.c', right: { literal: 3 } })
    expect(cond('resource.data.a == 1 && resource.data.b == 2')).toEqual({ and: [a, b] })
    expect(cond('resource.data.a == 1 || resource.data.b == 2')).toEqual({ or: [a, b] })
    expect(cond('!(resource.data.a == 1)')).toEqual({ not: a })
    expect(cond('resource.data.a == 1 ? resource.data.b == 2 : resource.data.c == 3')).toEqual({ or: [{ and: [a, b] }, { and: [{ not: a }, c] }] })
  })
  it('a bare boolean field is eq true', () => {
    expect(cond('resource.data.published')).toEqual(atom({ op: 'eq', left: 'resource.published', right: { literal: true } }))
  })
  it('adds authenticated per atom, not to the whole condition', () => {
    expect(cond('resource.data.public == true || request.auth.uid == resource.data.owner')).toEqual({ or: [
      atom({ op: 'eq', left: 'resource.public', right: { literal: true } }),
      { and: [auth, atom({ op: 'eq', left: 'actor.uid', right: 'resource.owner' })] },
    ] })
    expect(cond('request.auth != null && request.auth.uid == thingId')).toEqual({ and: [auth, atom({ op: 'eq', left: 'actor.uid', right: 'param.thingId' })] })
  })
  it('x.get(f, d) is x.f only when d cannot satisfy the comparison', () => {
    expect(cond(`resource.data.get('role', '') == 'admin'`)).toEqual(atom({ op: 'eq', left: 'resource.role', right: { literal: 'admin' } }))
    expect(cond(`request.auth.token.get('admin', false) == true`)).toEqual({ and: [auth, atom({ op: 'eq', left: 'actor.claim.admin', right: { literal: true } })] })
    expect(cond(`resource.data.get('role', null) == resource.data.x`)).toEqual(atom({ op: 'eq', left: 'resource.role', right: 'resource.x' }))
    expect(cond(`resource.data.get('role', 'admin') == 'admin'`)).toEqual({ opaque: `resource.data.get('role', 'admin') == 'admin'` })
    expect(cond(`resource.data.get('role', '') != 'admin'`)).toEqual({ opaque: `resource.data.get('role', '') != 'admin'` })
    expect(cond(`resource.data.get('n', 5) > 3`)).toMatchObject({ opaque: expect.any(String) })
    expect(cond(`resource.data.get('n', 0) > 3`)).toEqual(atom({ op: 'gt', left: 'resource.n', right: { literal: 3 } }))
    expect(cond(`resource.data.get('r', '') == request.auth.uid`)).toMatchObject({ opaque: expect.any(String) })
  })
  it('everything else is opaque with its source text', () => {
    for (const src of [
      'request.time < resource.data.expires', 'resource.data.tags.size() > 0', `resource.data.keys().hasAny(['a'])`,
      `resource.data.name.matches('a.*')`, 'resource.data.n <= 3', 'resource.data.n >= 3', 'resource.data.n is int',
      `'f' in resource.data`, `resource.data.a == 1 + 1`, `{'a': 1} == resource.data.m`, `resource == null`,
    ]) {
      expect(cond(src)).toEqual({ opaque: src })
    }
  })
  it('opaque text collapses whitespace', () => {
    expect(cond('request.time <\n      resource.data.expires')).toEqual({ opaque: 'request.time < resource.data.expires' })
  })
})

describe('normalizeCondition: soundness guards', () => {
  it('compares request.auth only with a null literal', () => {
    expect(cond(`request.auth == 'x'`)).toEqual({ opaque: `request.auth == 'x'` })
    expect(cond(`request.auth != resource.data.a`)).toEqual({ opaque: `request.auth != resource.data.a` })
    expect(cond('request.auth.uid == null')).toEqual({ and: [auth, atom({ op: 'eq', left: 'actor.uid', right: { literal: null } })] })
  })
  it('a field name with a dot or a dash is not an operand', () => {
    expect(cond(`resource.data['a.b'] == 1`)).toEqual({ opaque: `resource.data['a.b'] == 1` })
    expect(cond(`resource.data['a-b'] == 1`)).toEqual({ opaque: `resource.data['a-b'] == 1` })
    expect(cond(`resource.data.get('a.b', 0) > 3`)).toEqual({ opaque: `resource.data.get('a.b', 0) > 3` })
    expect(cond(`resource.data[thingId] == 1`)).toEqual({ opaque: `resource.data[thingId] == 1` })
  })
  it('nested fields and nested get', () => {
    expect(cond(`resource.data.a.b == 1`)).toEqual(atom({ op: 'eq', left: 'resource.a.b', right: { literal: 1 } }))
    expect(cond(`resource.data.a.get('b', 0) > 3`)).toEqual(atom({ op: 'gt', left: 'resource.a.b', right: { literal: 3 } }))
    expect(cond(`resource.data.get('a', 0).b == 1`)).toMatchObject({ opaque: expect.any(String) })
  })
  it('an ordered fallback comparison that is not between numbers is opaque', () => {
    expect(cond(`resource.data.get('name', 'a') < 'b'`)).toEqual({ opaque: `resource.data.get('name', 'a') < 'b'` })
    expect(cond(`resource.data.get('name', 'z') < 'b'`)).toEqual({ opaque: `resource.data.get('name', 'z') < 'b'` })
    expect(cond(`resource.data.get('n', 0) < null`)).toMatchObject({ opaque: expect.any(String) })
  })
  it('checks a fallback on the right side in operand order', () => {
    expect(cond(`'admin' == resource.data.get('role', '')`)).toEqual(atom({ op: 'eq', left: { literal: 'admin' }, right: 'resource.role' }))
    expect(cond(`'admin' == resource.data.get('role', 'admin')`)).toMatchObject({ opaque: expect.any(String) })
    expect(cond(`3 < resource.data.get('n', 0)`)).toEqual(atom({ op: 'lt', left: { literal: 3 }, right: 'resource.n' }))
    expect(cond(`3 < resource.data.get('n', 5)`)).toMatchObject({ opaque: expect.any(String) })
  })
  it('a fallback on both sides, or on the right of in, is opaque', () => {
    expect(cond(`resource.data.get('a', 1) == resource.data.get('b', 2)`)).toMatchObject({ opaque: expect.any(String) })
    expect(cond(`'a' in resource.data.get('l', ['b'])`)).toMatchObject({ opaque: expect.any(String) })
    expect(cond(`resource.data.get('s', 'x') in ['a', 'b']`)).toEqual(atom({ op: 'in', left: 'resource.s', right: { literal: ['a', 'b'] } }))
    expect(cond(`resource.data.get('s', 'a') in ['a', 'b']`)).toMatchObject({ opaque: expect.any(String) })
  })
  it('in needs an array literal or an operand on the right', () => {
    expect(cond(`resource.data.s in 'abc'`)).toEqual({ opaque: `resource.data.s in 'abc'` })
    expect(cond(`resource.data.n in [-1, 2]`)).toEqual(atom({ op: 'in', left: 'resource.n', right: { literal: [-1, 2] } }))
    expect(cond(`resource.data.n in [resource.data.m]`)).toEqual({ opaque: `resource.data.n in [resource.data.m]` })
    expect(cond(`resource.data.n in [true]`)).toEqual({ opaque: `resource.data.n in [true]` })
  })
  it('a bare value', () => {
    expect(cond('1')).toEqual({ opaque: '1' })
    expect(cond(`'yes'`)).toEqual({ opaque: `'yes'` })
    expect(cond('request.auth')).toEqual({ opaque: 'request.auth' })
    expect(cond('request.auth.token.admin')).toEqual({ and: [auth, atom({ op: 'eq', left: 'actor.claim.admin', right: { literal: true } })] })
    expect(cond(`resource.data.get('published', false)`)).toEqual(atom({ op: 'eq', left: 'resource.published', right: { literal: true } }))
    expect(cond(`resource.data.get('published', true)`)).toEqual({ opaque: `resource.data.get('published', true)` })
  })
  it('a wildcard shadows a global; a rest wildcard is not a string operand', () => {
    expect(cond(`resource == 'a'`, { path: '/things/{resource}' })).toEqual(atom({ op: 'eq', left: 'param.resource', right: { literal: 'a' } }))
    expect(cond(`rest == 'a/b'`, { path: '/things/{rest=**}' })).toEqual({ opaque: `rest == 'a/b'` })
    expect(cond(`unknownName == 'a'`)).toEqual({ opaque: `unknownName == 'a'` })
  })
  it('keeps opaque at the smallest failing sub-node', () => {
    expect(cond(`resource.data.a == 1 && request.time < resource.data.e`)).toEqual({ and: [
      atom({ op: 'eq', left: 'resource.a', right: { literal: 1 } }), { opaque: 'request.time < resource.data.e' },
    ] })
    expect(cond(`!(resource.data.n <= 3)`)).toEqual({ not: { opaque: 'resource.data.n <= 3' } })
  })
  it('opaque text drops only parentheses that wrap the whole node', () => {
    expect(cond(`((resource.data.n <= 3))`)).toEqual({ opaque: 'resource.data.n <= 3' })
    expect(cond(`( resource.data.n <= 3 )`)).toEqual({ opaque: 'resource.data.n <= 3' })
    expect(cond(`(resource.data.n) <= (3)`)).toEqual({ opaque: '(resource.data.n) <= (3)' })
    expect(cond(`(resource.data.s == ')') == (1 <= 2)`)).toEqual({ opaque: `(resource.data.s == ')') == (1 <= 2)` })
    expect(cond(`(resource.data.n <= 3 /* ) */)`)).toEqual({ opaque: 'resource.data.n <= 3 /* ) */' })
  })
  it('an integer past 2^53 is not exact, so its comparison is opaque', () => {
    expect(cond('!(resource.data.n == 9007199254740993)')).toEqual({ not: { opaque: 'resource.data.n == 9007199254740993' } })
    expect(cond('resource.data.n > -9007199254740993')).toEqual({ opaque: 'resource.data.n > -9007199254740993' })
    expect(cond('resource.data.n in [1, 9007199254740993]')).toEqual({ opaque: 'resource.data.n in [1, 9007199254740993]' })
    expect(cond('resource.data.n == 9007199254740991')).toEqual(atom({ op: 'eq', left: 'resource.n', right: { literal: 9007199254740991 } }))
  })
  it('resolves an identifier through a binding in its own env', () => {
    const src = `x == 'a' && y && request.auth.uid == z`
    const node = parseExpressionSource(src)
    const outer = new Scope(undefined, new Set(['thingId']))
    const outerEnv: Env = rootEnv(outer)
    const bindings = new Map<string, Binding>([
      ['x', { node: parseExpressionSource('resource.data.kind'), env: outerEnv }],
      ['y', { node: parseExpressionSource(`resource.data.get('open', false)`), env: outerEnv }],
      ['z', { node: parseExpressionSource('thingId'), env: outerEnv }],
    ])
    const env: Env = { ...rootEnv(new Scope(undefined, new Set())), bindings, depth: 1 }
    const ctx = { store: 'firestore' as const, src, recognizers: new Map<string, string>(), functionCounts: new Map<string, number>(), functionsUsed: new Set<string>() }
    expect(simplify(normalizeCondition(node, env, ctx))).toEqual({ and: [
      atom({ op: 'eq', left: 'resource.kind', right: { literal: 'a' } }),
      atom({ op: 'eq', left: 'resource.open', right: { literal: true } }),
      auth,
      atom({ op: 'eq', left: 'actor.uid', right: 'param.thingId' }),
    ] })
  })
})
