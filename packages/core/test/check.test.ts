import { describe, expect, it } from 'vitest'
import { runChecks } from '../src/check/run.js'
import { parseFacts } from '../src/facts.js'
import { hashRule } from '../src/hash.js'
import { RuleSchema, type RulesFile } from '../src/rules.js'
import { summarize } from '../src/results.js'

const approvedRule = (raw: Record<string, unknown>) => {
  const rule = RuleSchema.parse({ status: 'approved', ...raw })
  return { ...rule, approved: { by: 't', at: '2026-10-21', hash: hashRule(rule, new Map()) } }
}
const file = (rules: Record<string, unknown>[], vocabulary: RulesFile['vocabulary'] = []): RulesFile =>
  ({ version: 1, vocabulary, rules: rules.map(approvedRule) })
const run = (facts: Record<string, unknown>, f: RulesFile) => runChecks(parseFacts({ version: 1, ...facts }), f).results

const admin = { atom: { op: 'in', left: 'actor.role', right: { literal: ['admin'] } } }
const auth = { atom: { op: 'authenticated' } }
const member = { atom: { op: 'exists', doc: '/accounts/{param.accountId}/members/{actor.uid}' } }
const notDeleted = { atom: { op: 'isNull', operand: 'resource.deleted_at' } }

describe('access', () => {
  const facts = {
    routes: [
      { id: 'route:POST /dogs/:id/transfer', method: 'POST', path: '/dogs/:id/transfer', handler: 'h:transfer', middleware: ['mw:auth'], framework: 'express' },
      { id: 'route:POST /dogs/:id/archive', method: 'POST', path: '/dogs/:id/archive', handler: 'h:archive', middleware: ['mw:auth'], framework: 'express' },
    ],
    guards: [
      { at: 'mw:auth', requires: auth },
      { at: 'route:POST /dogs/:id/transfer', requires: admin },
    ],
    symbols: [{ id: 'h:archive', kind: 'function' as const, lang: 'ts' as const, location: { file: 'src/dogs.ts', line: 30 } }],
  }
  it('passes when every matching route checks the requirement', () => {
    const r = run(facts, file([{ id: 'R-001', text: 'Only admins transfer', type: 'access', target: { routes: 'POST /dogs/*/transfer' }, requires: admin }]))
    expect(r).toEqual([{ rule: 'R-001', status: 'pass', target: 'routes POST /dogs/*/transfer', message: 'Only admins transfer' }])
  })
  it('reports each route that does not', () => {
    const r = run(facts, file([{ id: 'R-001', text: 'Only admins change dogs', type: 'access', target: { routes: 'POST /dogs/**' }, requires: admin }]))
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({
      status: 'violation',
      message: 'POST /dogs/:id/archive does not check actor.role in ["admin"]',
      at: { symbol: 'h:archive', file: 'src/dogs.ts', line: 30 },
      unproven: admin,
    })
  })
  it('is stale when no route matches', () => {
    const r = run(facts, file([{ id: 'R-001', text: 't', type: 'access', target: { routes: 'GET /cats' }, requires: auth }]))
    expect(r[0]!.status).toBe('stale')
  })
  it('checks guards on a symbol target', () => {
    const r = run({ ...facts, guards: [...facts.guards, { at: 'fn:onCall', requires: auth }], symbols: [{ id: 'fn:onCall', kind: 'function', lang: 'ts' }] },
      file([{ id: 'R-001', text: 't', type: 'access', target: { symbol: 'fn:onCall' }, requires: admin }]))
    expect(r[0]!.status).toBe('violation')
  })
})

