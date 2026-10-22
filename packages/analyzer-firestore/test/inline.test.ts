import { describe, expect, it } from 'vitest'
import { normalizeCondition } from '../src/condition.js'
import { expandRules } from '../src/expand.js'
import { parseRules } from '../src/parser.js'
import { countFunctions, rootEnv } from '../src/scope.js'
import { cond } from './helpers/cond.js'

const auth = { atom: { op: 'authenticated' } }
const DB = '/databases/$(database)/documents'

describe('function inlining', () => {
  it('inlines a parameterized function with arguments substituted', () => {
    const before = `function isMember(orgId) { return exists(${DB}/orgs/$(orgId)/members/$(request.auth.uid)); }`
    expect(cond('isMember(resource.data.orgId)', { before }))
      .toEqual({ and: [auth, { atom: { op: 'exists', doc: '/orgs/{resource.orgId}/members/{actor.uid}' } }] })
  })
  it('substitutes lets in order, after params', () => {
    const before = `function inOrgs(orgId) { let user = get(${DB}/users/$(request.auth.uid)); let ids = user.data.orgIds; return orgId in ids; }`
    expect(cond('inOrgs(resource.data.orgId)', { before }))
      .toEqual({ and: [auth, { atom: { op: 'in', left: 'resource.orgId', right: 'doc(/users/{actor.uid}).orgIds' } }] })
  })
  it('resolves names lexically: a param shadows a wildcard of the same name', () => {
    const before = `function owns(thingId) { return request.auth.uid == thingId; }`
    expect(cond(`owns(resource.data.owner)`, { before })).toEqual({ and: [auth, { atom: { op: 'eq', left: 'actor.uid', right: 'resource.owner' } }] })
  })
  it('a function body sees wildcards of the match it is declared in', () => {
    expect(cond('isMine()', { inside: 'function isMine() { return request.auth.uid == thingId; }' }))
      .toEqual({ and: [auth, { atom: { op: 'eq', left: 'actor.uid', right: 'param.thingId' } }] })
  })
  it('inlines functions that call functions, and functions in value position', () => {
    const before = `function uid() { return request.auth.uid; } function me(x) { return x == uid(); }`
    expect(cond('me(thingId)', { before })).toEqual({ and: [auth, { atom: { op: 'eq', left: 'param.thingId', right: 'actor.uid' } }] })
  })
  it('turns runaway recursion into opaque', () => {
    expect(cond('f()', { before: 'function f() { return f(); }' })).toEqual({ opaque: 'f()' })
  })
  it('an unknown function or wrong arity is opaque', () => {
    expect(cond('nope()')).toEqual({ opaque: 'nope()' })
    expect(cond('f(1, 2)', { before: 'function f(a) { return a == 1; }' })).toEqual({ opaque: 'f(1, 2)' })
  })
  it('a zero-parameter function named by an approved recognizer becomes a ref', () => {
    const before = 'function signedIn() { return request.auth != null; }'
    expect(cond('signedIn() && resource.data.a == 1', { before, recognizers: { signedIn: 'signed-in' } }))
      .toEqual({ and: [{ ref: 'signed-in' }, { atom: { op: 'eq', left: 'resource.a', right: { literal: 1 } } }] })
  })
  it('functions with parameters are inlined even when a recognizer names them', () => {
    const before = 'function isOwner(u) { return request.auth.uid == u; }'
    expect(cond(`isOwner('x')`, { before, recognizers: { isOwner: 'owner' } }))
      .toEqual({ and: [auth, { atom: { op: 'eq', left: 'actor.uid', right: { literal: 'x' } } }] })
  })
})

