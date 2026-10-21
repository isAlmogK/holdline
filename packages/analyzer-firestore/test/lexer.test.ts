import { describe, expect, it } from 'vitest'
import { ParseError } from '../src/ast.js'
import { Lexer } from '../src/lexer.js'

const kinds = (src: string) => {
  const lx = new Lexer(src)
  const out: string[] = []
  for (let t = lx.next(); t.kind !== 'eof'; t = lx.next()) out.push(`${t.kind}:${t.value}`)
  return out
}

describe('Lexer', () => {
  it('reads identifiers, numbers, strings and punctuation', () => {
    expect(kinds(`allow read: if a.b == 'x' && 1.5 >= 2;`)).toEqual([
      'ident:allow', 'ident:read', 'punct::', 'ident:if', 'ident:a', 'punct:.', 'ident:b', 'punct:==',
      'string:x', 'punct:&&', 'float:1.5', 'punct:>=', 'int:2', 'punct:;',
    ])
  })
  it('skips line and block comments', () => {
    expect(kinds('a // c\n/* x\ny */ b')).toEqual(['ident:a', 'ident:b'])
  })
  it('decodes escapes in both quote styles', () => {
    expect(kinds(`"a\\"b" 'c\\'d' '\\u0041\\n'`)).toEqual(['string:a"b', "string:c'd", 'string:A\n'])
  })
  it('records 1-based line and column and source offsets', () => {
    const lx = new Lexer('a\n  bc')
    lx.next()
    const t = lx.next()
    expect(t).toMatchObject({ line: 2, col: 3, start: 4, end: 6 })
  })
  it('peek does not consume; seek rewinds', () => {
    const lx = new Lexer('a b')
    expect(lx.peek().value).toBe('a')
    expect(lx.next().value).toBe('a')
    lx.seek(0)
    expect(lx.next().value).toBe('a')
  })
  it('reports unterminated strings and comments at their start', () => {
    expect(() => kinds("x 'abc")).toThrow(ParseError)
    try { kinds("x\n  'abc") } catch (e) { expect(e).toMatchObject({ line: 2, col: 3 }) }
    try { kinds('/* never') } catch (e) { expect(e).toMatchObject({ line: 1, col: 1 }) }
  })
  it('reports an unexpected character with its position', () => {
    try { kinds('a\n #') } catch (e) { expect(e).toMatchObject({ line: 2, col: 2, message: "unexpected character '#'" }) }
    expect(() => kinds('#')).toThrow(ParseError)
  })
  it('lexes / as punct and $ as unexpected', () => {
    expect(kinds('/a/b')).toEqual(['punct:/', 'ident:a', 'punct:/', 'ident:b'])
    expect(() => kinds('$')).toThrow(ParseError)
  })
  it('position works for any offset including end of source', () => {
    const lx = new Lexer('a\nbc')
    expect(lx.position(0)).toEqual({ line: 1, col: 1 })
    expect(lx.position(1)).toEqual({ line: 1, col: 2 })
    expect(lx.position(2)).toEqual({ line: 2, col: 1 })
    expect(lx.position(4)).toEqual({ line: 2, col: 3 })
  })
  it('lexes float exponents and keeps int then dot-less', () => {
    expect(kinds('1.5e-3 7')).toEqual(['float:1.5e-3', 'int:7'])
  })
})
