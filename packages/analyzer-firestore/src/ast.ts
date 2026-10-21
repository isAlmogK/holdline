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

export const ALLOW_OPS = ['read', 'write', 'get', 'list', 'create', 'update', 'delete'] as const
export type AllowOp = (typeof ALLOW_OPS)[number]
export type MatchSegment =
  | { kind: 'literal'; value: string }
  | { kind: 'wildcard'; name: string; rest: boolean } // {name} or {name=**}
  | { kind: 'interp'; parts: PathPart[] } // a segment holding $(...)
export interface Block { functions: FunctionDecl[]; matches: Match[]; allows: Allow[] }
export interface FunctionDecl extends Pos { name: string; params: string[]; lets: LetDecl[]; returns: Node }
export interface LetDecl extends Pos { name: string; value: Node }
export interface Match extends Pos { path: MatchSegment[]; body: Block }
export interface Allow extends Pos { ops: AllowOp[]; condition?: Node } // condition absent: unconditional `allow read;`
export interface Service extends Pos { name: string; body: Block } // 'cloud.firestore', 'firebase.storage', ...
export interface RulesAst { version?: string; services: Service[] }