describe('bindings in condition position', () => {
  it('a let holding a condition is normalized as a condition', () => {
    const before = 'function both() { let ok = resource.data.a == 1 && request.auth != null; return ok; }'
    expect(cond('both()', { before })).toEqual({ and: [{ atom: { op: 'eq', left: 'resource.a', right: { literal: 1 } } }, auth] })
  })
  it('a param receiving a condition argument is normalized as a condition, in the caller\'s env', () => {
    const before = 'function both(x) { return x && request.auth != null; }'
    expect(cond('both(resource.data.a == 1)', { before })).toEqual({ and: [{ atom: { op: 'eq', left: 'resource.a', right: { literal: 1 } } }, auth] })
    expect(cond('both(!(thingId == "a"))', { before })).toEqual({ and: [{ not: { atom: { op: 'eq', left: 'param.thingId', right: { literal: 'a' } } } }, auth] })
  })
  it('a let bound to a path literal is a lookup path in exists(p) and get(p)', () => {
    const inside = `function f() { let p = ${DB}/orgs/$(thingId); return exists(p) && get(p).data.open == true; }`
    expect(cond('f()', { inside })).toEqual({ and: [
      { atom: { op: 'exists', doc: '/orgs/{param.thingId}' } },
      { atom: { op: 'eq', left: 'doc(/orgs/{param.thingId}).open', right: { literal: true } } },
    ] })
  })
  it('get(P).data.get(f, d) keeps authenticated when P reads the caller', () => {
    expect(cond(`get(${DB}/users/$(request.auth.uid)).data.get('role', 'none') == 'admin'`))
      .toEqual({ and: [auth, { atom: { op: 'eq', left: 'doc(/users/{actor.uid}).role', right: { literal: 'admin' } } }] })
  })
})

describe('inlining edge cases', () => {
  it('a later let sees earlier lets and params; a let does not see itself', () => {
    const before = 'function f(a) { let b = a; let c = b; return c == 1; }'
    expect(cond('f(resource.data.x)', { before })).toEqual({ atom: { op: 'eq', left: 'resource.x', right: { literal: 1 } } })
    expect(cond('g()', { before: 'function g() { let x = x; return x == 1; }' })).toEqual({ opaque: 'x == 1' })
  })
  it('a param shadows request and resource', () => {
    const before = 'function f(request) { return request == 1; }'
    expect(cond('f(resource.data.x)', { before })).toEqual({ atom: { op: 'eq', left: 'resource.x', right: { literal: 1 } } })
  })
  it('an argument is read in the caller\'s env, not the callee\'s', () => {
    const before = 'function f(x, thingId) { return x == thingId; }'
    expect(cond(`f(thingId, 'a')`, { before })).toEqual({ atom: { op: 'eq', left: 'param.thingId', right: { literal: 'a' } } })
  })
  it('a function body does not see wildcards of the match it is called from', () => {
    expect(cond('isMine()', { before: 'function isMine() { return request.auth.uid == thingId; }' }))
      .toEqual({ opaque: 'request.auth.uid == thingId' })
  })
  it('a callee does not see the caller\'s params', () => {
    const before = 'function g() { return x == 1; } function f(x) { return g(); }'
    expect(cond('f(resource.data.a)', { before })).toEqual({ opaque: 'x == 1' })
  })
  it('a recognized function in value position is inlined, not a ref', () => {
    const before = 'function uid() { return request.auth.uid; }'
    expect(cond('uid() == resource.data.owner', { before, recognizers: { uid: 'caller' } }))
      .toEqual({ and: [auth, { atom: { op: 'eq', left: 'actor.uid', right: 'resource.owner' } }] })
  })
  it('mutual recursion is opaque', () => {
    expect(cond('f() && resource.data.a == 1', { before: 'function f() { return g(); } function g() { return f(); }' }))
      .toEqual({ and: [{ opaque: 'f()' }, { atom: { op: 'eq', left: 'resource.a', right: { literal: 1 } } }] })
  })
  it('a chain of 20 calls is inlined; 21 is too deep', () => {
    const chain = (n: number) => Array.from({ length: n }, (_, i) =>
      i === n - 1 ? `function f${i}() { return resource.data.a == 1; }` : `function f${i}() { return f${i + 1}(); }`).join(' ')
    expect(cond('f0()', { before: chain(20) })).toEqual({ atom: { op: 'eq', left: 'resource.a', right: { literal: 1 } } })
    expect(cond('f0()', { before: chain(21) })).toEqual({ opaque: 'f20()' })
  })
  it('a user function named like a built-in lookup or conversion is opaque, whichever Firestore would call', () => {
    expect(cond(`exists(${DB}/a/$(thingId))`, { before: 'function exists(p) { return true; }' })).toEqual({ opaque: `exists(${DB}/a/$(thingId))` })
    expect(cond(`get(${DB}/a/$(thingId)).data.x == 1`, { before: 'function get(p) { return p; }' })).toEqual({ opaque: `get(${DB}/a/$(thingId)).data.x == 1` })
    expect(cond('string(resource.data.a)', { before: 'function string(x) { return true; }' })).toEqual({ opaque: 'string(resource.data.a)' })
  })
  it('records user functions used, for inline and ref, not built-ins', () => {
    const src = `service cloud.firestore { match /databases/{database}/documents {
      function signedIn() { return request.auth != null; }
      function uid() { return request.auth.uid; }
      function owns(x) { return signedIn() && x == uid(); }
      match /things/{thingId} { allow read: if owns(resource.data.owner) && exists(${DB}/a/$(thingId)); } } }`
    const r = parseRules(src)
    if (!r.ok) throw new Error(r.error.message)
    const site = expandRules(r.ast).allows[0]!
    const ctx = { store: 'firestore' as const, src, recognizers: new Map([['signedIn', 'signed-in']]), functionCounts: countFunctions(r.ast), functionsUsed: new Set<string>() }
    normalizeCondition(site.allow.condition!, rootEnv(site.scope), ctx)
    expect([...ctx.functionsUsed].sort()).toEqual(['owns', 'signedIn', 'uid'])
  })
})

