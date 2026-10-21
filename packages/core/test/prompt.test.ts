import { describe, expect, it } from 'vitest'
import { emptyFacts, parseFacts, type Facts } from '../src/facts.js'
import { buildInferPrompt, condenseFacts, proposalJsonSchema } from '../src/prompt.js'
import { emptyRulesFile, type RulesFile } from '../src/rules.js'

const facts = parseFacts({
  version: 1,
  symbols: [
    { id: 'ts:src/dogs#transfer', kind: 'function', lang: 'ts', location: { file: 'src/dogs.ts', line: 4 } },
    { id: 'ts:lib/x#y', kind: 'function', lang: 'ts', location: { file: 'lib/x.ts', line: 1 } },
  ],
  routes: [{ id: 'route:POST /dogs/:id/transfer', method: 'POST', path: '/dogs/:id/transfer', handler: 'ts:src/dogs#transfer', middleware: ['ts:src/mw#auth'], framework: 'express' }],
  guards: [{ at: 'route:POST /dogs/:id/transfer', requires: { atom: { op: 'in', left: 'actor.role', right: { literal: ['admin'] } } } }],
  dataOps: [{ in: 'ts:src/dogs#transfer', store: 'postgres', target: 'public.dogs', op: 'update', evidence: { file: 'src/dogs.ts', line: 9 } }],
  tables: [{ id: 'pg:public.dogs', name: 'public.dogs', columns: [{ name: 'team_id', type: 'uuid', nullable: false }], foreignKeys: [{ columns: ['team_id'], references: { table: 'public.teams', columns: ['id'] } }] }],
  policies: [{ id: 'firestore:/dogs/{d}#read', store: 'firestore', target: '/dogs/{d}', ops: ['read'], condition: { atom: { op: 'authenticated' } } }],
})

const manyRoutes = (n: number): Facts => parseFacts({
  version: 1,
  routes: Array.from({ length: n }, (_, i) => ({
    id: `route:GET /r${i}`, method: 'GET', path: `/r${i}`, handler: `ts:src/r${i}#h`, middleware: [], framework: 'express',
  })),
})

const headerLength = (): number => buildInferPrompt(emptyFacts(), emptyRulesFile()).length

describe('condenseFacts', () => {
  it('summarizes routes, data access, tables and policies', () => {
    const text = condenseFacts(facts).map(s => `${s.title}\n${s.lines.join('\n')}`).join('\n')
    expect(text).toContain('POST /dogs/:id/transfer → ts:src/dogs#transfer; middleware ts:src/mw#auth; checks actor.role in ["admin"]')
    expect(text).toContain('public.dogs: update in ts:src/dogs#transfer')
    expect(text).toContain('team_id uuid not null → public.teams(id)')
    expect(text).toContain('firestore /dogs/{d}: read if authenticated')
  })
  it('filters by area', () => {
    const lines = condenseFacts(facts, { area: 'lib/' }).flatMap(s => s.lines)
    expect(lines.some(l => l.includes('transfer'))).toBe(false)
    expect(lines).toContain('ts:lib/x#y')
  })
  it('keeps the files under a matching area', () => {
    const lines = condenseFacts(facts, { area: 'src/' }).flatMap(s => s.lines)
    expect(lines).toContain('POST /dogs/:id/transfer → ts:src/dogs#transfer; middleware ts:src/mw#auth; checks actor.role in ["admin"]')
  })
  it('matches area on path segments, not raw string prefixes', () => {
    const lines = condenseFacts(facts, { area: 'sr' }).flatMap(s => s.lines)
    expect(lines.some(l => l.includes('transfer'))).toBe(false)
  })
  it('renders a route with no guards as "no checks found"', () => {
    const open = parseFacts({
      version: 1,
      routes: [{ id: 'route:GET /open', method: 'GET', path: '/open', handler: 'ts:src/open#h', middleware: [], framework: 'express' }],
    })
    expect(condenseFacts(open).flatMap(s => s.lines)).toContain('GET /open → ts:src/open#h; no checks found')
  })
  it('renders data-op filters', () => {
    const filtered = parseFacts({
      version: 1,
      dataOps: [{
        in: 'ts:src/teams#list', store: 'postgres', target: 'public.teams', op: 'read',
        filters: { atom: { op: 'eq', left: 'resource.team_id', right: 'actor.claim.team' } },
      }],
    })
    expect(condenseFacts(filtered).flatMap(s => s.lines)).toContain(
      'public.teams: read in ts:src/teams#list (filters: resource.team_id == actor.claim.team)')
  })
})

describe('buildInferPrompt', () => {
  it('includes instructions, the schema and the facts', () => {
    const prompt = buildInferPrompt(facts, emptyRulesFile())
    expect(prompt).toContain('Return only JSON')
    expect(prompt).toContain('"vocabulary"')
    expect(prompt).toContain('POST /dogs/:id/transfer')
  })
  it('lists existing rules and vocabulary so they are not repeated', () => {
    const file: RulesFile = {
      version: 1,
      vocabulary: [{ id: 'is-admin', text: 'actor is an admin', expr: { atom: { op: 'eq', left: 'actor.role', right: { literal: 'admin' } } }, recognize: [] }],
      rules: [{ id: 'R-001', type: 'access', text: 'Only admins transfer dogs', target: { routes: 'POST /dogs/:id/transfer' }, requires: { ref: 'is-admin' }, evidence: [], status: 'pending' }],
    }
    const prompt = buildInferPrompt(facts, file)
    expect(prompt).toContain('## Existing rules (do not repeat)\n- R-001 (access): Only admins transfer dogs')
    expect(prompt).toContain('## Existing vocabulary (reuse these ids)\n- is-admin: actor is an admin = actor.role == "admin"')
  })
  it('truncates to the budget, reports exactly how many were not shown, and keeps the first lines', () => {
    const big = manyRoutes(50)
    const budgetTokens = Math.ceil((headerLength() + 300) / 4)
    const prompt = buildInferPrompt(big, emptyRulesFile(), { budgetTokens })
    const shown = prompt.match(/^GET \/r\d+ → /gm) ?? []
    expect(prompt).toContain('GET /r0 → ts:src/r0#h; no checks found')
    expect(shown.length).toBeGreaterThan(0)
    expect(shown.length).toBeLessThan(50)
    expect(prompt).toContain(`… ${50 - shown.length} more not shown; use --area <path> to narrow`)
    expect(prompt).not.toContain('GET /r49 →')
    expect(prompt.length).toBeLessThanOrEqual(budgetTokens * 4)
  })
  it('never exceeds the budget, whatever its size', () => {
    const big = manyRoutes(50)
    const start = headerLength() + 200
    for (let chars = start; chars < start + 400; chars += 7) {
      const budgetTokens = Math.ceil(chars / 4)
      const prompt = buildInferPrompt(big, emptyRulesFile(), { budgetTokens })
      expect(prompt.length).toBeLessThanOrEqual(budgetTokens * 4)
    }
  })
  it('throws when the budget cannot hold the instructions and schema', () => {
    expect(() => buildInferPrompt(facts, emptyRulesFile(), { budgetTokens: 10 })).toThrow(/raise --budget/)
    expect(() => buildInferPrompt(facts, emptyRulesFile(), { budgetTokens: 10 })).toThrow(/budget \(10 tokens\) is too small/)
  })
  it('exports a JSON schema', () => {
    expect(JSON.stringify(proposalJsonSchema())).toContain('"rules"')
  })
})
