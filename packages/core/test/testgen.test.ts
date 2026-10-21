import { describe, expect, it } from 'vitest'
import { hashRule } from '../src/hash.js'
import { RuleSchema } from '../src/rules.js'
import { parseTestFile, serializeTestFile } from '../src/testcase.js'
import { generateTests } from '../src/testgen.js'
import type { DataAccessRule } from '../src/rules.js'
import { holds } from '../src/testgen-eval.js'
import { freshWorld } from '../src/testgen-satisfy.js'

const vocab = new Map()
const rule = (raw: Record<string, unknown>) => RuleSchema.parse({ id: 'R-001', text: 't', status: 'approved', ...raw })

describe('generateTests for firestore', () => {
  const r = rule({
    type: 'data-access',
    target: { store: 'firestore', path: '/accounts/{accountId}/dogs/{dogId}' },
    ops: ['read'],
    requires: { and: [
      { atom: { op: 'exists', doc: '/accounts/{param.accountId}/members/{actor.uid}' } },
      { atom: { op: 'isNull', operand: 'resource.deletedAt' } },
    ] },
  })
  const file = generateTests(r, vocab)!

  it('records the rule hash and store', () => {
    expect(file.rule).toBe('R-001')
    expect(file.generatedFrom).toBe(hashRule(r, vocab))
    expect(file.store).toBe('firestore')
  })
  it('makes one allow case and one deny case per atom', () => {
    expect(file.cases.map(c => [c.name, c.expect])).toEqual([
      ['read: allowed when every condition holds', 'allow'],
      ['read: denied without exists(/accounts/{param.accountId}/members/{actor.uid})', 'deny'],
      ['read: denied without resource.deletedAt is null', 'deny'],
    ])
  })
  it('seeds the satisfying world', () => {
    const allow = file.cases[0]!
    expect(allow.as).toEqual({ uid: 'user-1', claims: {} })
    expect(allow.do).toEqual({ op: 'read', path: '/accounts/accountId-1/dogs/dogId-1' })
    expect(allow.seed).toEqual([
      { path: '/accounts/accountId-1/dogs/dogId-1', data: { deletedAt: null } },
      { path: '/accounts/accountId-1/members/user-1', data: {} },
    ])
  })
  it('breaks one atom per deny case', () => {
    expect(file.cases[1]!.seed).toEqual([{ path: '/accounts/accountId-1/dogs/dogId-1', data: { deletedAt: null } }])
    expect(file.cases[2]!.seed[0]!.data).toEqual({ deletedAt: 'not-null' })
  })
  it('round-trips through YAML', () => {
    expect(parseTestFile(serializeTestFile(file))).toEqual(file)
  })
})

describe('generateTests for postgres', () => {
  it('builds rows, claims and pg exists seeds', () => {
    const r = rule({
      type: 'data-access',
      target: { store: 'postgres', table: 'dogs' },
      ops: ['read', 'update'],
      requires: { and: [
        { atom: { op: 'eq', left: 'actor.claim.team_id', right: 'resource.team_id' } },
        { atom: { op: 'exists', doc: 'pg:public.members?team_id={resource.team_id}&user_id={actor.uid}' } },
      ] },
    })
    const file = generateTests(r, vocab)!
    const allowRead = file.cases[0]!
    expect(allowRead.as).toEqual({ uid: 'user-1', claims: { team_id: 'value-1' } })
    expect(allowRead.seed).toEqual([
      { path: 'public.dogs', data: { team_id: 'value-1' } },
      { path: 'public.members', data: { team_id: 'value-1', user_id: 'user-1' } },
    ])
    expect(allowRead.do).toEqual({ op: 'read', path: 'public.dogs' })
    const denyClaim = file.cases[1]!
    expect(denyClaim.seed[0]!.data).toEqual({ team_id: 'other-value' })
    expect(file.cases.filter(c => c.do.op === 'update')[0]!.do.data).toEqual({ team_id: 'value-1' })
  })
})

