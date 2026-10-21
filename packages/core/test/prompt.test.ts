import { describe, expect, it } from 'vitest'
import { parseFacts } from '../src/facts.js'
import { buildInferPrompt, condenseFacts, proposalJsonSchema } from '../src/prompt.js'
import { emptyRulesFile } from '../src/rules.js'

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
  })
})

describe('buildInferPrompt', () => {
  it('includes instructions, the schema and the facts', () => {
    const prompt = buildInferPrompt(facts, emptyRulesFile())
    expect(prompt).toContain('Return only JSON')
    expect(prompt).toContain('"vocabulary"')
    expect(prompt).toContain('POST /dogs/:id/transfer')
  })
  it('truncates to the budget and says how to narrow', () => {
    const prompt = buildInferPrompt(facts, emptyRulesFile(), { budgetTokens: 900 })
    expect(prompt).toMatch(/more not shown; use --area/)
  })
  it('exports a JSON schema', () => {
    expect(JSON.stringify(proposalJsonSchema())).toContain('"rules"')
  })
})
