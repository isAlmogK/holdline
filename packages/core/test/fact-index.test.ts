import { describe, expect, it } from 'vitest'
import { FactIndex } from '../src/fact-index.js'
import { parseFacts } from '../src/facts.js'

const facts = parseFacts({
  version: 1,
  symbols: [
    { id: 'ts:src/routes#transfer', kind: 'function', lang: 'ts', location: { file: 'src/routes.ts', line: 10 } },
    { id: 'ts:src/repo#DogRepo.update', kind: 'method', lang: 'ts', location: { file: 'src/repo.ts', line: 5 } },
  ],
  routes: [
    { id: 'route:POST /dogs/:id/transfer', method: 'POST', path: '/dogs/:id/transfer', handler: 'ts:src/routes#transfer', middleware: ['ts:src/mw#auth'], framework: 'express' },
    { id: 'route:GET /dogs', method: 'GET', path: '/dogs', handler: 'ts:src/routes#list', framework: 'express' },
  ],
  guards: [
    { at: 'ts:src/mw#auth', requires: { atom: { op: 'authenticated' } } },
    { at: 'route:POST /dogs/:id/transfer', requires: { atom: { op: 'in', left: 'actor.role', right: { literal: ['admin'] } } } },
  ],
  dataOps: [
    { in: 'ts:src/repo#DogRepo.update', store: 'postgres', target: 'dogs', op: 'update' },
    { in: 'ts:src/script#fix', store: 'postgres', target: 'public.dogs', op: 'update' },
    { in: 'ts:src/client#load', store: 'firestore', target: '/accounts/{a}/dogs/{d}', op: 'read' },
  ],
  calls: [
    ['ts:src/routes#transfer', 'ts:src/service#Transfer.run'],
    ['ts:src/service#Transfer.run', 'ts:src/repo#DogRepo.update'],
    ['ts:src/other#handler', 'ts:src/repo#DogRepo.update'],
  ],
  tables: [{ id: 'pg:public.dogs', name: 'public.dogs', columns: [], location: { file: 'm.sql', line: 1 } }],
  policies: [
    { id: 'firestore:/{document=**}#read', store: 'firestore', target: '/{document=**}', ops: ['read'], condition: { or: [] } },
    { id: 'firestore:/accounts/{acct}/dogs/{id}#rw', store: 'firestore', target: '/accounts/{acct}/dogs/{id}', ops: ['read', 'update'], condition: { atom: { op: 'authenticated' } } },
  ],
  diagnostics: [{ analyzer: 'ts', file: 'src/broken.ts', message: 'x', severity: 'error' }],
})
const index = new FactIndex(facts)
const dogs = { store: 'postgres', table: 'dogs' } as const
const fsDogs = { store: 'firestore', path: '/accounts/{accountId}/dogs/{dogId}' } as const

describe('FactIndex', () => {
  it('finds ids and locations', () => {
    expect(index.hasId('route:GET /dogs')).toBe(true)
    expect(index.hasId('pg:public.dogs')).toBe(true)
    expect(index.hasId('nope')).toBe(false)
    expect(index.at('ts:src/routes#transfer')).toEqual({ symbol: 'ts:src/routes#transfer', file: 'src/routes.ts', line: 10 })
    expect(index.at('pg:public.dogs')).toEqual({ symbol: 'pg:public.dogs', file: 'm.sql', line: 1 })
    expect(index.at('unknown')).toEqual({ symbol: 'unknown' })
  })
  it('builds guard chains from the route, its middleware and its handler', () => {
    const [route] = index.routesMatching('POST /dogs/*/transfer')
    expect(index.guardChain(route!).map(g => g.at)).toEqual(['route:POST /dogs/:id/transfer', 'ts:src/mw#auth'])
  })
  it('finds data ops by target with schema normalization and path overlap', () => {
    expect(index.dataOps(dogs).length).toBe(2)
    expect(index.dataOps(dogs, ['read']).length).toBe(0)
    expect(index.dataOps(fsDogs).map(o => o.in)).toEqual(['ts:src/client#load'])
  })
  it('finds policies covering a target and op', () => {
    expect(index.policies(fsDogs, 'read').map(p => p.id)).toEqual(['firestore:/{document=**}#read', 'firestore:/accounts/{acct}/dogs/{id}#rw'])
    expect(index.policies(fsDogs, 'delete')).toEqual([])
  })
  it('knows whether a target exists', () => {
    expect(index.targetExists(dogs)).toBe(true)
    expect(index.targetExists({ store: 'postgres', table: 'cats' })).toBe(false)
    expect(index.targetExists(fsDogs)).toBe(true)
  })
  it('coveredBy requires every call path to pass through via', () => {
    expect(index.coveredBy('ts:src/repo#DogRepo.update', ['ts:src/repo#DogRepo'])).toBe(true)
    expect(index.coveredBy('ts:src/repo#DogRepo.update', ['ts:src/service#Transfer.run'])).toBe(false)
    expect(index.coveredBy('ts:src/script#fix', ['ts:src/service#Transfer.run'])).toBe(false)
  })
  it('lists files with error diagnostics', () => {
    expect([...index.errorFiles()]).toEqual(['src/broken.ts'])
  })
  it('reports a route without its own location at its handler location', () => {
    expect(index.at('route:POST /dogs/:id/transfer')).toEqual({ symbol: 'route:POST /dogs/:id/transfer', file: 'src/routes.ts', line: 10 })
  })
})

describe('FactIndex.coveredBy traversal', () => {
  const edges = (calls: [string, string][]) => new FactIndex(parseFacts({ version: 1, calls }))

  it('walks several hops up to a covered entry point', () => {
    const idx = edges([
      ['route.handler', 'svc.run'],
      ['svc.run', 'repo.update'],
    ])
    expect(idx.coveredBy('repo.update', ['route.handler'])).toBe(true)
    expect(idx.coveredBy('repo.update', ['unrelated'])).toBe(false)
  })
  it('is false when one path into the symbol is covered and another is not', () => {
    const idx = edges([
      ['covered', 'x'],
      ['uncovered', 'x'],
    ])
    expect(idx.coveredBy('x', ['covered'])).toBe(false)
  })
  it('handles cycles: covered when a via node reaches the cycle, not when it is a pure cycle', () => {
    const withRoot = edges([
      ['A', 'B'],
      ['B', 'A'],
      ['root', 'B'],
    ])
    expect(withRoot.coveredBy('A', ['root'])).toBe(true)
    const pure = edges([
      ['A', 'B'],
      ['B', 'A'],
    ])
    expect(pure.coveredBy('A', [])).toBe(false)
  })
  it('finishes quickly on a 25-layer diamond graph (no exponential blowup)', () => {
    const layers = 25
    const calls: [string, string][] = []
    for (let i = 0; i < layers - 1; i++) {
      for (const a of ['a', 'b']) {
        for (const b of ['a', 'b']) calls.push([`L${i}${a}`, `L${i + 1}${b}`])
      }
    }
    const idx = edges(calls)
    const bottom = `L${layers - 1}a`
    expect(idx.coveredBy(bottom, ['L0a', 'L0b'])).toBe(true)
  })
})
