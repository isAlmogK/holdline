import { describe, expect, it } from 'vitest'
import type { Atom, Expr } from '../src/expr.js'
import { parseFacts } from '../src/facts.js'
import { formatAtom } from '../src/format.js'
import { hashRule } from '../src/hash.js'
import { RuleSchema } from '../src/rules.js'
import { generateTests } from '../src/testgen.js'

const vocab = new Map<string, Expr>()
const rule = (raw: Record<string, unknown>) => RuleSchema.parse({ id: 'R-002', text: 't', status: 'approved', ...raw })

const authenticated: Atom = { op: 'authenticated' }
const inOrgs: Atom = { op: 'in', left: 'incoming.orgId', right: 'doc(/users/{actor.uid}).orgIds' }
const statusIn = (values: string[]): Atom => ({ op: 'in', left: 'incoming.status', right: { literal: values } })
const and = (...atoms: Atom[]): Expr => ({ and: atoms.map(atom => ({ atom })) })

const projects = '/projects/{projectId}'
const fsPolicy = (n: number, condition: unknown, ops = ['create']) =>
  ({ id: `firestore:${projects}#create@${n}`, store: 'firestore', target: projects, ops, condition })
const fsFacts = (...policies: unknown[]) => parseFacts({ version: 1, policies })
const createRule = (ops = ['create']) =>
  rule({ type: 'data-access', target: { store: 'firestore', path: projects }, ops, requires: and(authenticated, inOrgs) })

const users = { path: '/users/user-1', data: { orgIds: ['value-1'] } }

