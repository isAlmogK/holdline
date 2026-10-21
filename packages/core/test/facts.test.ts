import { describe, expect, it } from 'vitest'
import { FactsError, emptyFacts, mergeFacts, parseFacts } from '../src/facts.js'

describe('parseFacts', () => {
  it('fills defaults for missing arrays', () => {
    const f = parseFacts({ version: 1 })
    expect(f).toEqual(emptyFacts())
  })
  it('parses a full fact graph', () => {
    const f = parseFacts({
      version: 1,
      analyzers: [{ name: 'test', version: '0' }],
      symbols: [{ id: 'ts:src/a#f', kind: 'function', lang: 'ts', location: { file: 'src/a.ts', line: 3 } }],
      routes: [{ id: 'route:GET /a', method: 'GET', path: '/a', handler: 'ts:src/a#f', framework: 'express' }],
      guards: [{ at: 'route:GET /a', requires: { atom: { op: 'authenticated' } } }],
      dataOps: [{ in: 'ts:src/a#f', store: 'postgres', target: 'public.a', op: 'read' }],
      calls: [['ts:src/a#f', 'ts:src/b#g']],
      tables: [{ id: 'pg:public.a', name: 'public.a', columns: [{ name: 'id', type: 'uuid', nullable: false }] }],
      collections: [{ path: '/a/{id}', source: 'inferred' }],
      policies: [{ id: 'firestore:/a/{id}#read', store: 'firestore', target: '/a/{id}', ops: ['read'], condition: { or: [] } }],
      diagnostics: [{ analyzer: 'test', file: 'src/c.ts', message: 'parse error', severity: 'error' }],
    })
    expect(f.routes[0]!.middleware).toEqual([])
    expect(f.routes[0]!.kind).toBe('http')
    expect(f.tables[0]!.rlsEnabled).toBe(false)
  })
  it('throws FactsError with the source and the problem', () => {
    expect(() => parseFacts({ version: 2 }, 'facts.json')).toThrow(FactsError)
    expect(() => parseFacts({ version: 1, dataOps: [{ in: 'x', store: 'mongo', target: 't', op: 'read' }] }, 'facts.json'))
      .toThrow(/facts\.json/)
  })
})

describe('mergeFacts', () => {
  it('concatenates every list', () => {
    const a = parseFacts({ version: 1, analyzers: [{ name: 'a', version: '1' }], calls: [['x', 'y']] })
    const b = parseFacts({ version: 1, analyzers: [{ name: 'b', version: '1' }], calls: [['y', 'z']] })
    const m = mergeFacts([a, b])
    expect(m.analyzers.map(x => x.name)).toEqual(['a', 'b'])
    expect(m.calls).toEqual([['x', 'y'], ['y', 'z']])
  })
})

describe('FactsError', () => {
  it('names itself', () => {
    expect(new FactsError('x').name).toBe('FactsError')
  })
})
