import { ParseError, type BinaryOp, type Node, type PathPart } from './ast.js'
import { Lexer, type Token } from './lexer.js'

const REL_OPS = ['==', '!=', '<', '<=', '>', '>=']
const SEGMENT_CHAR = /[A-Za-z0-9_\-.~%@+:]/

/** Node payload without position; mk() adds line/col/start/end. */
type Body = Node extends infer N ? (N extends unknown ? Omit<N, 'line' | 'col' | 'start' | 'end'> : never) : never

export class ExprParser {
  constructor(private readonly lexer: Lexer) {}

  parseExpression(): Node {
    const test = this.parseOr()
    if (!this.isPunct(this.lexer.peek(), '?')) return test
    this.lexer.next()
    const then = this.parseExpression()
    this.expectPunct(':')
    const els = this.parseExpression()
    return this.mk(test.start, els.end, { type: 'ternary', test, then, else: els })
  }

  private parseOr(): Node {
    let left = this.parseAnd()
    while (this.isPunct(this.lexer.peek(), '||')) {
      this.lexer.next()
      left = this.binary('||', left, this.parseAnd())
    }
    return left
  }

  private parseAnd(): Node {
    let left = this.parseRel()
    while (this.isPunct(this.lexer.peek(), '&&')) {
      this.lexer.next()
      left = this.binary('&&', left, this.parseRel())
    }
    return left
  }

  private parseRel(): Node {
    let left = this.parseAdd()
    for (;;) {
      const t = this.lexer.peek()
      const isOp = (t.kind === 'punct' && REL_OPS.includes(t.value)) || (t.kind === 'ident' && (t.value === 'in' || t.value === 'is'))
      if (!isOp) return left
      this.lexer.next()
      left = this.binary(t.value as BinaryOp, left, this.parseAdd())
    }
  }

  private parseAdd(): Node {
    let left = this.parseMul()
    for (;;) {
      const t = this.lexer.peek()
      if (!(this.isPunct(t, '+') || this.isPunct(t, '-'))) return left
      this.lexer.next()
      left = this.binary(t.value as BinaryOp, left, this.parseMul())
    }
  }

  private parseMul(): Node {
    let left = this.parseUnary()
    for (;;) {
      const t = this.lexer.peek()
      if (!(this.isPunct(t, '*') || this.isPunct(t, '/') || this.isPunct(t, '%'))) return left
      this.lexer.next()
      left = this.binary(t.value as BinaryOp, left, this.parseUnary())
    }
  }

  private parseUnary(): Node {
    const t = this.lexer.peek()
    if (this.isPunct(t, '!') || this.isPunct(t, '-')) {
      this.lexer.next()
      const operand = this.parseUnary()
      return this.mk(t.start, operand.end, { type: 'unary', op: t.value as '!' | '-', operand })
    }
    return this.parsePostfix()
  }

  private parsePostfix(): Node {
    let node = this.parsePrimary()
    for (;;) {
      const t = this.lexer.peek()
      if (this.isPunct(t, '.')) {
        this.lexer.next()
        const name = this.lexer.next()
        if (name.kind !== 'ident') this.failAt(name, `expected an identifier, found ${this.describe(name)}`)
        node = this.mk(node.start, name.end, { type: 'member', object: node, property: name.value })
      } else if (this.isPunct(t, '[')) {
        this.lexer.next()
        const index = this.parseExpression()
        const close = this.expectPunct(']')
        node = this.mk(node.start, close.end, { type: 'index', object: node, index })
      } else if (this.isPunct(t, '(')) {
        this.lexer.next()
        const { items, close } = this.parseList(')')
        node = this.mk(node.start, close.end, { type: 'call', callee: node, args: items })
      } else return node
    }
  }

  private parsePrimary(): Node {
    const t = this.lexer.peek()
    switch (t.kind) {
      case 'int':
        this.lexer.next()
        return this.mk(t.start, t.end, { type: 'int', value: Number(t.value) })
      case 'float':
        this.lexer.next()
        return this.mk(t.start, t.end, { type: 'float', value: Number(t.value) })
      case 'string':
        this.lexer.next()
        return this.mk(t.start, t.end, { type: 'string', value: t.value })
      case 'ident':
        this.lexer.next()
        if (t.value === 'true' || t.value === 'false') return this.mk(t.start, t.end, { type: 'bool', value: t.value === 'true' })
        if (t.value === 'null') return this.mk(t.start, t.end, { type: 'null' })
        return this.mk(t.start, t.end, { type: 'ident', name: t.value })
      case 'punct':
        if (t.value === '(') {
          this.lexer.next()
          const inner = this.parseExpression()
          const close = this.expectPunct(')')
          return { ...inner, ...this.lexer.position(t.start), start: t.start, end: close.end }
        }
        if (t.value === '[') {
          this.lexer.next()
          const { items, close } = this.parseList(']')
          return this.mk(t.start, close.end, { type: 'list', items })
        }
        if (t.value === '{') return this.parseMap()
        if (t.value === '/') return this.readPath(t.start)
    }
    return this.failAt(t, `expected an expression, found ${this.describe(t)}`)
  }

