import {
  ALLOW_OPS, ParseError,
  type Allow, type AllowOp, type Block, type FunctionDecl, type LetDecl, type Match, type Node, type RulesAst, type Service,
} from './ast.js'
import { Lexer, describeToken, type Token } from './lexer.js'
import { ExprParser } from './parse-expr.js'
import { readMatchPath } from './parse-path.js'

export type ParseResult = { ok: true; ast: RulesAst } | { ok: false; error: { line: number; col: number; message: string } }

/** Parses a Firestore / Storage security rules file. Never throws on bad input. */
export function parseRules(src: string): ParseResult {
  try {
    return { ok: true, ast: new StatementParser(new Lexer(src)).parseFile() }
  } catch (e) {
    if (e instanceof ParseError) return { ok: false, error: { line: e.line, col: e.col, message: e.message } }
    throw e
  }
}

class StatementParser {
  private readonly expr: ExprParser

  constructor(private readonly lexer: Lexer) {
    this.expr = new ExprParser(lexer)
  }

  parseFile(): RulesAst {
    const ast: RulesAst = { services: [] }
    if (this.isWord(this.lexer.peek(), 'rules_version')) {
      this.lexer.next()
      this.expectPunct('=')
      const v = this.lexer.next()
      if (v.kind !== 'string') this.fail(v, `expected a version string, found ${describeToken(v)}`)
      ast.version = v.value
      this.optionalPunct(';')
    }
    while (this.lexer.peek().kind !== 'eof') ast.services.push(this.parseService())
    return ast
  }

  private parseService(): Service {
    const kw = this.expectWord('service')
    let name = this.expectIdent().value
    while (this.optionalPunct('.')) name += `.${this.expectIdent().value}`
    this.expectPunct('{')
    const body = this.parseBlock()
    return this.at(kw, this.expectPunct('}').end, { name, body })
  }

  /** Statements up to (not including) the closing `}`. */
  private parseBlock(): Block {
    const block: Block = { functions: [], matches: [], allows: [] }
    for (;;) {
      const t = this.lexer.peek()
      if (this.isWord(t, 'function')) block.functions.push(this.parseFunction())
      else if (this.isWord(t, 'match')) block.matches.push(this.parseMatch())
      else if (this.isWord(t, 'allow')) block.allows.push(this.parseAllow())
      else if (this.isPunct(t, '}')) return block
      else if (t.kind === 'eof') return this.fail(t, "expected '}', found end of file")
      else return this.fail(t, `expected 'match', 'allow', 'function' or '}', found ${describeToken(t)}`)
    }
  }

  private parseFunction(): FunctionDecl {
    const kw = this.expectWord('function')
    const name = this.expectIdent().value
    this.expectPunct('(')
    const params: string[] = []
    if (!this.isPunct(this.lexer.peek(), ')')) {
      do params.push(this.expectIdent().value)
      while (this.optionalPunct(','))
    }
    this.expectPunct(')')
    this.expectPunct('{')
    const lets: LetDecl[] = []
    while (this.isWord(this.lexer.peek(), 'let')) {
      const letKw = this.lexer.next()
      const letName = this.expectIdent().value
      this.expectPunct('=')
      const value = this.expr.parseExpression()
      lets.push(this.at(letKw, this.expectPunct(';').end, { name: letName, value }))
    }
    this.expectWord('return')
    const returns = this.expr.parseExpression()
    this.optionalPunct(';')
    return this.at(kw, this.expectPunct('}').end, { name, params, lets, returns })
  }

  private parseMatch(): Match {
    const kw = this.expectWord('match')
    const first = this.lexer.peek()
    if (!this.isPunct(first, '/')) this.fail(first, `expected a path, found ${describeToken(first)}`)
    const { segments } = readMatchPath(this.expr, first.start)
    this.expectPunct('{')
    const body = this.parseBlock()
    return this.at(kw, this.expectPunct('}').end, { path: segments, body })
  }

  private parseAllow(): Allow {
    const kw = this.expectWord('allow')
    const ops: AllowOp[] = []
    do ops.push(this.parseOp())
    while (this.optionalPunct(','))
    let condition: Node | undefined
    let end = this.lexer.pos
    if (this.optionalPunct(':')) {
      this.expectWord('if')
      condition = this.expr.parseExpression()
      end = condition.end
    }
    const semi = this.optionalPunct(';')
    return this.at(kw, semi ? semi.end : end, condition ? { ops, condition } : { ops })
  }

  private parseOp(): AllowOp {
    const t = this.expectIdent()
    if (!(ALLOW_OPS as readonly string[]).includes(t.value)) {
      this.fail(t, `unknown operation '${t.value}' (expected read, write, get, list, create, update or delete)`)
    }
    return t.value as AllowOp
  }

  private at<T extends object>(start: Token, end: number, body: T): T & { line: number; col: number; start: number; end: number } {
    return { ...body, line: start.line, col: start.col, start: start.start, end }
  }

  private isPunct(t: Token, value: string): boolean {
    return t.kind === 'punct' && t.value === value
  }

  private isWord(t: Token, value: string): boolean {
    return t.kind === 'ident' && t.value === value
  }

  private optionalPunct(value: string): Token | undefined {
    return this.isPunct(this.lexer.peek(), value) ? this.lexer.next() : undefined
  }

  private expectPunct(value: string): Token {
    const t = this.lexer.next()
    if (!this.isPunct(t, value)) this.fail(t, `expected '${value}', found ${describeToken(t)}`)
    return t
  }

  private expectWord(value: string): Token {
    const t = this.lexer.next()
    if (!this.isWord(t, value)) this.fail(t, `expected '${value}', found ${describeToken(t)}`)
    return t
  }

  private expectIdent(): Token {
    const t = this.lexer.next()
    if (t.kind !== 'ident') this.fail(t, `expected an identifier, found ${describeToken(t)}`)
    return t
  }

  private fail(t: Token, message: string): never {
    throw new ParseError(t.line, t.col, message)
  }
}
