import { beforeAll, describe, expect, it } from 'vitest'
import { loadSqlParser, type SqlParse } from '../src/pgparse.js'
import { bareSelectTarget, constant, nodeText, type SqlNode } from '../src/sql-ast.js'

let parse: SqlParse
beforeAll(async () => { parse = await loadSqlParser() })
const expr = (sql: string): SqlNode => bareSelectTarget(parse(`SELECT ${sql}`).stmts[0]!.stmt)!

describe('constant', () => {
  it('reads constants and strips casts', () => {
    expect(constant(expr(`'a'`))).toEqual({ value: 'a' })
    expect(constant(expr(`''`))).toEqual({ value: '' })
    expect(constant(expr(`0`))).toEqual({ value: 0 })
    expect(constant(expr(`-2`))).toEqual({ value: -2 })
    expect(constant(expr(`1.5`))).toEqual({ value: 1.5 })
    expect(constant(expr(`false`))).toEqual({ value: false })
    expect(constant(expr(`null`))).toEqual({ value: null })
    expect(constant(expr(`'admin'::member_role`))).toEqual({ value: 'admin' })
    expect(constant(expr(`'5'::integer`))).toEqual({ value: 5 })
    expect(constant(expr(`'A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11'::uuid`))).toEqual({ value: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' })
    expect(constant(expr(`'t'::boolean`))).toBeUndefined()
    expect(constant(expr(`x`))).toBeUndefined()
  })
})

describe('bareSelectTarget', () => {
  it('returns the single target of a SELECT with nothing else', () => {
    expect(bareSelectTarget(parse('SELECT 1').stmts[0]!.stmt)).toBeDefined()
    expect(bareSelectTarget(parse('SELECT 1, 2').stmts[0]!.stmt)).toBeUndefined()
    expect(bareSelectTarget(parse('SELECT 1 FROM t').stmts[0]!.stmt)).toBeUndefined()
    expect(bareSelectTarget(parse('SELECT 1 WHERE true').stmts[0]!.stmt)).toBeUndefined()
  })
})

describe('nodeText', () => {
  it('gives the source text of a node', () => {
    const source = `SELECT coalesce(a, 'é') = lower(b) AND c`
    const top = bareSelectTarget(parse(source).stmts[0]!.stmt)!
    const left = top.BoolExpr.args[0]
    expect(nodeText(source, left)).toBe(`coalesce(a, 'é') = lower(b)`)
    expect(nodeText(source, top)).toBe(`coalesce(a, 'é') = lower(b) AND c`)
    const call = `SELECT ((owner_id)::text = auth.uid())`
    expect(nodeText(call, bareSelectTarget(parse(call).stmts[0]!.stmt)!)).toBe('(owner_id)::text = auth.uid()')
  })
})
