import { describe, expect, it } from 'vitest'
import { hashRule } from '../src/hash.js'
import { RuleSchema } from '../src/rules.js'
import { parseTestFile, serializeTestFile } from '../src/testcase.js'
import { generateTests } from '../src/testgen.js'

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