describe('generateTests limits', () => {
  it('skips requirements it cannot build worlds for', () => {
    const r = rule({
      type: 'data-access',
      target: { store: 'firestore', path: '/dogs/{dogId}' },
      ops: ['read', 'list'],
      requires: { or: [{ atom: { op: 'authenticated' } }, { opaque: 'x' }] },
    })
    const file = generateTests(r, vocab)!
    expect(file.cases).toEqual([])
    expect(file.skipped[0]).toMatch(/only "and" of atoms/)
  })
  it('skips list when the requirement reads the stored record', () => {
    const r = rule({
      type: 'data-access',
      target: { store: 'firestore', path: '/dogs/{dogId}' },
      ops: ['list'],
      requires: { atom: { op: 'eq', left: 'actor.uid', right: 'resource.ownerId' } },
    })
    expect(generateTests(r, vocab)!.skipped).toEqual(['list: needs query filters to test; read cases cover the condition'])
  })
  it('returns undefined for other rule types', () => {
    expect(generateTests(rule({ type: 'access', target: { routes: 'GET /a' }, requires: { atom: { op: 'authenticated' } } }), vocab)).toBeUndefined()
  })
})

describe('generateTests fails loudly instead of guessing', () => {
  const fs = (requires: unknown, ops: string[] = ['read']) =>
    rule({ type: 'data-access', target: { store: 'firestore', path: '/dogs/{dogId}' }, ops, requires })
  const skippedOnly = (r: ReturnType<typeof rule>) => {
    const f = generateTests(r, vocab)!
    expect(f.cases).toEqual([])
    expect(f.skipped.length).toBeGreaterThan(0)
  }

  it('skips literal and actor.uid targets', () => {
    skippedOnly(fs({ atom: { op: 'eq', left: 'actor.uid', right: { literal: 'admin' } } }))
  })
  it('skips exists placeholders nothing sets', () => {
    skippedOnly(rule({
      type: 'data-access',
      target: { store: 'postgres', table: 'dogs' },
      ops: ['read'],
      requires: { atom: { op: 'exists', doc: 'pg:public.m?o={resource.owner}' } },
    }))
  })
  it('serializes without YAML anchors', () => {
    const f = generateTests(fs({ atom: { op: 'exists', doc: '/m/{actor.uid}' } }, ['read', 'update', 'delete']), vocab)!
    const text = serializeTestFile(f)
    expect(text).not.toMatch(/[&*][a-z0-9]/i)
    expect(parseTestFile(text)).toEqual(f)
  })
  it('skips conflicting atoms', () => {
    skippedOnly(rule({
      type: 'data-access',
      target: { store: 'postgres', table: 'dogs' },
      ops: ['read'],
      requires: { and: [
        { atom: { op: 'eq', left: 'actor.claim.t', right: 'resource.t' } },
        { atom: { op: 'eq', left: 'resource.t', right: { literal: 'a' } } },
      ] },
    }))
    skippedOnly(fs({ and: [
      { atom: { op: 'isNull', operand: 'resource.x' } },
      { atom: { op: 'eq', left: 'resource.x', right: { literal: 'a' } } },
    ] }))
  })
  it('dedupes duplicate atoms', () => {
    const member = { atom: { op: 'exists', doc: '/m/{actor.uid}' } }
    const f = generateTests(fs({ and: [member, member] }, ['read', 'delete']), vocab)!
    expect(f.cases.map(c => c.expect)).toEqual(['allow', 'deny', 'allow', 'deny'])
  })
  it('skips nested fields', () => {
    skippedOnly(fs({ atom: { op: 'isNull', operand: 'resource.owner.id' } }))
  })
  it('skips create when the condition reads the stored record', () => {
    const f = generateTests(fs({ atom: { op: 'isNull', operand: 'resource.deletedAt' } }, ['create', 'read']), vocab)!
    expect(f.skipped).toEqual(['create: the condition reads the stored record, which does not exist on create'])
    expect(f.cases.every(c => c.do.op === 'read')).toBe(true)
  })
  it('keeps the satisfied value in update deny data', () => {
    const f = generateTests(fs({ atom: { op: 'isNull', operand: 'resource.deletedAt' } }, ['update']), vocab)!
    const deny = f.cases[1]!
    expect(deny.seed[0]!.data).toEqual({ deletedAt: 'not-null' })
    expect(deny.do.data).toEqual({ deletedAt: null })
  })
})

describe('deny cases break only their own atom', () => {
  it('sends broken incoming data on deny and satisfying data on allow', () => {
    const r = rule({
      type: 'data-access',
      target: { store: 'firestore', path: '/dogs/{dogId}' },
      ops: ['update', 'create'],
      requires: { atom: { op: 'in', left: 'incoming.status', right: { literal: ['a', 'b'] } } },
    })
    const f = generateTests(r, vocab)!
    for (const op of ['update', 'create']) {
      const cases = f.cases.filter(c => c.do.op === op)
      expect(cases.find(c => c.expect === 'allow')!.do.data).toEqual({ status: 'a' })
      expect(cases.find(c => c.expect === 'deny')!.do.data).toEqual({ status: 'not-allowed' })
    }
  })
})

