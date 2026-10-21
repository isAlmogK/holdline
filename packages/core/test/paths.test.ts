import { describe, expect, it } from 'vitest'
import { alignParams, concretize, normalizeTable, patternsOverlap, routeMatches } from '../src/paths.js'

describe('patternsOverlap', () => {
  it('matches params against anything and literals exactly', () => {
    expect(patternsOverlap('/accounts/{a}/dogs/{d}', '/accounts/{accountId}/dogs/{dogId}')).toBe(true)
    expect(patternsOverlap('/accounts/{a}/dogs/{d}', '/accounts/{a}/teams/{t}')).toBe(false)
    expect(patternsOverlap('/accounts/{a}/dogs/special', '/accounts/{a}/dogs/{d}')).toBe(true)
    expect(patternsOverlap('/accounts/{a}', '/accounts/{a}/dogs/{d}')).toBe(false)
  })
  it('treats {x=**} as zero or more segments', () => {
    expect(patternsOverlap('/{document=**}', '/accounts/{a}/dogs/{d}')).toBe(true)
    expect(patternsOverlap('/accounts/{a}/{rest=**}', '/accounts/{a}')).toBe(true)
    expect(patternsOverlap('/teams/{rest=**}', '/accounts/{a}')).toBe(false)
  })
})

describe('alignParams and concretize', () => {
  it('maps param names by position', () => {
    expect([...alignParams('/accounts/{acct}/dogs/{id}', '/accounts/{accountId}/dogs/{dogId}')])
      .toEqual([['acct', 'accountId'], ['id', 'dogId']])
  })
  it('fills params', () => {
    expect(concretize('/accounts/{accountId}/files/{path=**}', p => `${p}-1`)).toBe('/accounts/accountId-1/files/path-1')
  })
})

describe('routeMatches', () => {
  const route = (method: string, path: string) => ({ id: `route:${method} ${path}`, method, path })
  it('matches method and globbed path', () => {
    expect(routeMatches('POST /dogs/*/transfer', route('POST', '/dogs/:id/transfer'))).toBe(true)
    expect(routeMatches('GET /dogs/*/transfer', route('POST', '/dogs/:id/transfer'))).toBe(false)
    expect(routeMatches('* /dogs/**', route('GET', '/dogs'))).toBe(true)
    expect(routeMatches('* /dogs/**', route('DELETE', '/dogs/{id}'))).toBe(true)
    expect(routeMatches('* /dogs/**', route('GET', '/teams'))).toBe(false)
    expect(routeMatches('POST /dogs', route('POST', '/dogs/:id'))).toBe(false)
  })
  it('matches exact route ids', () => {
    expect(routeMatches('route:GET /teams', route('GET', '/teams'))).toBe(true)
  })
  it('throws on a malformed selector', () => {
    expect(() => routeMatches('dogs', route('GET', '/dogs'))).toThrow(/route selector/)
  })
})

describe('normalizeTable', () => {
  it('defaults the schema to public', () => {
    expect(normalizeTable('dogs')).toBe('public.dogs')
    expect(normalizeTable('audit.events')).toBe('audit.events')
  })
})

describe('malformed brace segments', () => {
  it('treat malformed brace segments as conservative wildcards', () => {
    expect(patternsOverlap('/a/{doc-id}', '/a/x')).toBe(true)
    expect(patternsOverlap('/a/{$x}', '/a/x')).toBe(true)
    expect(patternsOverlap('/a/{x=*}', '/a/x')).toBe(true)
  })
})

describe('overlap safety', () => {
  it('is symmetric for rest params', () => {
    expect(patternsOverlap('/a/b/c', '/a/{r=**}')).toBe(true)
    expect(patternsOverlap('/a/{r=**}', '/a/b/c')).toBe(true)
    expect(patternsOverlap('/a/{r=**}/z', '/a/b')).toBe(true)
  })
  it('overlaps the root path with itself and with a rest pattern', () => {
    expect(patternsOverlap('/', '/')).toBe(true)
    expect(patternsOverlap('/', '/{d=**}')).toBe(true)
    expect(patternsOverlap('/', '/a')).toBe(false)
  })
  it('ignores trailing and double slashes', () => {
    expect(patternsOverlap('/a//b/', '/a/b')).toBe(true)
  })
})

describe('route param normalization', () => {
  const route = (method: string, path: string) => ({ id: `route:${method} ${path}`, method, path })
  it('matches :name selectors against brace and angle route params', () => {
    expect(routeMatches('GET /dogs/:id', route('GET', '/dogs/{id}'))).toBe(true)
    expect(routeMatches('GET /dogs/:id', route('GET', '/dogs/<int:id>'))).toBe(true)
    expect(routeMatches('GET /dogs/:id', route('GET', '/dogs/:id'))).toBe(true)
  })
  it('does not match a :name selector against a literal segment', () => {
    expect(routeMatches('GET /dogs/:id', route('GET', '/dogs/special'))).toBe(false)
  })
  it('normalizes brace params in the selector too', () => {
    expect(routeMatches('GET /dogs/{id}', route('GET', '/dogs/:id'))).toBe(true)
  })
  it('trims the selector before the route: prefix check', () => {
    expect(routeMatches(' route:GET /teams', route('GET', '/teams'))).toBe(true)
  })
})
