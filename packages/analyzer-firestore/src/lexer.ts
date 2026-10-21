import { ParseError, type Pos } from './ast.js'

export type TokenKind = 'ident' | 'int' | 'float' | 'string' | 'punct' | 'eof'
/** value: identifier text, number text, decoded string, or the punctuation itself. */
export interface Token extends Pos { kind: TokenKind; value: string }

const PUNCT2 = ['&&', '||', '==', '!=', '<=', '>=']
const PUNCT1 = '(){}[],;:.?=!-+*/%<>'
const ESCAPES: Record<string, string> = { '\\': '\\', "'": "'", '"': '"', n: '\n', t: '\t', r: '\r' }

const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9'
const isIdentStart = (c: string | undefined) => c !== undefined && /[A-Za-z_]/.test(c)
const isIdentPart = (c: string | undefined) => c !== undefined && /[A-Za-z0-9_]/.test(c)

export class Lexer {
  pos = 0
  private peeked: Token | undefined
  private readonly lineStarts: number[] = [0]

  constructor(readonly src: string) {
    for (let i = 0; i < src.length; i++) if (src[i] === '\n') this.lineStarts.push(i + 1)
  }

  peek(): Token {
    if (!this.peeked) {
      const before = this.pos
      try {
        this.peeked = this.read()
      } finally {
        this.pos = before
      }
    }
    return this.peeked
  }

  next(): Token {
    const t = this.peeked ?? this.read()
    this.peeked = undefined
    this.pos = t.end
    return t
  }

  seek(offset: number): void {
    this.pos = offset
    this.peeked = undefined
  }

  position(offset: number): { line: number; col: number } {
    let lo = 0
    let hi = this.lineStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (this.lineStarts[mid]! <= offset) lo = mid
      else hi = mid - 1
    }
    return { line: lo + 1, col: offset - this.lineStarts[lo]! + 1 }
  }

  private fail(offset: number, message: string): never {
    const { line, col } = this.position(offset)
    throw new ParseError(line, col, message)
  }

  private token(kind: TokenKind, value: string, start: number, end: number): Token {
    return { kind, value, start, end, ...this.position(start) }
  }

  private skipTrivia(): void {
    const s = this.src
    for (;;) {
      const c = s[this.pos]
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') this.pos++
      else if (c === '/' && s[this.pos + 1] === '/') {
        while (this.pos < s.length && s[this.pos] !== '\n') this.pos++
      } else if (c === '/' && s[this.pos + 1] === '*') {
        const close = s.indexOf('*/', this.pos + 2)
        if (close < 0) this.fail(this.pos, 'unterminated block comment')
        this.pos = close + 2
      } else return
    }
  }

  private read(): Token {
    this.skipTrivia()
    const s = this.src
    const start = this.pos
    const c = s[start]
    if (c === undefined) return this.token('eof', '', start, start)
    if (isIdentStart(c)) {
      let e = start + 1
      while (isIdentPart(s[e])) e++
      return this.token('ident', s.slice(start, e), start, e)
    }
    if (isDigit(c)) return this.readNumber(start)
    if (c === "'" || c === '"') return this.readString(start, c)
    const two = s.slice(start, start + 2)
    if (PUNCT2.includes(two)) return this.token('punct', two, start, start + 2)
    if (PUNCT1.includes(c)) return this.token('punct', c, start, start + 1)
    return this.fail(start, `unexpected character '${c}'`)
  }

  private readNumber(start: number): Token {
    const s = this.src
    let e = start
    while (isDigit(s[e])) e++
    if (s[e] !== '.' || !isDigit(s[e + 1])) return this.token('int', s.slice(start, e), start, e)
    e++
    while (isDigit(s[e])) e++
    if (s[e] === 'e' || s[e] === 'E') {
      let x = e + 1
      if (s[x] === '+' || s[x] === '-') x++
      if (isDigit(s[x])) {
        while (isDigit(s[x])) x++
        e = x
      }
    }
    return this.token('float', s.slice(start, e), start, e)
  }

  private readString(start: number, quote: string): Token {
    const s = this.src
    let out = ''
    let i = start + 1
    for (;;) {
      const c = s[i]
      if (c === undefined || c === '\n') this.fail(start, 'unterminated string')
      if (c === quote) return this.token('string', out, start, i + 1)
      if (c !== '\\') {
        out += c
        i++
        continue
      }
      const n = s[i + 1]
      if (n === 'u') {
        const hex = s.slice(i + 2, i + 6)
        if (!/^[0-9A-Fa-f]{4}$/.test(hex)) this.fail(i, 'invalid unicode escape')
        out += String.fromCharCode(parseInt(hex, 16))
        i += 6
      } else if (n !== undefined && n in ESCAPES) {
        out += ESCAPES[n]
        i += 2
      } else this.fail(i, `invalid escape '\\${n ?? ''}'`)
    }
  }
}