  private parseMap(): Node {
    const open = this.lexer.next()
    const entries: { key: string; value: Node }[] = []
    while (!this.isPunct(this.lexer.peek(), '}')) {
      const key = this.lexer.next()
      if (key.kind !== 'string') this.failAt(key, `expected a string key, found ${this.describe(key)}`)
      this.expectPunct(':')
      entries.push({ key: key.value, value: this.parseExpression() })
      if (!this.isPunct(this.lexer.peek(), ',')) break
      this.lexer.next()
    }
    const close = this.expectPunct('}')
    return this.mk(open.start, close.end, { type: 'map', entries })
  }

  /** Comma-separated expressions with optional trailing comma, up to and including `closer`. */
  private parseList(closer: ')' | ']'): { items: Node[]; close: Token } {
    const items: Node[] = []
    while (!this.isPunct(this.lexer.peek(), closer)) {
      items.push(this.parseExpression())
      if (!this.isPunct(this.lexer.peek(), ',')) break
      this.lexer.next()
    }
    return { items, close: this.expectPunct(closer) }
  }

  /** Reads a path literal straight from the source starting at the `/` at `start`. */
  private readPath(start: number): Node {
    const src = this.lexer.src
    const segments: PathPart[][] = []
    let i = start
    while (src[i] === '/') {
      const parsed = this.readSegment(i + 1)
      if (!parsed) break
      segments.push(parsed.parts)
      i = parsed.end
    }
    if (segments.length === 0) {
      const { line, col } = this.lexer.position(start)
      throw new ParseError(line, col, "expected a path segment after '/'")
    }
    this.lexer.seek(i)
    return this.mk(start, i, { type: 'path', segments })
  }

  private readSegment(from: number): { parts: PathPart[]; end: number } | undefined {
    const src = this.lexer.src
    const parts: PathPart[] = []
    const addText = (value: string) => {
      const last = parts[parts.length - 1]
      if (last?.kind === 'text') last.value += value
      else parts.push({ kind: 'text', value })
    }
    let i = from
    for (;;) {
      const c = src[i]
      if (c === '$' && src[i + 1] === '(') {
        this.lexer.seek(i + 2)
        const expr = this.parseExpression()
        parts.push({ kind: 'interp', expr })
        i = this.expectPunct(')').end
      } else if (c === '(') {
        let depth = 0
        let j = i
        for (; j < src.length; j++) {
          if (src[j] === '(') depth++
          else if (src[j] === ')' && --depth === 0) break
        }
        if (j >= src.length) {
          const { line, col } = this.lexer.position(i)
          throw new ParseError(line, col, "unterminated '(' in path")
        }
        addText(src.slice(i, j + 1))
        i = j + 1
      } else if (c !== undefined && SEGMENT_CHAR.test(c)) {
        let j = i + 1
        while (j < src.length && SEGMENT_CHAR.test(src[j]!)) j++
        addText(src.slice(i, j))
        i = j
      } else break
    }
    return parts.length === 0 ? undefined : { parts, end: i }
  }

  private binary(op: BinaryOp, left: Node, right: Node): Node {
    return this.mk(left.start, right.end, { type: 'binary', op, left, right })
  }

  private mk(start: number, end: number, body: Body): Node {
    return { ...body, ...this.lexer.position(start), start, end } as Node
  }

  private isPunct(t: Token, value: string): boolean {
    return t.kind === 'punct' && t.value === value
  }

  private expectPunct(value: string): Token {
    const t = this.lexer.next()
    if (!this.isPunct(t, value)) this.failAt(t, `expected '${value}', found ${this.describe(t)}`)
    return t
  }

  private describe(t: Token): string {
    return t.kind === 'eof' ? 'end of file' : `'${t.value}'`
  }

  private failAt(t: Token, message: string): never {
    throw new ParseError(t.line, t.col, message)
  }
}

/** Test helper: parses a whole source string as one expression and requires end of input. */
export function parseExpressionSource(src: string): Node {
  const lexer = new Lexer(src)
  const node = new ExprParser(lexer).parseExpression()
  const t = lexer.peek()
  if (t.kind !== 'eof') throw new ParseError(t.line, t.col, `expected end of file, found '${t.value}'`)
  return node
}