describe('test case contract', () => {
  it('accepts expect: reject for writes the database must refuse (invariant cases)', () => {
    const text = `rule: R-009
generatedFrom: abc
store: postgres
cases:
  - name: "create: rejected without team_id"
    as: null
    do: { op: create, path: public.dogs, data: { team_id: null } }
    expect: reject
`
    expect(parseTestFile(text).cases[0]!.expect).toBe('reject')
    expect(() => parseTestFile(text.replace('expect: reject', 'expect: maybe'))).toThrow()
  })
})

describe('generateTests with lookup operands', () => {
  const vocab = new Map()
  const rule = (requires: unknown, ops: string[] = ['read']) => RuleSchema.parse({
    id: 'R-001', text: 't', status: 'approved', type: 'data-access',
    target: { store: 'firestore', path: '/dogs/{dogId}' }, ops, requires,
  })

  it('seeds the looked-up document so membership holds, and breaks it on deny', () => {
    const file = generateTests(rule({ and: [
      { atom: { op: 'authenticated' } },
      { atom: { op: 'in', left: 'resource.accountId', right: 'doc(/users/{actor.uid}).accountIds' } },
    ] }), vocab)!
    const [allow, denyAuth, denyMember] = file.cases
    expect(allow!.expect).toBe('allow')
    expect(allow!.seed).toEqual([
      { path: '/dogs/dogId-1', data: { accountId: 'value-1' } },
      { path: '/users/user-1', data: { accountIds: ['value-1'] } },
    ])
    expect(denyAuth!.as).toBeNull()
    expect(denyMember!.expect).toBe('deny')
    expect(denyMember!.seed.find(s => s.path === '/dogs/dogId-1')!.data).toEqual({ accountId: 'other-value' })
  })

  it('seeds a role field on a looked-up member document', () => {
    const file = generateTests(rule({ atom: { op: 'eq', left: 'doc(/accounts/{resource.accountId}/members/{actor.uid}).role', right: { literal: 'admin' } } }), vocab)!
    expect(file.skipped).toEqual([])
    const allow = file.cases[0]!
    expect(allow.seed).toContainEqual({ path: '/accounts/value-1/members/user-1', data: { role: 'admin' } })
    expect(file.cases[1]!.seed).toContainEqual({ path: '/accounts/value-1/members/user-1', data: { role: 'other-value' } })
  })

  it('merges an exists doc and a lookup on the same path into one seed', () => {
    const file = generateTests(rule({ and: [
      { atom: { op: 'exists', doc: '/accounts/{resource.accountId}/members/{actor.uid}' } },
      { atom: { op: 'eq', left: 'doc(/accounts/{resource.accountId}/members/{actor.uid}).role', right: { literal: 'admin' } } },
    ] }), vocab)!
    const memberSeeds = file.cases[0]!.seed.filter(s => s.path === '/accounts/value-1/members/user-1')
    expect(memberSeeds).toEqual([{ path: '/accounts/value-1/members/user-1', data: { role: 'admin' } }])
  })

  it('skips a lookup whose path cannot be resolved', () => {
    const file = generateTests(rule({ atom: { op: 'eq', left: 'doc(/orgs/{actor.claim.orgId}).open', right: { literal: true } } }), vocab)!
    expect(file.cases).toEqual([])
    expect(file.skipped[0]).toMatch(/cannot resolve \{actor\.claim\.orgId\}/)
  })

  it('creates a value for a stored-record field that only a lookup path needs', () => {
    const file = generateTests(rule({ atom: { op: 'eq', left: 'doc(/orgs/{resource.orgId}).open', right: { literal: true } } }), vocab)!
    expect(file.cases[0]!.seed).toEqual([
      { path: '/dogs/dogId-1', data: { orgId: 'value-1' } },
      { path: '/orgs/value-1', data: { open: true } },
    ])
  })

  it('skips the exists deny case when a lookup needs the same document', () => {
    const file = generateTests(rule({ and: [
      { atom: { op: 'exists', doc: '/accounts/{resource.accountId}/members/{actor.uid}' } },
      { atom: { op: 'eq', left: 'doc(/accounts/{resource.accountId}/members/{actor.uid}).role', right: { literal: 'admin' } } },
    ] }), vocab)!
    expect(file.cases.map(c => c.name)).toEqual([
      'read: allowed when every condition holds',
      expect.stringContaining('denied without doc(/accounts/{resource.accountId}/members/{actor.uid}).role'),
    ])
    expect(file.skipped).toEqual([expect.stringMatching(/^read: cannot deny only exists\(.*\) \(other conditions depend on the same values\)$/)])
    const member = file.cases[1]!.seed.find(s => s.path === '/accounts/value-1/members/user-1')
    expect(member!.data).toEqual({ role: 'other-value' })
  })

  describe('atoms that share values', () => {
    const accountIds = 'doc(/users/{actor.uid}).accountIds'
    const memberRole = 'doc(/accounts/{resource.accountId}/members/{actor.uid}).role'
    const inUsers = { atom: { op: 'in', left: 'resource.accountId', right: accountIds } }
    const isAdmin = { atom: { op: 'eq', left: memberRole, right: { literal: 'admin' } } }
    const shape = (f: { cases: { name: string; as: unknown; seed: { path: string }[]; do: unknown; expect: string }[] }) =>
      f.cases.map(c => ({ ...c, seed: [...c.seed].sort((x, y) => x.path.localeCompare(y.path)) })).sort((x, y) => x.name.localeCompare(y.name))

    it('generates the same cases in either atom order', () => {
      const ab = generateTests(rule({ and: [inUsers, isAdmin] }), vocab)!
      const ba = generateTests(rule({ and: [isAdmin, inUsers] }), vocab)!
      expect(ab.skipped).toEqual([])
      expect(ba.skipped).toEqual([])
      expect(ab.cases).toHaveLength(3)
      expect(shape(ba)).toEqual(shape(ab))
    })

    it('uses an already set stored-record field when a path param fixes it', () => {
      const file = generateTests(RuleSchema.parse({
        id: 'R-001', text: 't', status: 'approved', type: 'data-access',
        target: { store: 'firestore', path: '/accounts/{accountId}/dogs/{dogId}' }, ops: ['read'],
        requires: { and: [
          { atom: { op: 'eq', left: 'resource.accountId', right: 'param.accountId' } },
          inUsers,
        ] },
      }), vocab)!
      expect(file.skipped).toEqual([])
      expect(file.cases[0]!.seed).toEqual([
        { path: '/accounts/accountId-1/dogs/dogId-1', data: { accountId: 'accountId-1' } },
        { path: '/users/user-1', data: { accountIds: ['accountId-1'] } },
      ])
    })

    it('denies the membership atom without moving the record the role lookup is keyed on', () => {
      const file = generateTests(rule({ and: [inUsers, isAdmin] }), vocab)!
      const deny = file.cases.find(c => c.name.includes('denied without resource.accountId in'))!
      expect(deny.seed).toContainEqual({ path: '/dogs/dogId-1', data: { accountId: 'value-1' } })
      expect(deny.seed).toContainEqual({ path: '/accounts/value-1/members/user-1', data: { role: 'admin' } })
      expect(deny.seed).toContainEqual({ path: '/users/user-1', data: { accountIds: ['other-value'] } })
    })

    it('denies exactly one atom when a path param fixes the record field the lookup is keyed on', () => {
      const file = generateTests(RuleSchema.parse({
        id: 'R-001', text: 't', status: 'approved', type: 'data-access',
        target: { store: 'firestore', path: '/accounts/{accountId}/dogs/{dogId}' }, ops: ['read'],
        requires: { and: [{ atom: { op: 'eq', left: 'resource.accountId', right: 'param.accountId' } }, isAdmin] },
      }), vocab)!
      expect(file.skipped).toEqual([])
      const [, denyParam, denyRole] = file.cases
      // The record no longer matches the path param; the member doc is keyed on the record's value and still has the role.
      expect(denyParam!.seed).toEqual([
        { path: '/accounts/accountId-1/dogs/dogId-1', data: { accountId: 'other-value' } },
        { path: '/accounts/other-value/members/user-1', data: { role: 'admin' } },
      ])
      // The record matches the path param; only the role differs.
      expect(denyRole!.seed).toEqual([
        { path: '/accounts/accountId-1/dogs/dogId-1', data: { accountId: 'accountId-1' } },
        { path: '/accounts/accountId-1/members/user-1', data: { role: 'other-value' } },
      ])
    })
  })

  it('merges a lookup of the target document into the record seed', () => {
    const file = generateTests(rule({ atom: { op: 'eq', left: 'doc(/dogs/{param.dogId}).ownerId', right: 'actor.uid' } }), vocab)!
    expect(file.skipped).toEqual([])
    expect(file.cases[0]!.seed).toEqual([{ path: '/dogs/dogId-1', data: { ownerId: 'user-1' } }])
    expect(file.cases[1]!.seed).toEqual([{ path: '/dogs/dogId-1', data: { ownerId: 'other-value' } }])
  })

  it('does not generate create for a lookup of the target document', () => {
    const file = generateTests(rule({ atom: { op: 'eq', left: 'doc(/dogs/{param.dogId}).ownerId', right: 'actor.uid' } }, ['create']), vocab)!
    expect(file.cases).toEqual([])
    expect(file.skipped[0]).toMatch(/^create: the condition reads the stored record/)
  })

  it('skips dotted lookup fields and unsupported comparisons', () => {
    const dotted = generateTests(rule({ atom: { op: 'eq', left: 'doc(/accounts/x).plan.tier', right: { literal: 'pro' } } }), vocab)!
    expect(dotted.cases).toEqual([])
    expect(dotted.skipped[0]).toMatch(/nested field/)
    const lt = generateTests(rule({ atom: { op: 'lt', left: 'doc(/accounts/x).n', right: { literal: 3 } } }), vocab)!
    expect(lt.cases).toEqual([])
    expect(lt.skipped).toHaveLength(1)
  })
})