describe('data-access', () => {
  const target = { store: 'firestore', path: '/accounts/{accountId}/dogs/{dogId}' }
  const rule = { id: 'R-001', text: 'Members read dogs', type: 'data-access', target, ops: ['read', 'update'], requires: member }
  it('passes when every covering policy implies the requirement, after renaming params', () => {
    const r = run({ policies: [
      { id: 'p1', store: 'firestore', target: '/accounts/{acct}/dogs/{id}', ops: ['read', 'update'], condition: { atom: { op: 'exists', doc: '/accounts/{param.acct}/members/{actor.uid}' } } },
    ] }, file([rule]))
    expect(r.map(x => x.status)).toEqual(['pass'])
  })
  it('flags a loosened policy and points at it', () => {
    const r = run({ policies: [
      { id: 'p1', store: 'firestore', target: '/accounts/{acct}/dogs/{id}', ops: ['read', 'update'], condition: { atom: { op: 'exists', doc: '/accounts/{param.acct}/members/{actor.uid}' } } },
      { id: 'p2', store: 'firestore', target: '/{document=**}', ops: ['read'], condition: auth, evidence: { file: 'firestore.rules', line: 4 } },
    ] }, file([rule]))
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ status: 'violation', at: { symbol: 'p2', file: 'firestore.rules', line: 4 } })
    expect(r[0]!.message).toContain('read on firestore:/accounts/{accountId}/dogs/{dogId}')
  })
  it('gives policy params that do not align with the target fresh names, so they cannot collide', () => {
    // {accountId=**} is the policy's own rest param: it is not the rule's accountId.
    const r = run({ policies: [
      { id: 'p1', store: 'firestore', target: '/accounts/{acct}/dogs/{dogId}/{accountId=**}', ops: ['read', 'update'], condition: member },
    ] }, file([rule]))
    expect(r.map(x => x.status)).toEqual(['violation', 'violation'])
    expect(r[0]!.at?.symbol).toBe('p1')
  })
  it('requires RLS to be enabled on postgres tables', () => {
    const pgRule = { ...rule, target: { store: 'postgres', table: 'dogs' }, requires: { atom: { op: 'eq', left: 'actor.uid', right: 'resource.owner_id' } } }
    const table = { id: 'pg:public.dogs', name: 'public.dogs', columns: [] }
    expect(run({ tables: [table] }, file([pgRule]))[0]!.message).toMatch(/Row level security is not enabled/)
    expect(run({ tables: [{ ...table, rlsEnabled: true }] }, file([pgRule])).map(x => x.status)).toEqual(['pass'])
  })
})

describe('visibility and flow', () => {
  const dogs = { store: 'postgres', table: 'dogs' }
  const facts = {
    tables: [{ id: 'pg:public.dogs', name: 'public.dogs', columns: [] }],
    dataOps: [
      { in: 'repo:Dogs.list', store: 'postgres', target: 'public.dogs', op: 'list', filters: { and: [notDeleted] } },
      { in: 'repo:Dogs.get', store: 'postgres', target: 'public.dogs', op: 'read' },
      { in: 'repo:Dogs.update', store: 'postgres', target: 'public.dogs', op: 'update' },
      { in: 'script:fix', store: 'postgres', target: 'public.dogs', op: 'update', evidence: { file: 'scripts/fix.ts', line: 3 } },
    ],
    calls: [['svc:Transfer.run', 'repo:Dogs.update']] as [string, string][],
  }
  it('visibility flags reads without the filter unless they go through via', () => {
    const r = run(facts, file([{ id: 'R-001', text: 'No deleted dogs', type: 'visibility', target: dogs, requires: notDeleted }]))
    expect(r.map(x => x.at?.symbol)).toEqual(['repo:Dogs.get'])
    const r2 = run(facts, file([{ id: 'R-001', text: 'No deleted dogs', type: 'visibility', target: dogs, requires: notDeleted, via: ['repo:Dogs.get'] }]))
    expect(r2.map(x => x.status)).toEqual(['pass'])
  })
  it('flow flags writes that bypass via', () => {
    const r = run(facts, file([{ id: 'R-001', text: 'Dog updates go through the transfer service', type: 'flow', target: dogs, ops: ['update'], via: ['svc:Transfer'] }]))
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ status: 'violation', at: { symbol: 'script:fix', file: 'scripts/fix.ts', line: 3 } })
  })
})

