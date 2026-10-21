/** Source position. 1-based line/col; start/end are source offsets, end exclusive. */
export interface Pos { line: number; col: number; start: number; end: number }

export class ParseError extends Error {
  constructor(readonly line: number, readonly col: number, message: string) {
    super(message)
    this.name = 'ParseError'
  }
}

export type BinaryOp = '*' | '/' | '%' | '+' | '-' | '<' | '<=' | '>' | '>=' | '==' | '!=' | 'in' | 'is' | '&&' | '||'
export type PathPart = { kind: 'text'; value: string } | { kind: 'interp'; expr: Node }
export type Node = Pos & (
  | { type: 'string'; value: string }
  | { type: 'int'; value: number }
  | { type: 'float'; value: number }
  | { type: 'bool'; value: boolean }
  | { type: 'null' }
  | { type: 'list'; items: Node[] }
  | { type: 'map'; entries: { key: string; value: Node }[] }
  | { type: 'path'; segments: PathPart[][] }
  | { type: 'ident'; name: string }
  | { type: 'member'; object: Node; property: string }
  | { type: 'index'; object: Node; index: Node }
  | { type: 'call'; callee: Node; args: Node[] }
  | { type: 'unary'; op: '!' | '-'; operand: Node }
  | { type: 'binary'; op: BinaryOp; left: Node; right: Node }
  | { type: 'ternary'; test: Node; then: Node; else: Node }
)