describe('exists on the record under test', () => {
  const r = rule({
    type: 'data-access',
    target: { store: 'firestore', path: '/dogs/{dogId}' },
    ops: ['read', 'create'],
    requires: { and: [
      { atom: { op: 'exists', doc: '/dogs/{param.dogId}' } },
      { atom: { op: 'eq', left: 'resource.ownerId', right: 'actor.uid' } },
    ] },
  })
  const file = generateTests(r, vocab)!

  it('seeds every path once, merging the exists doc into the record', () => {
    expect(file.cases.length).toBeGreaterThan(0)
    for (const c of file.cases) expect(new Set(c.seed.map(s => s.path)).size).toBe(c.seed.length)
    expect(file.cases[0]!.seed).toEqual([{ path: '/dogs/dogId-1', data: { ownerId: 'user-1' } }])
  })
  it('skips create, where the record does not exist yet', () => {
    const only = generateTests(rule({
      type: 'data-access',
      target: { store: 'firestore', path: '/dogs/{dogId}' },
      ops: ['create', 'read'],
      requires: { atom: { op: 'exists', doc: '/dogs/{param.dogId}' } },
    }), vocab)!
    expect(only.cases.map(c => c.do.op)).toEqual(['read'])
    expect(only.cases[0]!.seed).toEqual([{ path: '/dogs/dogId-1', data: {} }])
    expect(only.skipped).toEqual([
      'create: the condition reads the stored record, which does not exist on create',
      expect.stringMatching(/^read: cannot deny only exists\(\/dogs\/\{param\.dogId\}\)/),
    ])
  })
  it('does not treat exists(record) as true on create', () => {
    const w = freshWorld(r as DataAccessRule)
    const atom = { op: 'exists', doc: '/dogs/{param.dogId}' } as const
    expect(holds(w, atom)).toBe(true)
    expect(holds(w, atom, 'create')).toBe(false)
  })
})

describe('ops that send no data', () => {
  it('skips read, list and delete when a condition reads the incoming write', () => {
    const f = generateTests(rule({
      type: 'data-access',
      target: { store: 'firestore', path: '/dogs/{dogId}' },
      ops: ['read', 'update', 'delete'],
      requires: { atom: { op: 'eq', left: 'incoming.status', right: { literal: 'active' } } },
    }), vocab)!
    expect(f.cases.map(c => [c.do.op, c.expect])).toEqual([['update', 'allow'], ['update', 'deny']])
    expect(f.skipped).toEqual([
      'read: the condition reads the incoming write, which read does not send',
      'delete: the condition reads the incoming write, which delete does not send',
    ])
  })
  it('also when the incoming write is read inside a lookup path', () => {
    const viaLookup = generateTests(rule({
      type: 'data-access',
      target: { store: 'firestore', path: '/dogs/{dogId}' },
      ops: ['delete'],
      requires: { atom: { op: 'eq', left: 'doc(/orgs/{incoming.orgId}).open', right: { literal: true } } },
    }), vocab)!
    expect(viaLookup.cases).toEqual([])
    expect(viaLookup.skipped).toEqual(['delete: the condition reads the incoming write, which delete does not send'])
  })
})