describe('invariant', () => {
  const table = {
    id: 'pg:public.dogs', name: 'public.dogs',
    columns: [{ name: 'team_id', type: 'uuid', nullable: false }, { name: 'status', type: 'dog_status', nullable: true }],
    foreignKeys: [{ columns: ['team_id'], references: { table: 'teams', columns: ['id'] } }],
    uniques: [['name', 'team_id']],
    checks: [{ expr: '(weight > 0)' }],
    enums: [{ column: 'status', values: ['active', 'retired'] }],
  }
  const target = { store: 'postgres', table: 'dogs' }
  const inv = (extra: Record<string, unknown>) => ({ id: 'R-001', text: 't', type: 'invariant', target, ...extra })
  it('passes each kind when the schema has the constraint', () => {
    const rules = [
      inv({ id: 'R-001', kind: 'not-null', columns: ['team_id'] }),
      inv({ id: 'R-002', kind: 'fk', columns: ['team_id'], references: { table: 'public.teams', columns: ['id'] } }),
      inv({ id: 'R-003', kind: 'unique', columns: ['team_id', 'name'] }),
      inv({ id: 'R-004', kind: 'check', columns: ['weight'], expr: 'weight > 0' }),
      inv({ id: 'R-005', kind: 'enum', columns: ['status'], values: ['retired', 'active'] }),
    ]
    expect(run({ tables: [table] }, file(rules)).map(r => r.status)).toEqual(['pass', 'pass', 'pass', 'pass', 'pass'])
  })
  it('fails each kind when the constraint is missing', () => {
    const broken = { ...table, columns: [{ name: 'team_id', type: 'uuid', nullable: true }, table.columns[1]!], foreignKeys: [], uniques: [], checks: [], enums: [{ column: 'status', values: ['active'] }] }
    const rules = [
      inv({ id: 'R-001', kind: 'not-null', columns: ['team_id'] }),
      inv({ id: 'R-002', kind: 'fk', columns: ['team_id'], references: { table: 'teams', columns: ['id'] } }),
      inv({ id: 'R-003', kind: 'unique', columns: ['team_id', 'name'] }),
      inv({ id: 'R-004', kind: 'check', columns: ['weight'], expr: 'weight > 0' }),
      inv({ id: 'R-005', kind: 'enum', columns: ['status'], values: ['active', 'retired'] }),
    ]
    expect(run({ tables: [broken] }, file(rules)).map(r => r.status)).toEqual(['violation', 'violation', 'violation', 'violation', 'violation'])
  })
  it('check compares expr only: a check that merely mentions the column does not count', () => {
    const r = run({ tables: [{ ...table, checks: [{ expr: '(weight < 1000)' }] }] }, file([inv({ kind: 'check', columns: ['weight'], expr: 'weight > 0' })]))
    expect(r[0]!.status).toBe('violation')
    const noExpr = run({ tables: [table] }, file([inv({ kind: 'check', columns: ['weight'] })]))
    expect(noExpr[0]!.status).toBe('violation')
  })
  it('ignores repeated outer parentheses in check expressions', () => {
    const r = run({ tables: [{ ...table, checks: [{ expr: '((weight > 0))' }] }] }, file([inv({ kind: 'check', columns: ['weight'], expr: 'weight > 0' })]))
    expect(r[0]!.status).toBe('pass')
  })
  it('firestore not-null requires the write to prove the field is non-null', () => {
    const fsTarget = { store: 'firestore', path: '/dogs/{dogId}' }
    const rule = inv({ kind: 'not-null', columns: ['team_id'], target: fsTarget })
    const ne = { atom: { op: 'ne', left: 'incoming.team_id', right: { literal: null } } }
    const policy = (condition: unknown) => ({ id: 'p', store: 'firestore', target: '/dogs/{d}', ops: ['create'], condition })
    const status = (condition: unknown) => run({ policies: [policy(condition)] }, file([rule]))[0]!.status
    expect(status({ atom: { op: 'isNull', operand: 'incoming.team_id' } })).toBe('violation')
    expect(status({ or: [auth, ne] })).toBe('violation')
    expect(status({ not: ne })).toBe('violation')
    expect(status(ne)).toBe('pass')
  })
  it('firestore enum requires the write to restrict the field to the values', () => {
    const fsTarget = { store: 'firestore', path: '/dogs/{dogId}' }
    const rule = inv({ kind: 'enum', columns: ['c'], values: ['x'], target: fsTarget })
    const inn = (v: string[]) => ({ atom: { op: 'in', left: 'incoming.c', right: { literal: v } } })
    const status = (condition: unknown) => run({ policies: [{ id: 'p', store: 'firestore', target: '/dogs/{d}', ops: ['update'], condition }] }, file([rule]))[0]!.status
    expect(status(inn(['x', 'y']))).toBe('violation')
    expect(status(inn(['x']))).toBe('pass')
  })
  it('firestore invariants require write policies to check the field', () => {
    const fsTarget = { store: 'firestore', path: '/dogs/{dogId}' }
    const ok = { id: 'p', store: 'firestore', target: '/dogs/{d}', ops: ['create', 'update'], condition: { atom: { op: 'ne', left: 'incoming.team_id', right: { literal: null } } } }
    const rule = inv({ kind: 'not-null', columns: ['team_id'], target: fsTarget })
    expect(run({ policies: [ok] }, file([rule]))[0]!.status).toBe('pass')
    expect(run({ policies: [{ ...ok, condition: auth }] }, file([rule]))[0]!.status).toBe('violation')
  })
})