describe('recognizers match only a function declared once in the file', () => {
  it('a recognized name shadowed by another declaration is inlined, not a ref', () => {
    const before = 'function signedIn() { return request.auth != null; }'
    const inside = 'function signedIn() { return true; }'
    expect(cond('signedIn()', { before, inside, recognizers: { signedIn: 'signed-in' } })).toEqual(cond('true'))
  })
  it('a recognized name declared in two sibling matches is inlined, not a ref', () => {
    const fn = 'function signedIn() { return request.auth != null; }'
    expect(cond('signedIn()', { before: `match /other/{o} { ${fn} }`, inside: fn, recognizers: { signedIn: 'signed-in' } }))
      .toEqual(auth)
  })
})

describe('inlining limits', () => {
  it('a function calling itself is opaque at once, even when it calls itself twice', () => {
    const t = performance.now()
    expect(cond('f()', { before: 'function f() { return f() && f(); }' })).toEqual({ and: [{ opaque: 'f()' }, { opaque: 'f()' }] })
    expect(performance.now() - t).toBeLessThan(1000)
  })
  it('a 20-deep chain where each function calls the next twice stops at the inlining budget', () => {
    const before = Array.from({ length: 20 }, (_, i) =>
      i === 19 ? `function f${i}() { return resource.data.a == 1; }` : `function f${i}() { return f${i + 1}() && f${i + 1}(); }`).join(' ')
    const t = performance.now()
    const result = cond('f0()', { before })
    expect(performance.now() - t).toBeLessThan(1000)
    expect(JSON.stringify(result)).toContain('"opaque"')
    expect(JSON.stringify(result)).toContain('"resource.a"')
  })
})

describe('binding limits', () => {
  /** `let a<i> = step(a<i-1>)` for i in 1..n-1, each binding referenced twice by the next. */
  const chain = (n: number, first: string, step: (prev: string) => string, ret: string) =>
    `function f() { let a0 = ${first}; ${Array.from({ length: n - 1 }, (_, i) => `let a${i + 1} = ${step(`a${i}`)};`).join(' ')} return ${ret.replace('LAST', `a${n - 1}`)}; }`
  it('30 chained lets, each used twice in condition position, finish fast and turn opaque past the budget', () => {
    const before = chain(30, 'resource.data.a == 1', p => `${p} && ${p}`, 'LAST')
    const t = performance.now()
    const result = cond('f()', { before })
    expect(performance.now() - t).toBeLessThan(1000)
    expect(JSON.stringify(result)).toContain('"opaque"')
  })
  it('30 chained lets, each used twice in value position, finish fast and turn opaque', () => {
    const before = chain(30, `'k'`, p => `resource.data.get(${p}, ${p})`, 'LAST == 1')
    const t = performance.now()
    const result = cond('f()', { before })
    expect(performance.now() - t).toBeLessThan(1000)
    expect(JSON.stringify(result)).toContain('"opaque"')
  })
})
