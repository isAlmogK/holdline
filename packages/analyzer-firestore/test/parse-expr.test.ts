import { describe, expect, it } from 'vitest'
import { ParseError } from '../src/ast.js'
import { parseExpressionSource as p } from '../src/parse-expr.js'

// Strips positions so tests compare shapes.
function shape(n: unknown): unknown {
  if (Array.isArray(n)) return n.map(shape)
  if (n && typeof n === 'object') {
    const { line, col, start, end, ...rest } = n as Record<string, unknown>
    return Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, shape(v)]))
  }
  return n
}
const s = (src: string) => shape(p(src))

describe('expression parser', () => {
  it('parses literals', () => {
    expect(s(`'a'`)).toEqual({ type: 'string', value: 'a' })
    expect(s('42')).toEqual({ type: 'int', value: 42 })
    expect(s('1.5')).toEqual({ type: 'float', value: 1.5 })
    expect(s('true')).toEqual({ type: 'bool', value: true })
    expect(s('null')).toEqual({ type: 'null' })
    expect(s(`['a', 1]`)).toEqual({ type: 'list', items: [{ type: 'string', value: 'a' }, { type: 'int', value: 1 }] })
    expect(s(`{'k': 1}`)).toEqual({ type: 'map', entries: [{ key: 'k', value: { type: 'int', value: 1 } }] })
  })
  it('parses path literals with interpolation and raw parentheses', () => {
    expect(s('/databases/$(database)/documents/users/$(request.auth.uid)')).toEqual({ type: 'path', segments: [
      [{ kind: 'text', value: 'databases' }],
      [{ kind: 'interp', expr: { type: 'ident', name: 'database' } }],
      [{ kind: 'text', value: 'documents' }],
      [{ kind: 'text', value: 'users' }],
      [{ kind: 'interp', expr: { type: 'member', object: { type: 'member', object: { type: 'ident', name: 'request' }, property: 'auth' }, property: 'uid' } }],
    ] })
    expect(s('/databases/(default)/documents/a')).toMatchObject({ type: 'path', segments: [[{ value: 'databases' }], [{ kind: 'text', value: '(default)' }], [{ value: 'documents' }], [{ value: 'a' }]] })
    expect(s('/a/x$(b)y')).toMatchObject({ segments: [[{ value: 'a' }], [{ kind: 'text', value: 'x' }, { kind: 'interp' }, { kind: 'text', value: 'y' }]] })
  })
  it('a path literal is an argument and ends before ) and ,', () => {
    expect(s('get(/a/$(b)).data')).toMatchObject({ type: 'member', property: 'data', object: { type: 'call', args: [{ type: 'path' }] } })
    expect(s('f(/a/b, 1)')).toMatchObject({ type: 'call', args: [{ type: 'path' }, { type: 'int' }] })
  })
  it('parses identifiers, member access, indexing, calls and method calls', () => {
    expect(s(`a.b['c']`)).toEqual({ type: 'index', object: { type: 'member', object: { type: 'ident', name: 'a' }, property: 'b' }, index: { type: 'string', value: 'c' } })
    expect(s('f(1, x)')).toEqual({ type: 'call', callee: { type: 'ident', name: 'f' }, args: [{ type: 'int', value: 1 }, { type: 'ident', name: 'x' }] })
    expect(s(`m.get('k', 0)`)).toEqual({ type: 'call', callee: { type: 'member', object: { type: 'ident', name: 'm' }, property: 'get' }, args: [{ type: 'string', value: 'k' }, { type: 'int', value: 0 }] })
  })
  it('parses unary operators', () => {
    expect(s('!a')).toEqual({ type: 'unary', op: '!', operand: { type: 'ident', name: 'a' } })
    expect(s('-1')).toEqual({ type: 'unary', op: '-', operand: { type: 'int', value: 1 } })
  })
  it('parses every binary operator with CEL precedence', () => {
    for (const op of ['*', '/', '%', '+', '-', '<', '<=', '>', '>=', '==', '!=', 'in', 'is', '&&', '||']) {
      expect(s(`a ${op} b`)).toMatchObject({ type: 'binary', op })
    }
    expect(s('a || b && c == d + e * f')).toMatchObject({
      op: '||', right: { op: '&&', right: { op: '==', right: { op: '+', right: { op: '*' } } } },
    })
    expect(s('a - b - c')).toMatchObject({ op: '-', left: { op: '-' } })
    expect(s('x is string')).toMatchObject({ op: 'is', right: { type: 'ident', name: 'string' } })
  })
  it('parses the ternary operator with lowest precedence', () => {
    expect(s('a || b ? c : d')).toMatchObject({ type: 'ternary', test: { op: '||' }, then: { name: 'c' }, else: { name: 'd' } })
  })
  it('parenthesized expressions keep their inner shape', () => {
    expect(s('(a || b) && c')).toMatchObject({ op: '&&', left: { op: '||' } })
  })
  it('node source spans cover the whole expression', () => {
    const src = 'a.b == "x"'
    const n = p(src)
    expect(src.slice(n.start, n.end)).toBe(src)
  })
  it('reports errors with line and column', () => {
    expect(() => p('a ==')).toThrow(ParseError)
    expect(() => p('a &&\n  )')).toThrow(expect.objectContaining({ line: 2, col: 3 }))
    expect(() => p('f(a b)')).toThrow(expect.objectContaining({ line: 1, col: 5, message: expect.stringContaining("expected ')'") }))
  })
  it('keeps hyphens inside path segments and treats spaced / as division', () => {
    expect(s('/a/b-c')).toEqual({ type: 'path', segments: [[{ kind: 'text', value: 'a' }], [{ kind: 'text', value: 'b-c' }]] })
    expect(s('a / 2')).toMatchObject({ type: 'binary', op: '/' })
  })
  it('parenthesized spans include the parentheses', () => {
    const src = '(a || b) && c'
    const n = p(src)
    expect(src.slice(n.start, n.end)).toBe(src)
    if (n.type === 'binary') expect(src.slice(n.left.start, n.left.end)).toBe('(a || b)')
  })
})