describe('runChecks bookkeeping', () => {
  const facts = { routes: [{ id: 'route:GET /a', method: 'GET', path: '/a', handler: 'h', framework: 'x' }], guards: [{ at: 'h', requires: auth }] }
  const base = { id: 'R-001', text: 'Sign-in for /a', type: 'access', target: { routes: 'GET /a' }, requires: auth }
  it('reports unapproved edits', () => {
    const f = file([base])
    f.rules[0] = { ...f.rules[0]!, text: 'Edited by an agent' }
    expect(runChecks(parseFacts({ version: 1, ...facts }), f).results[0]!.status).toBe('unapproved-edit')
  })
  it('skips pending and muted rules and counts muted', () => {
    const f = file([base])
    f.rules.push(RuleSchema.parse({ ...base, id: 'R-002', status: 'pending' }))
    f.rules.push({ ...approvedRule({ ...base, id: 'R-003' }), status: 'muted', muted: { by: 'almog', at: '2026-10-22', reason: 'migrating' } })
    const out = runChecks(parseFacts({ version: 1, ...facts }), f)
    expect(out.results.map(r => r.rule)).toEqual(['R-001'])
    expect(out.muted).toBe(1)
    expect(out.mutedRules).toEqual([{ id: 'R-003', text: 'Sign-in for /a', by: 'almog', at: '2026-10-22', reason: 'migrating' }])
    expect(summarize(out.results, out.muted)).toMatchObject({ pass: 1, violation: 0, muted: 1, rules: 1 })
  })
  it('turns a violation into unknown when evidence sits in a file an analyzer could not read', () => {
    const f = file([{ ...base, requires: admin, evidence: ['h'] }])
    const out = runChecks(parseFacts({ version: 1, ...facts,
      symbols: [{ id: 'h', kind: 'function', lang: 'ts', location: { file: 'src/a.ts', line: 1 } }],
      diagnostics: [{ analyzer: 'ts', file: 'src/a.ts', message: 'parse error', severity: 'error' }] }), f)
    expect(out.results[0]!.status).toBe('unknown')
  })
})