describe('generateTests satisfies the op policy from the facts', () => {
  it('fills the fields the create policy needs beyond the rule', () => {
    const r = createRule()
    const f = generateTests(r, vocab, fsFacts(fsPolicy(5, and(authenticated, inOrgs, statusIn(['active', 'archived'])))))!
    expect(f.generatedFrom).toBe(hashRule(r, vocab))
    expect(f.skipped).toEqual([])
    expect(f.cases[0]).toEqual({
      name: 'create: allowed when every condition holds',
      as: { uid: 'user-1', claims: {} },
      seed: [users],
      do: { op: 'create', path: '/projects/projectId-1', data: { orgId: 'value-1', status: 'active' } },
      expect: 'allow',
    })
    expect(f.cases.map(c => [c.name, c.expect])).toEqual([
      ['create: allowed when every condition holds', 'allow'],
      [`create: denied without ${formatAtom(authenticated)}`, 'deny'],
      [`create: denied without ${formatAtom(inOrgs)}`, 'deny'],
    ])
    for (const c of f.cases) expect(c.do.data).toMatchObject({ status: 'active' })
    expect(f.cases[1]!.as).toBeNull()
    expect(f.cases[2]!.do.data).not.toEqual(f.cases[0]!.do.data)
  })

  it('passes over candidates that are opaque or have "or", and uses the next one', () => {
    const f = generateTests(createRule(), vocab, fsFacts(
      fsPolicy(1, { opaque: 'custom()' }),
      fsPolicy(2, { or: [{ atom: authenticated }, { atom: inOrgs }] }),
      fsPolicy(3, and(authenticated, inOrgs, statusIn(['active']))),
    ))!
    expect(f.cases[0]!.do.data).toEqual({ orgId: 'value-1', status: 'active' })
    expect(f.cases).toHaveLength(3)
  })

  it('passes over a candidate whose extras conflict with the rule', () => {
    const r = rule({ type: 'data-access', target: { store: 'firestore', path: projects }, ops: ['create'],
      requires: and(authenticated, statusIn(['b'])) })
    const conflicting = fsPolicy(1, and(authenticated, statusIn(['b']), statusIn(['a'])))
    expect(generateTests(r, vocab, fsFacts(conflicting))).toEqual(generateTests(r, vocab))
    const f = generateTests(r, vocab, fsFacts(conflicting, fsPolicy(2, and(authenticated, statusIn(['b']), { op: 'isNull', operand: 'incoming.note' }))))!
    expect(f.cases[0]!.do.data).toEqual({ status: 'b', note: null })
  })

  it('passes over a candidate whose world does not satisfy it for the op', () => {
    // The target document never exists on create, so this create policy cannot be met.
    const f = generateTests(createRule(), vocab, fsFacts(fsPolicy(1, and(authenticated, inOrgs, { op: 'exists', doc: '/projects/{param.projectId}' }))))!
    expect(f).toEqual(generateTests(createRule(), vocab))
  })

  it('expands a policy condition with the vocabulary', () => {
    const v = new Map<string, Expr>([['validStatus', { atom: statusIn(['active', 'archived']) }]])
    const f = generateTests(createRule(), v, fsFacts(fsPolicy(1, { and: [{ atom: authenticated }, { atom: inOrgs }, { ref: 'validStatus' }] })))!
    expect(f.cases[0]!.do.data).toEqual({ orgId: 'value-1', status: 'active' })
  })

  it('solves each op against its own policy', () => {
    const f = generateTests(createRule(['create', 'update']), vocab, fsFacts(
      fsPolicy(1, and(authenticated, inOrgs, statusIn(['active']))),
      { ...fsPolicy(2, and(authenticated, inOrgs, { op: 'isNull', operand: 'incoming.note' })), ops: ['update'] },
    ))!
    const allow = (op: string) => f.cases.find(c => c.do.op === op && c.expect === 'allow')!
    expect(allow('create').do.data).toEqual({ orgId: 'value-1', status: 'active' })
    expect(allow('update').do.data).toEqual({ orgId: 'value-1', note: null })
    expect(f.cases.map(c => c.name)).toEqual([
      'create: allowed when every condition holds',
      `create: denied without ${formatAtom(authenticated)}`,
      `create: denied without ${formatAtom(inOrgs)}`,
      'update: allowed when every condition holds',
      `update: denied without ${formatAtom(authenticated)}`,
      `update: denied without ${formatAtom(inOrgs)}`,
    ])
    expect(generateTests(createRule(['create', 'update']), vocab, fsFacts(
      fsPolicy(1, and(authenticated, inOrgs, statusIn(['active']))),
      { ...fsPolicy(2, and(authenticated, inOrgs, { op: 'isNull', operand: 'incoming.note' })), ops: ['update'] },
    ))).toEqual(f)
  })

  it('skips an op whose only usable policy cannot be tested on it, instead of an allow case the store refuses', () => {
    // A read policy that reads the incoming write is never true on read: the rule atoms alone would expect allow.
    const owner: Atom = { op: 'eq', left: 'resource.ownerId', right: 'actor.uid' }
    const r = rule({ type: 'data-access', target: { store: 'firestore', path: projects }, ops: ['read'], requires: and(authenticated, owner) })
    const f = generateTests(r, vocab, fsFacts(fsPolicy(1, and(authenticated, owner, statusIn(['a'])), ['read'])))!
    expect(f.cases).toEqual([])
    expect(f.skipped).toEqual(['read: the condition reads the incoming write, which read does not send'])
  })

  it('uses the next candidate when the first would skip list', () => {
    const member: Atom = { op: 'exists', doc: '/members/{actor.uid}' }
    const tier: Atom = { op: 'eq', left: 'actor.claim.tier', right: { literal: 'pro' } }
    const deleted: Atom = { op: 'isNull', operand: 'resource.deletedAt' }
    const r = rule({ type: 'data-access', target: { store: 'firestore', path: projects }, ops: ['read', 'list'], requires: and(member) })
    // With only that policy, list cannot be tested: the store would refuse an unfiltered list.
    const onlyDeleted = generateTests(r, vocab, fsFacts(fsPolicy(1, and(member, deleted), ['read', 'list'])))!
    expect(onlyDeleted.cases.filter(c => c.do.op === 'list')).toEqual([])
    expect(onlyDeleted.skipped).toEqual(['list: needs query filters to test; read cases cover the condition'])
    expect(onlyDeleted.cases[0]!.seed[0]).toEqual({ path: '/projects/projectId-1', data: { deletedAt: null } })
    const f = generateTests(r, vocab, fsFacts(fsPolicy(1, and(member, deleted), ['read', 'list']), fsPolicy(2, and(member, tier), ['list'])))!
    const list = f.cases.filter(c => c.do.op === 'list')
    expect(list.map(c => c.name)).toEqual(['list: allowed when every condition holds', `list: denied without ${formatAtom(member)}`])
    for (const c of list) expect(c.as).toEqual({ uid: 'user-1', claims: { tier: 'pro' } })
  })

  it('treats another form of a rule atom as the rule atom', () => {
    const owner: Atom = { op: 'eq', left: 'resource.ownerId', right: 'actor.uid' }
    const r = rule({ type: 'data-access', target: { store: 'firestore', path: projects }, ops: ['read'], requires: and(owner) })
    const f = generateTests(r, vocab, fsFacts(fsPolicy(1, and({ op: 'eq', left: 'actor.uid', right: 'resource.ownerId' }), ['read'])))!
    expect(f).toEqual(generateTests(r, vocab))
    expect(f.cases.map(c => c.name)).toContain('read: denied without resource.ownerId == actor.uid')
  })
})