describe('unreadable dependencies', () => {
  const rule = { id: 'R-001', text: 'Members read dogs', type: 'data-access', target: { store: 'firestore', path: '/dogs/{dogId}' }, ops: ['read'], requires: auth }
  const policy = { id: 'p1', store: 'firestore', target: '/dogs/{d}', ops: ['read'], condition: auth, evidence: { file: 'firestore.rules', line: 2 } }
  const err = (file: string) => ({ analyzer: 'a', file, message: 'parse error', severity: 'error' })
  it('is unknown when a policy file has an error diagnostic', () => {
    expect(run({ policies: [policy], diagnostics: [err('firestore.rules')] }, file([rule]))[0]!.status).toBe('unknown')
  })
  it('is unknown when the rules file failed to parse and emitted no policies', () => {
    const facts = { dataOps: [{ in: 'client:read', store: 'firestore', target: '/dogs/{id}', op: 'read' }], diagnostics: [err('firestore.rules')] }
    expect(run(facts, file([rule]))[0]!.status).toBe('unknown')
  })
  it('is unknown when an analyzer crashed (empty file)', () => {
    expect(run({ policies: [policy], diagnostics: [err('')] }, file([rule]))[0]!.status).toBe('unknown')
  })
  it('stays pass for an error in an unrelated file (symbol target)', () => {
    const access = { id: 'R-001', text: 't', type: 'access', target: { symbol: 'h' }, requires: auth }
    const facts = { guards: [{ at: 'h', requires: auth }], symbols: [{ id: 'h', kind: 'function', lang: 'ts', location: { file: 'src/a.ts', line: 1 } }], diagnostics: [err('src/other.ts')] }
    expect(run(facts, file([access]))[0]!.status).toBe('pass')
  })
  it('is unknown for a symbol target when its own file has an error', () => {
    const access = { id: 'R-001', text: 't', type: 'access', target: { symbol: 'h' }, requires: auth }
    const facts = { guards: [{ at: 'h', requires: auth }], symbols: [{ id: 'h', kind: 'function', lang: 'ts', location: { file: 'src/a.ts', line: 1 } }], diagnostics: [err('src/a.ts')] }
    expect(run(facts, file([access]))[0]).toMatchObject({ status: 'unknown', message: 'src/a.ts could not be read (parse error), so this rule cannot be checked.' })
  })
  it('is unknown for a route selector when any file has an error', () => {
    const routes = [{ id: 'route:GET /a', method: 'GET', path: '/a', handler: 'h', framework: 'x' }]
    const access = { id: 'R-001', text: 't', type: 'access', target: { routes: 'GET /a' }, requires: auth }
    const facts = { routes, guards: [{ at: 'h', requires: auth }], symbols: [{ id: 'h', kind: 'function', lang: 'ts', location: { file: 'src/a.ts', line: 1 } }], diagnostics: [err('src/other.ts'), err('src/third.ts')] }
    expect(run(facts, file([access]))[0]).toMatchObject({
      status: 'unknown',
      message: 'analyzer errors make this result unreliable: src/other.ts: parse error (+1 more)',
    })
  })
  it('names the analyzer when it crashed, for set-quantified rules', () => {
    expect(run({ policies: [policy], diagnostics: [err('')] }, file([rule]))[0]!.message)
      .toBe('analyzer errors make this result unreliable: a: parse error')
  })
  it('flow, visibility and postgres invariant rules are unknown for an error in a .py migration', () => {
    const dogs = { store: 'postgres', table: 'dogs' }
    const facts = {
      tables: [{ id: 'pg:public.dogs', name: 'public.dogs', columns: [{ name: 'team_id', type: 'uuid', nullable: false }], location: { file: 'db/schema.sql', line: 1 } }],
      dataOps: [{ in: 'repo:Dogs.list', store: 'postgres', target: 'public.dogs', op: 'list', filters: notDeleted, evidence: { file: 'src/repo.ts', line: 2 } }],
      symbols: [{ id: 'repo:Dogs.list', kind: 'method', lang: 'ts', location: { file: 'src/repo.ts', line: 2 } }],
      diagnostics: [err('migrations/0002_add_dogs.py')],
    }
    const rules = [
      { id: 'R-001', text: 'flow', type: 'flow', target: dogs, ops: ['update'], via: ['svc:Transfer'] },
      { id: 'R-002', text: 'visibility', type: 'visibility', target: dogs, requires: notDeleted },
      { id: 'R-003', text: 'invariant', type: 'invariant', target: dogs, kind: 'not-null', columns: ['team_id'] },
    ]
    expect(run(facts, file(rules)).map(r => r.status)).toEqual(['unknown', 'unknown', 'unknown'])
  })
})