describe('generateTests aligns policy path params to the rule target', () => {
  const target = '/orgs/{org}/projects/{id}'
  const member = (param: string): Atom => ({ op: 'exists', doc: `/orgs/{param.${param}}/members/{actor.uid}` })
  const policyOn = (path: string, condition: Expr) => parseFacts({ version: 1, policies: [
    { id: `firestore:${path}#read@1`, store: 'firestore', target: path, ops: ['read'], condition },
  ] })

  it('renames the policy params before satisfying it', () => {
    const r = rule({ type: 'data-access', target: { store: 'firestore', path: target }, ops: ['read'], requires: and(authenticated) })
    const f = generateTests(r, vocab, policyOn('/orgs/{orgId}/projects/{projectId}', and(authenticated, member('orgId'))))!
    expect(f.cases[0]!.do.path).toBe('/orgs/org-1/projects/id-1')
    expect(f.cases[0]!.seed).toEqual([
      { path: '/orgs/org-1/projects/id-1', data: {} },
      { path: '/orgs/org-1/members/user-1', data: {} },
    ])
    expect(f.cases.map(c => c.name)).toEqual(['read: allowed when every condition holds', `read: denied without ${formatAtom(authenticated)}`])
  })

  it('passes over a policy that reads a path param the rule target does not have', () => {
    const r = rule({ type: 'data-access', target: { store: 'firestore', path: '/orgs/acme/projects/{id}' }, ops: ['read'], requires: and(authenticated) })
    expect(generateTests(r, vocab, policyOn('/orgs/{orgId}/projects/{projectId}', and(authenticated, member('orgId')))))
      .toEqual(generateTests(r, vocab))
  })
})

describe('generateTests on postgres with facts', () => {
  const member: Atom = { op: 'exists', doc: 'pg:public.memberships?org_id={resource.org_id}&user_id={actor.uid}' }
  const readRule = rule({ type: 'data-access', target: { store: 'postgres', table: 'projects' }, ops: ['read'], requires: and(authenticated, member) })
  const pgFacts = (condition: Expr) => parseFacts({ version: 1, policies: [
    { id: 'pg:public.projects#select', store: 'pg-rls', target: 'public.projects', ops: ['read', 'list'], condition },
  ] })

  it('seeds the row the select policy needs', () => {
    const f = generateTests(readRule, vocab, pgFacts(and(authenticated, member, { op: 'isNull', operand: 'resource.deleted_at' })))!
    expect(f.cases[0]!.seed).toEqual([
      { path: 'public.projects', data: { org_id: 'value-1', deleted_at: null } },
      { path: 'public.memberships', data: { org_id: 'value-1', user_id: 'user-1' } },
    ])
    expect(f.cases.map(c => c.name)).toEqual([
      'read: allowed when every condition holds',
      `read: denied without ${formatAtom(authenticated)}`,
      `read: denied without ${formatAtom(member)}`,
    ])
    for (const c of f.cases) expect(c.seed[0]!.data).toMatchObject({ deleted_at: null })
  })

  it('skips list when the select policy reads the row, though the rule does not', () => {
    const admin: Atom = { op: 'eq', left: 'actor.claim.user_role', right: { literal: 'admin' } }
    const r = rule({ type: 'data-access', target: { store: 'postgres', table: 'projects' }, ops: ['read', 'list'], requires: and(admin) })
    const f = generateTests(r, vocab, pgFacts(and(authenticated, admin, member)))!
    expect(f.cases.map(c => c.name)).toEqual(['read: allowed when every condition holds', `read: denied without ${formatAtom(admin)}`])
    expect(f.cases[0]!.seed).toContainEqual({ path: 'public.memberships', data: { org_id: 'value-1', user_id: 'user-1' } })
    expect(f.skipped).toEqual(['list: needs query filters to test; read cases cover the condition'])
  })
})

describe('generateTests with facts that add nothing', () => {
  const pgRule = rule({ type: 'data-access', target: { store: 'postgres', table: 'dogs' }, ops: ['read', 'update'],
    requires: and(
      { op: 'eq', left: 'actor.claim.team_id', right: 'resource.team_id' },
      { op: 'exists', doc: 'pg:public.members?team_id={resource.team_id}&user_id={actor.uid}' },
    ) })
  const fsRule = rule({ type: 'data-access', target: { store: 'firestore', path: '/accounts/{accountId}/dogs/{dogId}' }, ops: ['read', 'list'],
    requires: and({ op: 'exists', doc: '/accounts/{param.accountId}/members/{actor.uid}' }, { op: 'isNull', operand: 'resource.deletedAt' }) })

  // A policy with exactly the rule's condition, on the rule's own target and ops.
  const samePolicy = (r: typeof pgRule) => {
    if (r.type !== 'data-access') throw new Error('data-access only')
    const pg = r.target.store === 'postgres'
    return parseFacts({ version: 1, policies: [{
      id: 'p', store: pg ? 'pg-rls' : 'firestore', target: r.target.store === 'postgres' ? r.target.table : r.target.path, ops: r.ops, condition: r.requires,
    }] })
  }

  it('gives the same file as without facts', () => {
    for (const r of [pgRule, fsRule, createRule()]) {
      const today = generateTests(r, vocab)
      expect(generateTests(r, vocab, parseFacts({ version: 1 }))).toEqual(today)
      expect(generateTests(r, vocab, samePolicy(r))).toEqual(today)
    }
  })
})
