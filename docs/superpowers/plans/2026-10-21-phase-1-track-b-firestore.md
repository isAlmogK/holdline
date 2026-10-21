# Phase 1 Track B: Firestore and Storage Analyzer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `packages/analyzer-firestore` reads `firestore.rules` and `storage.rules`, emits policy facts whose conditions are sound `Expr`s, and `examples/golden-firebase` proves every breakage is caught end to end.

**Architecture:** A hand-written lexer and recursive-descent parser produce an AST with positions. An expansion pass walks nested `match` blocks into allow sites (target, ops, scope). A normalizer turns each allow condition into an `Expr`, inlining user functions lexically and mapping rules expressions through the spec 4.4 table; everything it cannot map exactly becomes `opaque`. The analyzer wires discovery (config, `firebase.json`, root files), caching and diagnostics, and the CLI registers it and prints a per-file policy/opaque summary.

**Tech Stack:** TypeScript (ESM, strict, NodeNext), vitest, fast-check (soundness), `@firebase/rules-unit-testing` + `firebase` (emulator tests only, dev dependencies), pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-10-21-data-layers-design.md` sections 4, 6.2, 7, 8, 9 and "As built (step 0)". Contracts: `docs/reference/facts.md`, `docs/reference/rules-file.md`.

## Global Constraints

- ESM, strict TypeScript, relative imports end in `.js`. One responsibility per file; split files that pass about 200 lines.
- Among workspace packages, `packages/analyzer-firestore` depends only on `@holdline/core`. No network calls, no model client. No parser generator, no build step.
- No model decides pass/fail. When a condition cannot be mapped exactly, it is `{ opaque: <source text> }`. Never drop a policy silently: a policy that is dropped means "denied", which can make a rule pass falsely.
- **Soundness invariant (all normalization):** for every request, if Firestore evaluates the source condition to `true`, the emitted `Expr` evaluates to `true` in the Holdline model (absent field = `null`; atoms reading the actor are false for an anonymous caller). Proof sketch the code relies on: every atom mapping is exact on non-error values, `&&`/`||`/`!`/`?:` map structurally, and Firestore errors never evaluate to `true` at the top.
- Commits: conventional commits on branch `claude/phase-1-firestore-61785b`, never on `main`. End each commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Privacy:** nothing from DogBase (`~/Engineering/DogBase/dogbase`) enters this repo: no code, rules, field names, collection names, paths or findings in code, tests, fixtures, docs, commit messages or PR text. Every example is invented.
- Files this track owns: `packages/analyzer-firestore/**`, `examples/golden-firebase/**`, one import + one array entry in `packages/cli/src/analyzers.ts`, the summary line in `packages/cli/src/commands/scan.ts` (+ a new `packages/cli/src/format/policy-summary.ts`), the Firestore rows of `docs/reference/*.md`, the spec's "As built (Track B)" section. Shared one-liners also touched: root `package.json` (`typecheck`), `packages/cli/package.json` (dependency), `pnpm-lock.yaml`, and one assertion in `packages/cli/test/golden-patch.test.ts`.
- Commands: `pnpm test`, `pnpm typecheck`, `pnpm vitest run <path>` for one file, `pnpm holdline <command>`.

## File map

| File | Responsibility |
|---|---|
| `packages/analyzer-firestore/package.json`, `tsconfig.json` | Package `@holdline/analyzer-firestore` |
| `src/ast.ts` | AST node types with positions |
| `src/lexer.ts` | Tokens, comments, strings, numbers; positions |
| `src/parse-expr.ts` | Expression and path-literal parser |
| `src/parser.ts` | Statements: version, service, match, function, allow; `parseRules` |
| `src/expand.ts` | Match tree → allow sites and match sites; ops and target expansion; scopes |
| `src/scope.ts` | Lexical scopes (functions, wildcards) and binding environments |
| `src/value.ts` | Rules value → operand / literal / lookup (`resolveValue`) |
| `src/lookup-path.ts` | Path literal → `P'` (`/users/{actor.uid}`) |
| `src/condition.ts` | Boolean rules expression → `Expr` (`normalizeCondition`) |
| `src/compare.ts` | Comparisons and `.get(k, d)` defaults |
| `src/simplify.ts` | Flatten / dedupe `and` and `or` |
| `src/discover.ts` | Which files to read (config, `firebase.json`, root) |
| `src/analyze-file.ts` | One rules file → policies, symbols, diagnostics |
| `src/analyzer.ts` | The `Analyzer` object: detect, analyze, cache |
| `src/index.ts` | Exports |
| `test/*.test.ts` | Unit tests per file |
| `test/helpers/interpret.ts` | Reference interpreter of the rules subset with Firestore error semantics (soundness model) |
| `test/helpers/eval-expr.ts` | Holdline `Expr` evaluator on the same model |
| `test/soundness.test.ts` | Model-based property tests, one per normalization row |
| `test/emulator/soundness.emulator.test.ts` | Same rows against the real emulator, tagged `@emulator` |
| `packages/cli/src/format/policy-summary.ts` | Per rules file: policies, opaque sub-conditions |
| `examples/golden-firebase/*` | Rules, expected rules, breakages |

---

### Task 1: Package scaffold and lexer

**Files:**
- Create: `packages/analyzer-firestore/package.json`, `packages/analyzer-firestore/tsconfig.json`, `packages/analyzer-firestore/src/ast.ts`, `packages/analyzer-firestore/src/lexer.ts`, `packages/analyzer-firestore/src/index.ts`
- Modify: root `package.json` (`typecheck` script)
- Test: `packages/analyzer-firestore/test/lexer.test.ts`

**Interfaces:**
- Produces: `Pos`, `Token`, `TokenKind`, `Lexer` (class), `ParseError` (class) — used by Tasks 2 and 3.

```ts
// src/ast.ts (first part; Task 2 adds node types)
export interface Pos { line: number; col: number; start: number; end: number } // 1-based line/col; start/end are source offsets, end exclusive
export class ParseError extends Error {
  constructor(readonly line: number, readonly col: number, message: string) { super(message); this.name = 'ParseError' }
}

// src/lexer.ts
export type TokenKind = 'ident' | 'int' | 'float' | 'string' | 'punct' | 'eof'
export interface Token extends Pos { kind: TokenKind; value: string } // value: identifier text, number text, decoded string, or the punctuation itself
export class Lexer {
  constructor(src: string)
  readonly src: string
  pos: number                 // offset of the next unread character
  peek(): Token               // does not consume
  next(): Token               // consumes
  seek(offset: number): void  // rewinds or skips; clears the peeked token
  position(offset: number): { line: number; col: number }
}
```

Punctuation tokens (longest match first): `&& || == != <= >= ( ) { } [ ] , ; : . ? = ! - + * / % < >`. Comments `// …` to end of line and `/* … */` are skipped like whitespace; an unterminated block comment or string is a `ParseError` at its start. Strings use `'` or `"` and decode `\\ \' \" \n \t \r \uXXXX`. Numbers: `[0-9]+` is `int`; `[0-9]+\.[0-9]+([eE][+-]?[0-9]+)?` is `float`. Identifiers: `[A-Za-z_][A-Za-z0-9_]*` (keywords are identifiers; the parser decides). Any other character is a `ParseError` "unexpected character 'x'".

- [ ] **Step 1: Scaffold the package**

`packages/analyzer-firestore/package.json`:
```json
{
  "name": "@holdline/analyzer-firestore",
  "version": "0.0.0",
  "type": "module",
  "license": "Apache-2.0",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "@holdline/core": "workspace:*"
  }
}
```
`packages/analyzer-firestore/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
```
Root `package.json` script: `"typecheck": "tsc -p packages/core && tsc -p packages/cli && tsc -p packages/analyzer-firestore"`.
`src/index.ts`: `export {}` for now (Task 8 fills it). Run `pnpm install`.

- [ ] **Step 2: Write the failing lexer tests**

```ts
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
})
```

- [ ] **Step 3: Run to see it fail**: `pnpm vitest run packages/analyzer-firestore/test/lexer.test.ts` → FAIL (module not found).
- [ ] **Step 4: Implement `ast.ts` (Pos, ParseError) and `lexer.ts`** to the interface above. `position(offset)` counts newlines before `offset` (precompute line start offsets once).
- [ ] **Step 5: Run the test and `pnpm typecheck`** → PASS.
- [ ] **Step 6: Commit** `feat(analyzer-firestore): add package and lexer`.

---

### Task 2: Expression and path-literal parser

**Files:**
- Modify: `packages/analyzer-firestore/src/ast.ts` (node types)
- Create: `packages/analyzer-firestore/src/parse-expr.ts`
- Test: `packages/analyzer-firestore/test/parse-expr.test.ts`

**Interfaces:**
- Consumes: `Lexer`, `Token`, `Pos`, `ParseError` (Task 1).
- Produces (used by Tasks 3–7):

```ts
// src/ast.ts additions
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
  | { type: 'path'; segments: PathPart[][] }          // one PathPart[] per `/`-separated segment
  | { type: 'ident'; name: string }
  | { type: 'member'; object: Node; property: string }
  | { type: 'index'; object: Node; index: Node }
  | { type: 'call'; callee: Node; args: Node[] }      // callee is `ident` (function) or `member` (method)
  | { type: 'unary'; op: '!' | '-'; operand: Node }
  | { type: 'binary'; op: BinaryOp; left: Node; right: Node }
  | { type: 'ternary'; test: Node; then: Node; else: Node }
)

// src/parse-expr.ts
export class ExprParser {
  constructor(lexer: Lexer)
  parseExpression(): Node           // full expression including ternary
}
export function parseExpressionSource(src: string): Node // test helper: parses and requires eof
```

Grammar (lowest to highest precedence; all binary operators left-associative):
```
expr     := or ('?' expr ':' expr)?
or       := and ('||' and)*
and      := rel ('&&' rel)*
rel      := add (('=='|'!='|'<'|'<='|'>'|'>='|'in'|'is') add)*
add      := mul (('+'|'-') mul)*
mul      := unary (('*'|'/'|'%') unary)*
unary    := ('!'|'-') unary | postfix
postfix  := primary ('.' ident | '.' ident '(' args ')' | '[' expr ']' | '(' args ')')*
primary  := int | float | string | 'true' | 'false' | 'null' | ident | '(' expr ')' | '[' args ']' | '{' mapEntries '}' | pathLiteral
mapEntries := (string ':' expr (',' string ':' expr)* ','?)?
args     := (expr (',' expr)* ','?)?
```
`in` and `is` are identifiers recognized as operators in `rel` position. Every node's `start`/`end` covers its whole source (a binary node spans from left start to right end), so `src.slice(node.start, node.end)` is its text.

**Path literals** are read character by character from the source, not from tokens. In `primary`, when the next token is punct `/`, call `readPath(token.start)`:
```
path     := ('/' segment)+                 -- stops at the first character that cannot continue it
segment  := part+
part     := text | '$(' expr ')' | '(' rawText ')'
text     := [A-Za-z0-9_\-.~%@+:]+
```
`$(expr)`: seek the lexer to after `$(`, `parseExpression()`, expect punct `)`, continue from the lexer's offset. `(raw)` without `$` (as in `/databases/(default)/documents`) is kept as text including the parentheses, with balanced-paren reading. A `/` not followed by a segment character ends the path before that `/` (so `a / 2` never reaches here; division only happens in `mul`). After the path, seek the lexer to the end offset.

- [ ] **Step 1: Write the failing tests** — one per construct in spec 4.2's expression list, plus precedence and errors:

```ts
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
})
```

- [ ] **Step 2: Run** `pnpm vitest run packages/analyzer-firestore/test/parse-expr.test.ts` → FAIL.
- [ ] **Step 3: Implement `parse-expr.ts`.** Error messages: `expected 'X', found 'Y'` (found = token value or `end of file`), `expected an expression, found 'Y'`. Position of an error = the offending token.
- [ ] **Step 4: Run tests + typecheck** → PASS.
- [ ] **Step 5: Commit** `feat(analyzer-firestore): parse rules expressions and path literals`.

---

### Task 3: Statement parser

**Files:**
- Modify: `packages/analyzer-firestore/src/ast.ts`
- Create: `packages/analyzer-firestore/src/parser.ts`
- Test: `packages/analyzer-firestore/test/parser.test.ts`

**Interfaces:**
- Consumes: `ExprParser`, `Lexer` (Tasks 1–2).
- Produces:

```ts
// src/ast.ts additions
export const ALLOW_OPS = ['read', 'write', 'get', 'list', 'create', 'update', 'delete'] as const
export type AllowOp = (typeof ALLOW_OPS)[number]
export type MatchSegment =
  | { kind: 'literal'; value: string }
  | { kind: 'wildcard'; name: string; rest: boolean }   // {name} or {name=**}
  | { kind: 'interp'; parts: PathPart[] }                // a segment holding $(...)
export interface Block { functions: FunctionDecl[]; matches: Match[]; allows: Allow[] }
export interface FunctionDecl extends Pos { name: string; params: string[]; lets: LetDecl[]; returns: Node }
export interface LetDecl extends Pos { name: string; value: Node }
export interface Match extends Pos { path: MatchSegment[]; body: Block }
export interface Allow extends Pos { ops: AllowOp[]; condition?: Node }   // condition absent: unconditional `allow read;`
export interface Service extends Pos { name: string; body: Block }        // name: 'cloud.firestore', 'firebase.storage', ...
export interface RulesAst { version?: string; services: Service[] }

// src/parser.ts
export type ParseResult = { ok: true; ast: RulesAst } | { ok: false; error: { line: number; col: number; message: string } }
export function parseRules(src: string): ParseResult
```

Grammar:
```
file     := ('rules_version' '=' string ';'?)? service* eof
service  := 'service' dottedName '{' block '}'
block    := (function | match | allow)*
function := 'function' ident '(' (ident (',' ident)*)? ')' '{' ('let' ident '=' expr ';')* 'return' expr ';'? '}'
match    := 'match' matchPath '{' block '}'
allow    := 'allow' op (',' op)* (':' 'if' expr)? ';'?
```
`matchPath` is read from the source like a path literal (Task 2), but segments are: a literal `[A-Za-z0-9_\-.~%@+:]+`, a wildcard `{name}` or `{name=**}` (`name` is `[A-Za-z0-9_]+`), or a segment containing `$(expr)` (`interp`). The path ends at the first character that is not `/` after a segment (whitespace or the block's `{`). `{name=**}` anywhere but the last segment of the whole match path is fine syntactically (the expander handles it). An unknown op name is an error `unknown operation 'x' (expected read, write, get, list, create, update or delete)` at the op token. `;` is optional after `allow`, `return` and `rules_version` (both Firebase compilers accept it missing). `parseRules` catches `ParseError` and returns `{ ok: false, error }`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest'
import { parseRules } from '../src/parser.js'

const ok = (src: string) => {
  const r = parseRules(src)
  if (!r.ok) throw new Error(`${r.error.line}:${r.error.col} ${r.error.message}`)
  return r.ast
}
const err = (src: string) => {
  const r = parseRules(src)
  if (r.ok) throw new Error('expected a parse error')
  return r.error
}

describe('parseRules', () => {
  it('reads rules_version and both services', () => {
    const ast = ok(`rules_version = '2';\nservice cloud.firestore {}\nservice firebase.storage {}`)
    expect(ast.version).toBe('2')
    expect(ast.services.map(s => s.name)).toEqual(['cloud.firestore', 'firebase.storage'])
  })
  it('reads nested match blocks with literal, wildcard and rest segments', () => {
    const ast = ok(`service cloud.firestore { match /databases/{database}/documents { match /a/{id}/b/{rest=**} {} } }`)
    const outer = ast.services[0]!.body.matches[0]!
    expect(outer.path).toEqual([{ kind: 'literal', value: 'databases' }, { kind: 'wildcard', name: 'database', rest: false }, { kind: 'literal', value: 'documents' }])
    expect(outer.body.matches[0]!.path).toEqual([
      { kind: 'literal', value: 'a' }, { kind: 'wildcard', name: 'id', rest: false },
      { kind: 'literal', value: 'b' }, { kind: 'wildcard', name: 'rest', rest: true },
    ])
  })
  it('reads $(expr) in a match path', () => {
    const ast = ok(`service cloud.firestore { match /a/$(x) {} }`)
    expect(ast.services[0]!.body.matches[0]!.path[1]).toMatchObject({ kind: 'interp', parts: [{ kind: 'interp', expr: { type: 'ident', name: 'x' } }] })
  })
  it('reads allow with a condition, unconditional allow, and every op', () => {
    const ast = ok(`service cloud.firestore { match /a/{id} {
      allow read, write: if true;
      allow get, list, create, update, delete;
    } }`)
    const [a, b] = ast.services[0]!.body.matches[0]!.body.allows
    expect(a).toMatchObject({ ops: ['read', 'write'], condition: { type: 'bool', value: true }, line: 2 })
    expect(b).toMatchObject({ ops: ['get', 'list', 'create', 'update', 'delete'], line: 3 })
    expect(b!.condition).toBeUndefined()
  })
  it('reads functions with params and lets, at any scope', () => {
    const ast = ok(`service cloud.firestore {
      function top() { return true; }
      match /a/{id} {
        function f(x, y) { let z = x; let w = z && y; return w; }
      }
    }`)
    expect(ast.services[0]!.body.functions[0]).toMatchObject({ name: 'top', params: [], lets: [] })
    expect(ast.services[0]!.body.matches[0]!.body.functions[0]).toMatchObject({ name: 'f', params: ['x', 'y'], lets: [{ name: 'z' }, { name: 'w' }], returns: { type: 'ident', name: 'w' } })
  })
  it('accepts missing semicolons after allow, return and rules_version', () => {
    expect(() => ok(`rules_version = '2'\nservice cloud.firestore { function f() { return true } match /a {} allow read: if f() }`)).not.toThrow()
  })
  it('skips comments anywhere', () => {
    expect(() => ok(`// c\nservice cloud.firestore { /* x */ match /a/{b} { allow read: if /* y */ true; // z\n } }`)).not.toThrow()
  })
  it('reports an unknown op at its position', () => {
    expect(err(`service cloud.firestore {\n  match /a {\n    allow reed: if true;\n  }\n}`)).toEqual({ line: 3, col: 11, message: "unknown operation 'reed' (expected read, write, get, list, create, update or delete)" })
  })
  it('reports a missing brace and an unexpected statement with positions', () => {
    expect(err(`service cloud.firestore {\n  match /a {\n`)).toMatchObject({ line: 3, col: 1, message: expect.stringContaining("expected '}'") })
    expect(err(`service cloud.firestore {\n  permit read;\n}`)).toMatchObject({ line: 2, col: 3, message: expect.stringContaining("expected 'match', 'allow', 'function' or '}'") })
  })
  it('reports expression errors inside an allow with their position', () => {
    expect(err(`service cloud.firestore {\n  match /a {\n    allow read: if a == ;\n  }\n}`)).toMatchObject({ line: 3, col: 25 })
  })
  it('reports a bad wildcard', () => {
    expect(err(`service cloud.firestore { match /a/{b=*} {} }`)).toMatchObject({ line: 1, col: 36 })
  })
})
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement `parser.ts`.** **Step 4: Run tests + typecheck** → PASS.
- [ ] **Step 5: Commit** `feat(analyzer-firestore): parse rules statements with error positions`.

---

### Task 4: Expansion: targets, ops, policy ids and scopes

**Files:**
- Create: `packages/analyzer-firestore/src/scope.ts`, `packages/analyzer-firestore/src/expand.ts`
- Test: `packages/analyzer-firestore/test/expand.test.ts`

**Interfaces:**
- Consumes: `RulesAst`, `Match`, `Allow`, `FunctionDecl` (Task 3); `Op` from `@holdline/core`.
- Produces:

```ts
// src/scope.ts
export interface FunctionDef { decl: FunctionDecl; scope: Scope }   // scope = where it was declared
export class Scope {
  constructor(readonly parent: Scope | undefined, readonly wildcards: ReadonlySet<string>)
  readonly functions: Map<string, FunctionDef>
  findFunction(name: string): FunctionDef | undefined   // innermost first
  isWildcard(name: string): boolean                     // any enclosing match, innermost first
}

// src/expand.ts
export type Store = 'firestore' | 'storage'
export interface AllowSite { store: Store; target: string; ops: Op[]; allow: Allow; scope: Scope }
export interface MatchSite { store: Store; target: string; line: number }
export interface Expansion { allows: AllowSite[]; matches: MatchSite[]; warnings: string[] }
export function expandRules(ast: RulesAst): Expansion
export function expandOps(ops: readonly AllowOp[]): Op[]   // deduped, in OPS order
export function policyIds(sites: readonly AllowSite[]): string[]  // parallel to sites × ops, see below
```

Rules:
- Service `cloud.firestore` → store `firestore`; `firebase.storage` → `storage`; any other service → a warning `service <name> is not Firestore or Storage; skipped` and nothing else.
- Ops: `read` → `read`, `list`; `get` → `read`; `list` → `list`; `write` → `create`, `update`, `delete`; `create`/`update`/`delete` → themselves. Dedupe, order as core `OPS` (`read, list, create, update, delete`).
- Target: concatenate the segments of every enclosing `match` from the service down. Then remove the prefix: Firestore `databases/{*}/documents`, Storage `b/{*}/o` (first three segments: literal, wildcard, literal). If the prefix is absent, keep the path and add a warning `match <path> is not under /databases/{database}/documents` (`/b/{bucket}/o` for Storage). Render: literal → text, wildcard → `{name}` or `{name=**}`, interp segment → `{_interpN=**}` with a running N (a conservative rest wildcard: a `$(x)` value may span segments, so it overlaps more, never less). Empty path → `/`.
- Allows directly in the service block or in the prefix match itself get target `/`. Firestore applies such an allow to no document, and `patternsOverlap('/', x)` is false for every document path, so this is exact; no warning.
- Scope: the service block gets a root scope (no wildcards); each match gets a child scope whose wildcards are the wildcard names of its own path segments; functions declared in a block are registered in that block's scope before any allow is expanded (order in the file does not matter).
- Each `match` whose target is distinct gives one `MatchSite` (first occurrence wins), at the `match` line.
- Policy ids: `<store>:<target>#<op>@<line>`; if two allow statements give the same id (same target, op and line), the later ones get `@<line>:<col>`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest'
import { expandOps, expandRules, policyIds } from '../src/expand.js'
import { parseRules } from '../src/parser.js'

const expand = (src: string) => {
  const r = parseRules(src)
  if (!r.ok) throw new Error(r.error.message)
  return expandRules(r.ast)
}
const fs = (body: string) => `service cloud.firestore { match /databases/{database}/documents { ${body} } }`

describe('expandOps', () => {
  it('maps rules ops to Holdline ops', () => {
    expect(expandOps(['read'])).toEqual(['read', 'list'])
    expect(expandOps(['get'])).toEqual(['read'])
    expect(expandOps(['list'])).toEqual(['list'])
    expect(expandOps(['write'])).toEqual(['create', 'update', 'delete'])
    expect(expandOps(['update', 'read', 'get'])).toEqual(['read', 'list', 'update'])
  })
})

describe('expandRules', () => {
  it('concatenates nested matches and strips the Firestore prefix', () => {
    const e = expand(fs('match /orgs/{orgId} { match /projects/{projectId} { allow read: if true; } }'))
    expect(e.allows.map(a => [a.store, a.target, a.ops])).toEqual([['firestore', '/orgs/{orgId}/projects/{projectId}', ['read', 'list']]])
    expect(e.matches.map(m => m.target)).toEqual(['/', '/orgs/{orgId}', '/orgs/{orgId}/projects/{projectId}'])
  })
  it('strips the Storage prefix and keeps rest wildcards', () => {
    const e = expand(`service firebase.storage { match /b/{bucket}/o { match /files/{path=**} { allow write: if true; } } }`)
    expect(e.allows[0]).toMatchObject({ store: 'storage', target: '/files/{path=**}', ops: ['create', 'update', 'delete'] })
  })
  it('handles a prefix and a path written in one match', () => {
    const e = expand(`service cloud.firestore { match /databases/{db}/documents/users/{uid} { allow get: if true; } }`)
    expect(e.allows[0]).toMatchObject({ target: '/users/{uid}', ops: ['read'] })
  })
  it('warns about a match outside the document prefix and keeps it', () => {
    const e = expand(`service cloud.firestore { match /users/{uid} { allow read: if true; } }`)
    expect(e.allows[0]!.target).toBe('/users/{uid}')
    expect(e.warnings).toEqual([expect.stringContaining('not under /databases/{database}/documents')])
  })
  it('renders an interpolated match segment as a conservative wildcard', () => {
    expect(expand(fs('match /a/$(x) { allow read: if true; }')).allows[0]!.target).toBe('/a/{_interp1}')
  })
  it('ignores other services with a warning', () => {
    const e = expand(`service other.thing { match /a { allow read; } }`)
    expect(e.allows).toEqual([])
    expect(e.warnings).toEqual(['service other.thing is not Firestore or Storage; skipped'])
  })
  it('builds lexical scopes with wildcards and functions declared anywhere in a block', () => {
    const e = expand(fs('match /orgs/{orgId} { allow read: if f(); function f() { return true; } }'))
    const scope = e.allows[0]!.scope
    expect(scope.isWildcard('orgId')).toBe(true)
    expect(scope.isWildcard('database')).toBe(true)
    expect(scope.findFunction('f')?.decl.name).toBe('f')
  })
  it('gives one policy id per allow and op, disambiguating same-line duplicates', () => {
    const e = expand(fs('match /a/{id} {\n allow read: if true; allow get: if false;\n allow write; }'))
    expect(policyIds(e.allows)).toEqual([
      'firestore:/a/{id}#read@2', 'firestore:/a/{id}#list@2', 'firestore:/a/{id}#read@2:34',
      'firestore:/a/{id}#create@3', 'firestore:/a/{id}#update@3', 'firestore:/a/{id}#delete@3',
    ])
  })
})
```

(Adjust the `@2:34` column in the test to the actual column of the second `allow` on that line when writing it — compute it from the source string, e.g. `src.split('\n')[1].indexOf('allow get') + 1`.)

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement `scope.ts` and `expand.ts`.** **Step 4: Run tests + typecheck** → PASS.
- [ ] **Step 5: Commit** `feat(analyzer-firestore): expand match trees into allow sites`.

---

### Task 5: Values, comparisons, logic and `authenticated`

**Files:**
- Create: `packages/analyzer-firestore/src/value.ts`, `src/compare.ts`, `src/condition.ts`, `src/simplify.ts`
- Test: `packages/analyzer-firestore/test/condition.test.ts`, `test/simplify.test.ts`

**Interfaces:**
- Consumes: `Node` (Task 2), `Scope` (Task 4), core `Expr`, `Atom`, `Operand`, `Literal`, `OPERAND_PATTERN`, `TRUE`, `FALSE`.
- Produces:

```ts
// src/scope.ts additions
export interface Binding { node: Node; env: Env }          // a param or let, resolved lazily in its own env
export interface Env { scope: Scope; bindings: ReadonlyMap<string, Binding>; depth: number }
export const rootEnv = (scope: Scope): Env => ({ scope, bindings: new Map(), depth: 0 })

// src/value.ts
export type Value =
  | { kind: 'operand'; operand: string; auth: boolean; fallback?: { value: Literal } }  // fallback: from x.get('f', d)
  | { kind: 'literal'; value: Literal }
  | { kind: 'object'; name: 'request' | 'request.auth' | 'request.resource' | 'resource' | 'firestore' }
  | { kind: 'map'; prefix: string; auth: boolean }   // fields are operands `${prefix}.${field}`
  | { kind: 'doc'; path: string; auth: boolean }     // a get(P) result; `.data` gives map `doc(P)`
  | { kind: 'path'; path: string; auth: boolean }    // a document path in P' form
export interface NormalizeContext {
  store: 'firestore' | 'storage'
  src: string                                // the file's source, for opaque text
  recognizers: ReadonlyMap<string, string>   // zero-parameter function name -> vocabulary id
  functionsUsed: Set<string>
}
export function resolveValue(node: Node, env: Env, ctx: NormalizeContext): Value | undefined   // undefined = not representable

// src/condition.ts
export function normalizeCondition(node: Node, env: Env, ctx: NormalizeContext): Expr
export function opaque(node: Node, ctx: NormalizeContext): Expr  // { opaque: source text with whitespace collapsed to single spaces }

// src/simplify.ts
export function simplify(e: Expr): Expr
```

**`resolveValue` table** (Task 6 adds lookups, Task 7 adds calls):

| Node | Value |
|---|---|
| `string`, `int`, `float`, `bool`, `null` | `literal` |
| `unary -` on `int`/`float` literal | `literal` negative number |
| `list` whose items are all string or number literals | `literal` array; otherwise `undefined` |
| `ident request` / `resource` | `object` (only when not shadowed by a binding) |
| `ident` bound in `env.bindings` | `resolveValue(binding.node, binding.env, ctx)` |
| `ident` that is a wildcard in `env.scope` | `operand` `param.<name>`, `auth: false` |
| `request.auth` | `object request.auth` |
| `request.auth.uid` | `operand actor.uid`, `auth: true` |
| `request.auth.token` | `map actor.claim`, `auth: true` |
| `request.resource` | `object request.resource` |
| `request.resource.data` (Firestore) / `request.resource.metadata` (Storage) | `map incoming` |
| `resource.data` (Firestore) / `resource.metadata` (Storage) | `map resource` |
| `map.f`, `map['f']` | `operand <prefix>.f` |
| `operand.f`, `operand['f']` (no fallback) | `operand <operand>.f` |
| `x.get('f', d)` where `x` is a `map` or fallback-free `operand`, `d` a literal | `operand <prefix>.f` with `fallback: { value: d }` |
| anything else | `undefined` |

A resulting `operand` string must match core's `OPERAND_PATTERN`; if it does not (for example a field name with `-`), the value is `undefined`.

**`normalizeCondition` table:**

| Node | Expr |
|---|---|
| `bool true` / `false` | `TRUE` / `FALSE` |
| `a && b`, `a \|\| b` | `and` / `or` of the normalized sides |
| `!a` | `not` |
| `a ? b : c` | `or[and[a, b], and[not a, c]]` |
| `(request.auth) != null`, `null != request.auth` | `authenticated` |
| `request.auth == null`, `null == request.auth` | `not(authenticated)` |
| `a == b`, `!=`, `<`, `>`, `in` | `compare(...)` (below) |
| a bare value that resolves to an `operand` | `eq(operand, true)` (a rules condition must be a boolean, so this is exact) |
| anything else | `opaque` |

**`compare(op, left, right)`** (in `compare.ts`), with `l = resolveValue(left)`, `r = resolveValue(right)`:
1. Either side `undefined`, `object`, `map`, `doc` or `path` → `opaque` of the whole comparison node.
2. Both sides `literal` → `opaque` (not worth folding).
3. `in`: the right side must be a `literal` array or an `operand`; a non-array literal on the right → `opaque`. `in(left, right)`.
4. `==` → `eq`, `!=` → `ne`, `<` → `lt`, `>` → `gt`. `<=`, `>=`, `is` → `opaque`.
5. **Fallback** (a side from `x.get('f', d)`): if `d` is `null`, the fallback is the model's own absent value: drop it. Otherwise the other side must be a `literal` `L`, and both `holds(op, d, L)` and `holds(op, null, L)` must be false, else `opaque`. `holds` for `eq`: deep-equal; `ne`: not deep-equal; `in`: `L` is an array containing the value; `lt`/`gt`: both numbers and the comparison holds (otherwise false). Mirror the check when the fallback is on the right side of `eq`/`ne`.
6. **Auth:** if either side has `auth: true`, return `and[authenticated, atom]`.

**`simplify`**: flattens nested `and` into `and` and `or` into `or`; drops duplicate members (compare with core `canonicalJson` or `deepEqual`); unwraps single-member `and`/`or`; `not(not x)` → `x`. Never drops or folds `opaque`. `normalizeCondition` callers (Task 8) apply `simplify` once to the final condition.

- [ ] **Step 1: Write the failing tests.** First the shared helper `test/helpers/cond.ts` (parses a whole rules file, expands it, and normalizes the first allow's condition; `before` goes before the match, `inside` inside it before the allow):

```ts
import type { Expr } from '@holdline/core'
import { normalizeCondition } from '../../src/condition.js'
import { expandRules } from '../../src/expand.js'
import { parseRules } from '../../src/parser.js'
import { rootEnv } from '../../src/scope.js'
import { simplify } from '../../src/simplify.js'

export function cond(condition: string, opts: { store?: 'firestore' | 'storage'; before?: string; inside?: string; path?: string; recognizers?: Record<string, string> } = {}): Expr {
  const store = opts.store ?? 'firestore'
  const inner = `${opts.before ?? ''}\nmatch ${opts.path ?? '/things/{thingId}'} { ${opts.inside ?? ''}\n allow read: if ${condition}; }`
  const src = store === 'firestore'
    ? `service cloud.firestore { match /databases/{database}/documents { ${inner} } }`
    : `service firebase.storage { match /b/{bucket}/o { ${inner} } }`
  const r = parseRules(src)
  if (!r.ok) throw new Error(r.error.message)
  const site = expandRules(r.ast).allows[0]!
  const ctx = { store, src, recognizers: new Map(Object.entries(opts.recognizers ?? {})), functionsUsed: new Set<string>() }
  return simplify(normalizeCondition(site.allow.condition!, rootEnv(site.scope), ctx))
}
```

Then `test/condition.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { Expr } from '@holdline/core'
import { cond } from './helpers/cond.js'

const auth: Expr = { atom: { op: 'authenticated' } }
const atom = (a: object): Expr => ({ atom: a } as Expr)

describe('normalizeCondition: spec 4.4 rows', () => {
  it('request.auth != null is authenticated; == null is its negation', () => {
    expect(cond('request.auth != null')).toEqual(auth)
    expect(cond('null != request.auth')).toEqual(auth)
    expect(cond('request.auth == null')).toEqual({ not: auth })
  })
  it('request.auth.uid is actor.uid, with authenticated', () => {
    expect(cond('request.auth.uid == thingId')).toEqual({ and: [auth, atom({ op: 'eq', left: 'actor.uid', right: 'param.thingId' })] })
  })
  it('request.auth.token.k is actor.claim.k', () => {
    expect(cond('request.auth.token.admin == true')).toEqual({ and: [auth, atom({ op: 'eq', left: 'actor.claim.admin', right: { literal: true } })] })
    expect(cond('request.auth.token.firebase.sign_in_provider == "password"')).toMatchObject({ and: [auth, { atom: { left: 'actor.claim.firebase.sign_in_provider' } }] })
  })
  it('resource.data.f is resource.f; request.resource.data.f is incoming.f', () => {
    expect(cond(`resource.data.status == 'open'`)).toEqual(atom({ op: 'eq', left: 'resource.status', right: { literal: 'open' } }))
    expect(cond(`request.resource.data.status != 'x'`)).toEqual(atom({ op: 'ne', left: 'incoming.status', right: { literal: 'x' } }))
    expect(cond(`resource.data['status'] == 'open'`)).toEqual(atom({ op: 'eq', left: 'resource.status', right: { literal: 'open' } }))
  })
  it('Storage reads metadata', () => {
    expect(cond(`resource.metadata.owner == request.auth.uid`, { store: 'storage' }))
      .toEqual({ and: [auth, atom({ op: 'eq', left: 'resource.owner', right: 'actor.uid' })] })
    expect(cond(`request.resource.metadata.owner == 'a'`, { store: 'storage' })).toEqual(atom({ op: 'eq', left: 'incoming.owner', right: { literal: 'a' } }))
    expect(cond(`resource.data.owner == 'a'`, { store: 'storage' })).toEqual({ opaque: `resource.data.owner == 'a'` })
  })
  it('a path wildcard is param.x', () => {
    expect(cond(`thingId == 'a'`)).toEqual(atom({ op: 'eq', left: 'param.thingId', right: { literal: 'a' } }))
  })
  it('maps == != < > and in with a list', () => {
    expect(cond('resource.data.n < 3')).toEqual(atom({ op: 'lt', left: 'resource.n', right: { literal: 3 } }))
    expect(cond('resource.data.n > -1')).toEqual(atom({ op: 'gt', left: 'resource.n', right: { literal: -1 } }))
    expect(cond(`resource.data.s in ['a', 'b']`)).toEqual(atom({ op: 'in', left: 'resource.s', right: { literal: ['a', 'b'] } }))
    expect(cond(`request.auth.uid in resource.data.editors`)).toEqual({ and: [auth, atom({ op: 'in', left: 'actor.uid', right: 'resource.editors' })] })
  })
  it('maps && || ! true false and the ternary', () => {
    expect(cond('true')).toEqual({ and: [] })
    expect(cond('false')).toEqual({ or: [] })
    const a = atom({ op: 'eq', left: 'resource.a', right: { literal: 1 } })
    const b = atom({ op: 'eq', left: 'resource.b', right: { literal: 2 } })
    const c = atom({ op: 'eq', left: 'resource.c', right: { literal: 3 } })
    expect(cond('resource.data.a == 1 && resource.data.b == 2')).toEqual({ and: [a, b] })
    expect(cond('resource.data.a == 1 || resource.data.b == 2')).toEqual({ or: [a, b] })
    expect(cond('!(resource.data.a == 1)')).toEqual({ not: a })
    expect(cond('resource.data.a == 1 ? resource.data.b == 2 : resource.data.c == 3')).toEqual({ or: [{ and: [a, b] }, { and: [{ not: a }, c] }] })
  })
  it('a bare boolean field is eq true', () => {
    expect(cond('resource.data.published')).toEqual(atom({ op: 'eq', left: 'resource.published', right: { literal: true } }))
  })
  it('adds authenticated per atom, not to the whole condition', () => {
    expect(cond('resource.data.public == true || request.auth.uid == resource.data.owner')).toEqual({ or: [
      atom({ op: 'eq', left: 'resource.public', right: { literal: true } }),
      { and: [auth, atom({ op: 'eq', left: 'actor.uid', right: 'resource.owner' })] },
    ] })
    expect(cond('request.auth != null && request.auth.uid == thingId')).toEqual({ and: [auth, atom({ op: 'eq', left: 'actor.uid', right: 'param.thingId' })] })
  })
  it('x.get(f, d) is x.f only when d cannot satisfy the comparison', () => {
    expect(cond(`resource.data.get('role', '') == 'admin'`)).toEqual(atom({ op: 'eq', left: 'resource.role', right: { literal: 'admin' } }))
    expect(cond(`request.auth.token.get('admin', false) == true`)).toEqual({ and: [auth, atom({ op: 'eq', left: 'actor.claim.admin', right: { literal: true } })] })
    expect(cond(`resource.data.get('role', null) == resource.data.x`)).toEqual(atom({ op: 'eq', left: 'resource.role', right: 'resource.x' }))
    expect(cond(`resource.data.get('role', 'admin') == 'admin'`)).toEqual({ opaque: `resource.data.get('role', 'admin') == 'admin'` })
    expect(cond(`resource.data.get('role', '') != 'admin'`)).toEqual({ opaque: `resource.data.get('role', '') != 'admin'` })
    expect(cond(`resource.data.get('n', 5) > 3`)).toMatchObject({ opaque: expect.any(String) })
    expect(cond(`resource.data.get('n', 0) > 3`)).toEqual(atom({ op: 'gt', left: 'resource.n', right: { literal: 3 } }))
    expect(cond(`resource.data.get('r', '') == request.auth.uid`)).toMatchObject({ opaque: expect.any(String) })
  })
  it('everything else is opaque with its source text', () => {
    for (const src of [
      'request.time < resource.data.expires', 'resource.data.tags.size() > 0', `resource.data.keys().hasAny(['a'])`,
      `resource.data.name.matches('a.*')`, 'resource.data.n <= 3', 'resource.data.n >= 3', 'resource.data.n is int',
      `'f' in resource.data`, `resource.data.a == 1 + 1`, `{'a': 1} == resource.data.m`, `resource == null`,
    ]) {
      expect(cond(src)).toEqual({ opaque: src })
    }
  })
  it('opaque text collapses whitespace', () => {
    expect(cond('request.time <\n      resource.data.expires')).toEqual({ opaque: 'request.time < resource.data.expires' })
  })
})
```

`test/simplify.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { simplify } from '../src/simplify.js'

const A = { atom: { op: 'authenticated' } } as const
const B = { atom: { op: 'eq', left: 'resource.a', right: { literal: 1 } } } as const
const O = { opaque: 'x' }

describe('simplify', () => {
  it('flattens, dedupes and unwraps', () => {
    expect(simplify({ and: [A, { and: [A, B] }] })).toEqual({ and: [A, B] })
    expect(simplify({ or: [{ or: [B] }, B] })).toEqual(B)
    expect(simplify({ and: [{ and: [] }, B] })).toEqual(B)
    expect(simplify({ not: { not: B } })).toEqual(B)
  })
  it('keeps opaque and keeps true and false', () => {
    expect(simplify({ and: [O, O] })).toEqual({ and: [O, O] })
    expect(simplify({ and: [] })).toEqual({ and: [] })
    expect(simplify({ or: [] })).toEqual({ or: [] })
    expect(simplify({ and: [B, { or: [] }] })).toEqual({ and: [B, { or: [] }] })
  })
})
```

Note on the `and: [{ and: [] }, B]` case: flattening an empty `and` into its parent removes it (it is true), which is exact. Duplicate `opaque` members are kept (two different source sites may share text; keeping both is harmless and the summary counts them by text anyway).

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** `value.ts`, `compare.ts`, `condition.ts`, `simplify.ts`. Leave call nodes (`get`, `exists`, user functions) resolving to `undefined`/`opaque` for now; Tasks 6 and 7 add them.
- [ ] **Step 4: Run tests + typecheck** → PASS. **Step 5: Commit** `feat(analyzer-firestore): normalize operands, comparisons and logic`.

---

### Task 6: Lookups: `get`, `exists`, Storage's `firestore.*`, `getAfter`

**Files:**
- Create: `packages/analyzer-firestore/src/lookup-path.ts`
- Modify: `src/value.ts` (calls `get`), `src/condition.ts` (calls `exists`)
- Test: `packages/analyzer-firestore/test/lookup.test.ts`

**Interfaces:**
- Consumes: `resolveValue`, `normalizeCondition`, `Env`, `NormalizeContext`.
- Produces:

```ts
// src/lookup-path.ts
// P' for a document path node (a path literal, or anything resolving to one: a let, a param).
export function lookupPath(node: Node, env: Env, ctx: NormalizeContext): { path: string; auth: boolean } | undefined
```

`lookupPath` rules:
- The node must be a `path` literal (after following bindings: an `ident` bound to a path literal resolves through `resolveValue`, which returns a `path` value; `resolveValue` on a `path` node calls `lookupPath`).
- Segments 1–3 must be `databases`, any single segment (text like `(default)` or `$(database)`), `documents`. Remove them. Fewer than four segments, or a different prefix → `undefined`.
- Each remaining segment must be a single part. Text part: kept if it matches `^[^(){}/\s]+$`. Interp part: `resolveValue(expr)`:
  - `operand` without fallback whose string matches the placeholder form `actor.uid | actor.claim.* | resource.<f> | incoming.<f> | param.<x>` (`resource`/`incoming` one field deep, `param` no dots) → `{<operand>}`; `auth` accumulates.
  - `literal` string or number → its text (same character check as a text part).
  - anything else → `undefined`.
- The result must match the `doc(...)` path grammar of core (`parseLookup(`doc(${path}).x`)` returns a value); otherwise `undefined`.

Calls:

| Node | Firestore | Storage |
|---|---|---|
| `get(P)` | `resolveValue` → `doc` value | `undefined` |
| `firestore.get(P)` | `undefined` | `doc` value |
| `doc.data` | `map` with prefix `doc(<P'>)` | same |
| `doc(<P'>).f` operand | auth = the path's auth | same |
| `exists(P)` in a condition | `exists(P')` atom; `and[authenticated, …]` when the path holds `{actor.` | `opaque` |
| `firestore.exists(P)` | `opaque` | `exists(P')` |
| `getAfter(P)`, `existsAfter(P)`, `firestore.getAfter(P)`, `firestore.existsAfter(P)` | `undefined` / `opaque` | same |
| any lookup whose `lookupPath` is `undefined` | `undefined` / `opaque` | same |

`firestore` as an identifier resolves to `object firestore` only in Storage files (and only when not shadowed).

- [ ] **Step 1: Write the failing tests** (using `test/helpers/cond.ts` from Task 5):

```ts
import { describe, expect, it } from 'vitest'
import { cond } from './helpers/cond.js'

const auth = { atom: { op: 'authenticated' } }
const DB = '/databases/$(database)/documents'

describe('lookups', () => {
  it('get(P).data.f is doc(P\').f with placeholders for the caller, wildcards and fields', () => {
    expect(cond(`resource.data.orgId in get(${DB}/users/$(request.auth.uid)).data.orgIds`))
      .toEqual({ and: [auth, { atom: { op: 'in', left: 'resource.orgId', right: 'doc(/users/{actor.uid}).orgIds' } }] })
    expect(cond(`get(${DB}/orgs/$(thingId)).data.plan == 'pro'`))
      .toEqual({ atom: { op: 'eq', left: 'doc(/orgs/{param.thingId}).plan', right: { literal: 'pro' } } })
    expect(cond(`get(${DB}/orgs/$(resource.data.orgId)/members/$(request.auth.uid)).data.role == 'admin'`))
      .toEqual({ and: [auth, { atom: { op: 'eq', left: 'doc(/orgs/{resource.orgId}/members/{actor.uid}).role', right: { literal: 'admin' } } }] })
    expect(cond(`get(${DB}/orgs/$(request.resource.data.orgId)).data.open == true`))
      .toEqual({ atom: { op: 'eq', left: 'doc(/orgs/{incoming.orgId}).open', right: { literal: true } } })
  })
  it('get(P).data.get(f, d) follows the default rule', () => {
    expect(cond(`get(${DB}/orgs/$(thingId)).data.get('plan', 'free') == 'pro'`))
      .toEqual({ atom: { op: 'eq', left: 'doc(/orgs/{param.thingId}).plan', right: { literal: 'pro' } } })
  })
  it('exists(P) is exists(P\')', () => {
    expect(cond(`exists(${DB}/orgs/$(thingId)/members/$(request.auth.uid))`))
      .toEqual({ and: [auth, { atom: { op: 'exists', doc: '/orgs/{param.thingId}/members/{actor.uid}' } }] })
    expect(cond(`!exists(${DB}/banned/$(thingId))`)).toEqual({ not: { atom: { op: 'exists', doc: '/banned/{param.thingId}' } } })
  })
  it('literal segments and string interpolations stay literal', () => {
    expect(cond(`exists(${DB}/config/$('global'))`)).toEqual({ atom: { op: 'exists', doc: '/config/global' } })
  })
  it('Storage uses firestore.get and firestore.exists with (default)', () => {
    const DEF = '/databases/(default)/documents'
    expect(cond(`firestore.exists(${DEF}/orgs/$(orgId)/members/$(request.auth.uid))`, { store: 'storage', path: '/orgs/{orgId}/files/{f=**}' }))
      .toEqual({ and: [auth, { atom: { op: 'exists', doc: '/orgs/{param.orgId}/members/{actor.uid}' } }] })
    expect(cond(`firestore.get(${DEF}/orgs/$(orgId)).data.plan == 'pro'`, { store: 'storage', path: '/orgs/{orgId}/files/{f=**}' }))
      .toEqual({ atom: { op: 'eq', left: 'doc(/orgs/{param.orgId}).plan', right: { literal: 'pro' } } })
    expect(cond(`exists(${DEF}/orgs/$(orgId))`, { store: 'storage', path: '/orgs/{orgId}' })).toMatchObject({ opaque: expect.any(String) })
  })
  it('getAfter and existsAfter are opaque', () => {
    expect(cond(`getAfter(${DB}/a/$(thingId)).data.x == 1`)).toMatchObject({ opaque: expect.any(String) })
    expect(cond(`existsAfter(${DB}/a/$(thingId))`)).toMatchObject({ opaque: expect.any(String) })
  })
  it('a segment that cannot be an operand makes the lookup opaque', () => {
    for (const src of [
      `exists(${DB}/a/$(request.time))`,                      // not an operand
      `exists(${DB}/a/x$(thingId))`,                          // mixed segment
      `exists(${DB}/a/$(resource.data.a.b))`,                 // placeholder two fields deep
      `exists(/other/$(thingId))`,                            // no database prefix
      `get(${DB}/a/$(thingId)).id == 'x'`,                     // not .data
    ]) expect(cond(src)).toEqual({ opaque: src })
  })
})
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run tests + typecheck** → PASS.
- [ ] **Step 5: Commit** `feat(analyzer-firestore): map get and exists to lookups`.

---

### Task 7: Function inlining, `let`, recursion limit and vocabulary refs

**Files:**
- Create: `packages/analyzer-firestore/src/inline.ts`
- Modify: `src/value.ts`, `src/condition.ts`
- Test: `packages/analyzer-firestore/test/inline.test.ts`

**Interfaces:**
- Produces:

```ts
// src/inline.ts
export const MAX_INLINE_DEPTH = 20
// Resolves a call to a user-defined function: the function's return node and the env to read it in,
// with params bound to the call's arguments (in the caller's env) and lets bound in order.
export function inlineCall(call: Extract<Node, { type: 'call' }>, env: Env, ctx: NormalizeContext):
  | { kind: 'inline'; node: Node; env: Env; name: string }
  | { kind: 'ref'; id: string; name: string }       // zero-parameter function recognized by an approved vocabulary entry
  | { kind: 'too-deep' }
  | { kind: 'unknown' }                              // not a user function, or wrong argument count
```

Rules:
- Only calls whose callee is an `ident` are user-function calls. Look the name up with `env.scope.findFunction(name)`; not found or argument count differs → `unknown`.
- Zero parameters and `ctx.recognizers.has(name)` → `ref` (only in condition position; in value position a recognized function is still inlined).
- `env.depth + 1 > MAX_INLINE_DEPTH` → `too-deep` (the caller emits `opaque` of the call).
- New env: `scope` = the function's declaration scope (lexical), `depth` = caller depth + 1, `bindings` = param → `{ node: arg, env: callerEnv }`; then each `let` in order → `{ node: let.value, env: <env so far> }` (a later let sees params and earlier lets). Bindings shadow wildcards and globals (`request`, `resource`, `firestore`).
- Record `name` in `ctx.functionsUsed` for both `inline` and `ref`.
- `normalizeCondition` on a call: `ref` → `{ ref: id }`; `inline` → `normalizeCondition(node, env)`; `too-deep`/`unknown` → falls through to `get`/`exists` handling (Task 6) or `opaque`.
- `resolveValue` on a call: `inline` (ignore `ref`, inline instead) → `resolveValue(node, env)`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest'
import { cond } from './helpers/cond.js'

const auth = { atom: { op: 'authenticated' } }
const DB = '/databases/$(database)/documents'

describe('function inlining', () => {
  it('inlines a parameterized function with arguments substituted', () => {
    const before = `function isMember(orgId) { return exists(${DB}/orgs/$(orgId)/members/$(request.auth.uid)); }`
    expect(cond('isMember(resource.data.orgId)', { before }))
      .toEqual({ and: [auth, { atom: { op: 'exists', doc: '/orgs/{resource.orgId}/members/{actor.uid}' } }] })
  })
  it('substitutes lets in order, after params', () => {
    const before = `function inOrgs(orgId) { let user = get(${DB}/users/$(request.auth.uid)); let ids = user.data.orgIds; return orgId in ids; }`
    expect(cond('inOrgs(resource.data.orgId)', { before }))
      .toEqual({ and: [auth, { atom: { op: 'in', left: 'resource.orgId', right: 'doc(/users/{actor.uid}).orgIds' } }] })
  })
  it('resolves names lexically: a param shadows a wildcard of the same name', () => {
    const before = `function owns(thingId) { return request.auth.uid == thingId; }`
    expect(cond(`owns(resource.data.owner)`, { before })).toEqual({ and: [auth, { atom: { op: 'eq', left: 'actor.uid', right: 'resource.owner' } }] })
  })
  it('a function body sees wildcards of the match it is declared in', () => {
    expect(cond('isMine()', { inside: 'function isMine() { return request.auth.uid == thingId; }' }))
      .toEqual({ and: [auth, { atom: { op: 'eq', left: 'actor.uid', right: 'param.thingId' } }] })
  })
  it('inlines functions that call functions, and functions in value position', () => {
    const before = `function uid() { return request.auth.uid; } function me(x) { return x == uid(); }`
    expect(cond('me(thingId)', { before })).toEqual({ and: [auth, { atom: { op: 'eq', left: 'param.thingId', right: 'actor.uid' } }] })
  })
  it('turns runaway recursion into opaque', () => {
    expect(cond('f()', { before: 'function f() { return f(); }' })).toEqual({ opaque: 'f()' })
  })
  it('an unknown function or wrong arity is opaque', () => {
    expect(cond('nope()')).toEqual({ opaque: 'nope()' })
    expect(cond('f(1, 2)', { before: 'function f(a) { return a == 1; }' })).toEqual({ opaque: 'f(1, 2)' })
  })
  it('a zero-parameter function named by an approved recognizer becomes a ref', () => {
    const before = 'function signedIn() { return request.auth != null; }'
    expect(cond('signedIn() && resource.data.a == 1', { before, recognizers: { signedIn: 'signed-in' } }))
      .toEqual({ and: [{ ref: 'signed-in' }, { atom: { op: 'eq', left: 'resource.a', right: { literal: 1 } } }] })
  })
  it('functions with parameters are inlined even when a recognizer names them', () => {
    const before = 'function isOwner(u) { return request.auth.uid == u; }'
    expect(cond(`isOwner('x')`, { before, recognizers: { isOwner: 'owner' } }))
      .toEqual({ and: [auth, { atom: { op: 'eq', left: 'actor.uid', right: { literal: 'x' } } }] })
  })
})
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement `inline.ts` and wire it in.** **Step 4: Run tests + typecheck** → PASS.
- [ ] **Step 5: Commit** `feat(analyzer-firestore): inline rules functions and recognize vocabulary`.

---

### Task 8: The analyzer: discovery, per-file facts, cache, registration

**Files:**
- Create: `packages/analyzer-firestore/src/discover.ts`, `src/analyze-file.ts`, `src/analyzer.ts`; fill `src/index.ts`
- Modify: `packages/cli/src/analyzers.ts`, `packages/cli/package.json`
- Test: `packages/analyzer-firestore/test/discover.test.ts`, `test/analyzer.test.ts`

**Interfaces:**
- Produces:

```ts
// src/discover.ts
export interface Discovery { files: string[]; warnings: { file: string; message: string }[] }
export async function discoverRulesFiles(root: string, files: readonly string[], config: HoldlineConfig): Promise<Discovery>

// src/analyze-file.ts
export function analyzeRulesFile(file: string, src: string, recognizers: readonly AnalyzerRecognizer[]): AnalyzerOutput

// src/analyzer.ts
export const ANALYZER_NAME = 'firestore'
export const ANALYZER_VERSION = '0.1.0'
export const firestoreAnalyzer: Analyzer

// src/index.ts
export { firestoreAnalyzer } from './analyzer.js'
export { parseRules } from './parser.js'
export { analyzeRulesFile } from './analyze-file.js'
```

**Discovery** (spec 4.1):
- Firestore candidates: if `config.firestore?.rules` is set → `matchFiles(files, globs)` (no match → warning `{ file: '.holdline/config.yaml', message: 'firestore.rules globs match no file' }`). Otherwise: `firestore.rules` at the root if in `files`, plus every `firebase.json` in `files` (any depth): its `firestore` key, either `{ rules: string }` or an array of `{ rules: string }` (multi-database).
- Storage candidates: the same with `config.storage?.rules`, root `storage.rules`, and `firebase.json`'s `storage` key: `{ rules }` or an array of `{ rules }`.
- A `firebase.json` path is resolved against that file's directory (`posix.normalize(posix.join(dirname, rules))`); a result outside the repo (starts with `..`) or not in `files` → warning `{ file: <firebase.json>, message: 'points at <path>, which is not in the repository' }`. Invalid JSON → warning `{ file, message: 'invalid JSON: …' }` (it is not a rules file; never an error).
- Result: sorted, deduplicated union. Which store a file is comes from its `service` block, not from where it was found.
- `detect` returns true when the discovery has files or warnings, or when either config section sets `rules`.

**Per file** (`analyzeRulesFile`):
- `parseRules(src)`; on error → `diagnostics: [{ analyzer: 'firestore', file, severity: 'error', message: 'line L, column C: <message>' }]`, no policies, no symbols.
- `expandRules(ast)`; each warning → `{ severity: 'warning', file, message }`. A file with no `service` block → warning `no service block`.
- For each allow site: `condition` = `allow.condition ? simplify(normalizeCondition(...)) : TRUE`; `ctx.recognizers` = map from every `firestore-function` name in `recognizers` to its entry id (the first entry wins on duplicates). One policy per op: `{ id, store, target, ops: [op], condition, functions: [...functionsUsed].sort(), evidence: { file, line: allow.line } }` with ids from `policyIds`.
- Symbols: one per `MatchSite`: `{ id: '<store>:<target>', kind: 'match', lang: store, location: { file, line } }`. When two files declare the same match id, both are emitted (mergeFacts does not dedupe; first location wins in the index).

**Cache** (`analyze`): per file, `ctx.cache.get('firestore', ANALYZER_VERSION, key)` with `key = JSON.stringify({ file, recognizers: ctx.recognizers }) + '\0' + content`; on miss, compute and `set`. Read errors (file vanished) → error diagnostic `could not read: <message>`.

- [ ] **Step 1: Write the failing tests**

`test/discover.test.ts` — use a temp dir (`mkdtemp`) with real files:
```ts
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { discoverRulesFiles } from '../src/discover.js'

async function repo(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'holdline-fs-'))
  for (const [p, c] of Object.entries(files)) {
    await mkdir(dirname(join(root, p)), { recursive: true })
    await writeFile(join(root, p), c)
  }
  return { root, files: Object.keys(files).sort() }
}

describe('discoverRulesFiles', () => {
  it('finds root rules files', async () => {
    const r = await repo({ 'firestore.rules': '', 'storage.rules': '' })
    expect(await discoverRulesFiles(r.root, r.files, {})).toEqual({ files: ['firestore.rules', 'storage.rules'], warnings: [] })
  })
  it('follows firebase.json at any depth, including arrays', async () => {
    const r = await repo({
      'app/firebase.json': JSON.stringify({ firestore: { rules: 'rules/db.rules' }, storage: [{ bucket: 'a', rules: 'st.rules' }] }),
      'app/rules/db.rules': '', 'app/st.rules': '',
    })
    expect((await discoverRulesFiles(r.root, r.files, {})).files).toEqual(['app/rules/db.rules', 'app/st.rules'])
  })
  it('warns about a firebase.json that points at a missing file or is invalid', async () => {
    const r = await repo({ 'firebase.json': JSON.stringify({ firestore: { rules: 'gone.rules' } }), 'x/firebase.json': '{' })
    const d = await discoverRulesFiles(r.root, r.files, {})
    expect(d.files).toEqual([])
    expect(d.warnings).toEqual([
      { file: 'firebase.json', message: 'points at gone.rules, which is not in the repository' },
      { file: 'x/firebase.json', message: expect.stringMatching(/^invalid JSON/) },
    ])
  })
  it('uses config globs instead of defaults for that store only', async () => {
    const r = await repo({ 'firestore.rules': '', 'storage.rules': '', 'db/main.rules': '' })
    expect((await discoverRulesFiles(r.root, r.files, { firestore: { rules: ['db/*.rules'] } })).files).toEqual(['db/main.rules', 'storage.rules'])
    expect((await discoverRulesFiles(r.root, r.files, { storage: { rules: ['nothing/*.rules'] } })).warnings)
      .toEqual([{ file: '.holdline/config.yaml', message: 'storage.rules globs match no file' }])
  })
})
```

`test/analyzer.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { FileCache, scan } from '@holdline/core'
import { analyzeRulesFile } from '../src/analyze-file.js'
import { firestoreAnalyzer } from '../src/analyzer.js'
// plus the `repo` helper from discover.test.ts, moved to test/helpers/repo.ts

const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function signedIn() { return request.auth != null; }
    match /notes/{noteId} {
      allow read: if signedIn() && resource.data.owner == request.auth.uid;
      allow delete: if false;
    }
  }
}`

describe('analyzeRulesFile', () => {
  it('emits one policy per allow and op, match symbols and evidence', () => {
    const out = analyzeRulesFile('firestore.rules', RULES, [])
    expect(out.policies).toEqual([
      expect.objectContaining({ id: 'firestore:/notes/{noteId}#read@6', store: 'firestore', target: '/notes/{noteId}', ops: ['read'], functions: ['signedIn'], evidence: { file: 'firestore.rules', line: 6 } }),
      expect.objectContaining({ id: 'firestore:/notes/{noteId}#list@6', ops: ['list'] }),
      expect.objectContaining({ id: 'firestore:/notes/{noteId}#delete@7', condition: { or: [] } }),
    ])
    expect(out.policies![0]!.condition).toEqual({ and: [{ atom: { op: 'authenticated' } }, { atom: { op: 'eq', left: 'resource.owner', right: 'actor.uid' } }] })
    expect(out.symbols).toEqual([
      { id: 'firestore:/', kind: 'match', lang: 'firestore', location: { file: 'firestore.rules', line: 3 } },
      { id: 'firestore:/notes/{noteId}', kind: 'match', lang: 'firestore', location: { file: 'firestore.rules', line: 5 } },
    ])
  })
  it('uses approved recognizers for zero-parameter functions', () => {
    const out = analyzeRulesFile('firestore.rules', RULES, [{ id: 'signed-in', recognize: [{ 'firestore-function': 'signedIn' }] }])
    expect(out.policies![0]!.condition).toEqual({ and: [{ ref: 'signed-in' }, { atom: { op: 'authenticated' } }, { atom: { op: 'eq', left: 'resource.owner', right: 'actor.uid' } }] })
  })
  it('turns a parse error into one error diagnostic and no policies', () => {
    const out = analyzeRulesFile('firestore.rules', 'service cloud.firestore {\n  match /a {\n    allow reed;\n  }\n}', [])
    expect(out.policies ?? []).toEqual([])
    expect(out.diagnostics).toEqual([{ analyzer: 'firestore', file: 'firestore.rules', severity: 'error', message: expect.stringMatching(/^line 3, column 11: unknown operation 'reed'/) }])
  })
  it('emits Storage policies with storage ids', () => {
    const out = analyzeRulesFile('storage.rules', `service firebase.storage { match /b/{bucket}/o { match /u/{uid}/{f=**} { allow write: if request.auth.uid == uid; } } }`, [])
    expect(out.policies!.map(p => p.id)).toEqual(['storage:/u/{uid}/{f=**}#create@1', 'storage:/u/{uid}/{f=**}#update@1', 'storage:/u/{uid}/{f=**}#delete@1'])
    expect(out.symbols!.map(s => [s.id, s.lang])).toContainEqual(['storage:/u/{uid}/{f=**}', 'storage'])
  })
})

describe('firestoreAnalyzer through scan', () => {
  it('detects and scans a project, producing valid facts', async () => {
    const r = await repo({ 'firestore.rules': RULES })
    const { facts, ran } = await scan(r.root, [firestoreAnalyzer])
    expect(ran).toEqual(['firestore'])
    expect(facts.policies).toHaveLength(3)
    expect(facts.diagnostics).toEqual([])
  })
  it('does not run without rules files or config', async () => {
    const r = await repo({ 'README.md': '' })
    expect((await scan(r.root, [firestoreAnalyzer])).ran).toEqual([])
  })
  it('caches by path, content and recognizers', async () => {
    const r = await repo({ 'firestore.rules': RULES })
    await scan(r.root, [firestoreAnalyzer])
    const again = await scan(r.root, [firestoreAnalyzer], { recognizers: [{ id: 'signed-in', recognize: [{ 'firestore-function': 'signedIn' }] }] })
    expect(again.facts.policies[0]!.condition).toMatchObject({ and: [{ ref: 'signed-in' }] })
  })
})
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement `discover.ts`, `analyze-file.ts`, `analyzer.ts`, `index.ts`.**
- [ ] **Step 4: Register in the CLI.** `packages/cli/package.json` dependencies: add `"@holdline/analyzer-firestore": "workspace:*"`; `pnpm install`. `packages/cli/src/analyzers.ts`:
```ts
import type { Analyzer } from '@holdline/core'
import { firestoreAnalyzer } from '@holdline/analyzer-firestore'

// Phase 1 and 2 analyzer packages register here.
export const analyzers: Analyzer[] = [firestoreAnalyzer]
```
- [ ] **Step 5: Run `pnpm test` and `pnpm typecheck`.** The step-0 test `runs scan and check on an unpatched skeleton` still passes here (golden-firebase is still a skeleton). → PASS.
- [ ] **Step 6: Commit** `feat(analyzer-firestore): add the analyzer and register it`.

---

### Task 9: Soundness tests (model and emulator)

**Files:**
- Create: `packages/analyzer-firestore/test/helpers/interpret.ts`, `test/helpers/eval-expr.ts`, `test/helpers/rows.ts`, `test/soundness.test.ts`, `test/emulator/soundness.emulator.test.ts`, `test/emulator/emulator.ts`
- Modify: `packages/analyzer-firestore/package.json` (devDependencies `fast-check` is at the root already; add `@firebase/rules-unit-testing` `^5` or the current major and `firebase` `^12` or the current major — check `pnpm view` for the latest versions)

**Interfaces:**

```ts
// test/helpers/rows.ts — one row per normalization rule in spec 4.4 plus the generic additions
export interface Row { name: string; store: 'firestore' | 'storage'; condition: string; before?: string }
export const ROWS: Row[]

// The model world the interpreter, the evaluator and the emulator all use.
export interface World {
  actor: null | { uid: string; claims: Record<string, unknown> }
  params: Record<string, string>                       // wildcard values, e.g. { thingId: 't1' }
  resource: Record<string, unknown> | undefined        // stored record (undefined: no document)
  incoming: Record<string, unknown> | undefined        // request.resource.data / metadata
  docs: Record<string, Record<string, unknown>>        // other documents by concrete path ('/users/u1')
}

// test/helpers/interpret.ts
// Evaluates a rules AST condition with Firestore semantics: missing fields, null request.auth
// dereferences and type mismatches are errors; `&&`/`||` absorb errors as Firestore does
// (false && error = false, true || error = true); `!error` and comparisons with error are errors.
export type R = boolean | 'error' | unknown
export function interpret(row: Row, w: World): boolean | 'error'

// test/helpers/eval-expr.ts
// Evaluates a Holdline Expr: absent fields are null; atoms with an actor operand, an `{actor.` path,
// or an unresolvable lookup are false for an anonymous caller; `opaque` returns undefined (unknown).
export function evalExpr(e: Expr, w: World, vocab?: ReadonlyMap<string, Expr>): boolean | undefined
```

ROWS (each normalization rule, with invented collection and field names): `request.auth != null`; `request.auth == null`; `request.auth.uid == thingId`; `request.auth.token.admin == true`; `resource.data.status == 'open'`; `request.resource.data.status in ['a', 'b']`; `thingId == 'x'`; `get(...users/$(request.auth.uid)).data.orgIds` with `in`; `exists(...orgs/$(thingId)/members/$(request.auth.uid))`; `resource.data.get('role', '') == 'admin'`; `resource.data.n < 3`; `resource.data.n > 3`; `resource.data.a == 1 && resource.data.b == 2`; `resource.data.a == 1 || request.auth.uid == resource.data.owner`; `!(resource.data.a == 1)`; `!(request.auth.uid == resource.data.owner)` (negation over an error: the case that would break a whole-condition `authenticated`); `resource.data.a == 1 ? request.auth != null : false`; `true`; `false`; a function with params and a let; `resource.data.published` (bare boolean); Storage `resource.metadata.owner == request.auth.uid` and `firestore.exists(...)`.

**Soundness property** (`test/soundness.test.ts`), per row with fast-check (200 runs each): generate a `World` from a small domain (uids `u1`,`u2`, actor sometimes null, claims `{ admin: true|false|missing }`, field values from `'open' | 'a' | 'b' | 'admin' | '' | 1 | 2 | 3 | true | false | null | missing`, lists of those, and `docs` at the paths the row reads, sometimes missing). Compute `expr = normalize(row)` with the real analyzer (`analyzeRulesFile` on a file built from the row), then:
```ts
const fs = interpret(row, w)
const h = evalExpr(expr, w)
if (fs === true) expect(h).not.toBe(false)   // h undefined (opaque somewhere) is allowed
```
Also assert, per row, that the expression is not entirely `opaque` (each row is a row the normalizer maps), so the test exercises the mapping.

**Emulator test** (`test/emulator/soundness.emulator.test.ts`), describe name `@emulator soundness against the Firestore emulator`:
- `emulator.ts` exports `startEmulator(): Promise<{ host: string; port: number; stop(): Promise<void> } | { skip: string }>`: skip with a message when `firebase --version` fails (`firebase-tools not installed`), when `java -version` fails or its major version is below 21 (`Java 21 or newer is required by firebase-tools`), or when `FIRESTORE_EMULATOR_HOST` is set use it directly. Otherwise spawn `firebase emulators:start --only firestore --project demo-holdline` in a temp dir whose `firebase.json` sets `emulators.firestore.port` to a free port and `emulators.ui.enabled: false`; wait (up to 60 s) until the port accepts connections.
- `const emu = await startEmulator()` at module top level; `describe.skipIf('skip' in emu)(...)`; when skipped, also `console.warn` the reason once.
- Per Firestore row: `initializeTestEnvironment({ projectId: 'demo-holdline', firestore: { host, port, rules } })` where `rules` is the row's file with the condition on `match /things/{thingId}` under `allow read` (and a second variant on `allow create` for rows that read `request.resource`); for 30 worlds from a fixed-seed fast-check sample: `clearFirestore`, seed `resource` at `/things/t1` and `docs` with `withSecurityRulesDisabled`, then `getDoc` (or `setDoc` with `incoming` for create rows) as `authenticatedContext(uid, claims)` or `unauthenticatedContext()`; `allowed` = the call succeeded. Assert `allowed ⇒ evalExpr(expr, w) !== false`.
- Storage rows are model-only (the Storage emulator needs a second service); note that in the As built.

- [ ] **Step 1: Write `rows.ts`, `interpret.ts`, `eval-expr.ts` and `soundness.test.ts`.** The interpreter supports exactly the AST subset in ROWS plus lookups (`get`, `exists`, `firestore.*`), user functions (reuse the parser's AST; inline at evaluation time) and the methods `get(k, d)`. Unsupported nodes throw (a bug in the row list, not a pass).
- [ ] **Step 2: Run** `pnpm vitest run packages/analyzer-firestore/test/soundness.test.ts` → PASS (the normalizer exists). If a row fails, the normalizer is unsound for it: fix the normalizer, add a unit test for the minimal counterexample, and rerun.
- [ ] **Step 3: Self-check the property catches unsoundness**: temporarily change the analyzer to AND `authenticated` onto the whole condition (the spec's original wording) and confirm the `resource.data.a == 1 || request.auth.uid == resource.data.owner` row fails with an anonymous world where `a == 1`; revert.
- [ ] **Step 4: Add dev dependencies, write `emulator.ts` and the emulator test.** Run `pnpm vitest run packages/analyzer-firestore/test/emulator` → skipped locally with the Java message if Java < 21 (expected on this machine); the suite must not fail.
- [ ] **Step 5: `pnpm test && pnpm typecheck`** → PASS.
- [ ] **Step 6: Commit** `test(analyzer-firestore): soundness against a rules model and the emulator`.

---

### Task 10: Scan summary line

**Files:**
- Create: `packages/cli/src/format/policy-summary.ts`
- Modify: `packages/cli/src/commands/scan.ts`
- Test: `packages/cli/test/policy-summary.test.ts`

**Interfaces:**

```ts
// Per Firestore or Storage rules file (policies grouped by evidence.file, sorted by file):
//   <file>: <n> policies, <k> opaque sub-conditions
//     opaque: <text> (lines 12, 30)
// Opaque sub-conditions are distinct (allow line, text) pairs, so `allow read` (read and list policies)
// counts each once. Texts longer than 120 characters are cut to 119 and end with `…`.
export function policySummary(facts: Facts): string   // '' when there are no firestore/storage policies
```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { emptyFacts, type Facts, type Policy } from '@holdline/core'
import { policySummary } from '../src/format/policy-summary.js'

const pol = (id: string, file: string, line: number, condition: Policy['condition'], store: Policy['store'] = 'firestore'): Policy =>
  ({ id, store, target: '/a/{b}', ops: ['read'], condition, functions: [], evidence: { file, line } })

describe('policySummary', () => {
  it('counts policies and distinct opaque sub-conditions per rules file', () => {
    const facts: Facts = { ...emptyFacts(), policies: [
      pol('p1', 'firestore.rules', 3, { and: [{ opaque: 'request.time < x' }, { atom: { op: 'authenticated' } }] }),
      pol('p2', 'firestore.rules', 3, { and: [{ opaque: 'request.time < x' }, { atom: { op: 'authenticated' } }] }),
      pol('p3', 'firestore.rules', 9, { not: { opaque: 'request.time < x' } }),
      pol('p4', 'storage.rules', 2, { and: [] }, 'storage'),
      pol('p5', 'db.sql', 1, { opaque: 'ignored' }, 'pg-rls'),
    ] }
    expect(policySummary(facts)).toBe([
      'firestore.rules: 3 policies, 2 opaque sub-conditions',
      '  opaque: request.time < x (lines 3, 9)',
      'storage.rules: 1 policy, 0 opaque sub-conditions',
      '',
    ].join('\n'))
  })
  it('is empty without Firestore or Storage policies', () => {
    expect(policySummary(emptyFacts())).toBe('')
  })
  it('cuts long opaque text', () => {
    const long = 'x'.repeat(200)
    const out = policySummary({ ...emptyFacts(), policies: [pol('p', 'f.rules', 1, { opaque: long })] })
    expect(out).toContain(`  opaque: ${'x'.repeat(119)}… (line 1)`)
  })
})
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**; in `scan.ts` print `policySummary(facts)` right after the existing `Scanned with …` line.
- [ ] **Step 4: Add a CLI test** in the same file: `makeProject({ 'firestore.rules': <a file with one opaque condition> })`, `runCli(['scan'])`, expect stdout to contain `firestore.rules: 2 policies, 1 opaque sub-condition`. (Singular: `1 policy`, `1 opaque sub-condition`.)
- [ ] **Step 5: `pnpm test && pnpm typecheck`** → PASS. **Step 6: Commit** `feat(cli): summarize Firestore and Storage policies after scan`.

---

### Task 11: `examples/golden-firebase`

**Files:**
- Modify: `examples/golden-firebase/firestore.rules`, `storage.rules`, `expected-rules.yaml`, `README.md`
- Create: `examples/golden-firebase/breakages/R-001.patch` … `R-011.patch`; delete `breakages/.gitkeep`
- Modify: `packages/cli/test/golden-patch.test.ts` (the skeleton test builds its own skeleton)

- [ ] **Step 1: Point the skeleton test at its own skeleton.** In `golden-patch.test.ts`, the test `runs scan and check on an unpatched skeleton` asserts `summary.rules === 0` on `golden-firebase`, which stops being a skeleton. Replace its app with a temp folder holding `expected-rules.yaml` = `version: 1\nvocabulary: []\nrules: []\n` and a `firestore.rules` with an empty `service cloud.firestore {}` (write it with `mkdtemp` + `writeFile` in the test). Run it → PASS.

- [ ] **Step 2: Write the rules.** `examples/golden-firebase/firestore.rules`:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function signedIn() {
      return request.auth != null;
    }

    // The caller's organizations are listed on their user document.
    function inUserOrgs(orgId) {
      let user = get(/databases/$(database)/documents/users/$(request.auth.uid));
      return orgId in user.data.orgIds;
    }

    function isOrgAdmin(orgId) {
      return get(/databases/$(database)/documents/orgs/$(orgId)/members/$(request.auth.uid)).data.role == 'admin';
    }

    function validProject() {
      return request.resource.data.orgId != null
        && request.resource.data.status in ['active', 'archived'];
    }

    match /users/{uid} {
      allow read: if signedIn() && request.auth.uid == uid;
    }

    match /orgs/{orgId} {
      match /members/{uid} {
        allow read: if exists(/databases/$(database)/documents/orgs/$(orgId)/members/$(request.auth.uid));
      }
    }

    match /projects/{projectId} {
      allow read: if signedIn() && inUserOrgs(resource.data.orgId);
      allow create: if signedIn() && inUserOrgs(request.resource.data.orgId) && validProject();
      allow update: if isOrgAdmin(resource.data.orgId) && validProject();

      match /notes/{noteId} {
        allow read: if signedIn()
          && inUserOrgs(get(/databases/$(database)/documents/projects/$(projectId)).data.orgId);
      }
    }
  }
}
```

`examples/golden-firebase/storage.rules`:
```
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    function isMember(orgId) {
      return firestore.exists(/databases/(default)/documents/orgs/$(orgId)/members/$(request.auth.uid));
    }

    match /orgs/{orgId}/files/{path=**} {
      allow read: if isMember(orgId);
      allow write: if isMember(orgId) && request.resource.size < 10 * 1024 * 1024;
    }
  }
}
```

- [ ] **Step 3: Write `expected-rules.yaml`** with one vocabulary entry and eleven rules. Each rule has `status: approved` and a placeholder `approved: { by: golden, at: 2026-10-21, hash: x }`; Step 4 stamps the real hashes.

```yaml
version: 1
vocabulary:
  - id: signed-in
    text: The caller is signed in
    expr: { atom: { op: authenticated } }
    recognize: [{ firestore-function: signedIn }]
    approved: { by: golden, at: 2026-10-21, hash: x }
rules:
  - id: R-001
    text: Projects are read only by members of the project's organization
    type: data-access
    target: { store: firestore, path: "/projects/{projectId}" }
    ops: [read, list]
    requires:
      and:
        - ref: signed-in
        - atom: { op: in, left: resource.orgId, right: "doc(/users/{actor.uid}).orgIds" }
    evidence: ["firestore:/projects/{projectId}"]
  - id: R-002
    text: Projects are created only in the caller's own organizations
    type: data-access
    target: { store: firestore, path: "/projects/{projectId}" }
    ops: [create]
    requires:
      atom: { op: in, left: incoming.orgId, right: "doc(/users/{actor.uid}).orgIds" }
    evidence: ["firestore:/projects/{projectId}"]
  - id: R-003
    text: Only organization admins update projects
    type: data-access
    target: { store: firestore, path: "/projects/{projectId}" }
    ops: [update]
    requires:
      atom: { op: eq, left: "doc(/orgs/{resource.orgId}/members/{actor.uid}).role", right: { literal: admin } }
    evidence: ["firestore:/projects/{projectId}"]
  - id: R-004
    text: Clients never delete projects
    type: data-access
    target: { store: firestore, path: "/projects/{projectId}" }
    ops: [delete]
    requires: { or: [] }
    evidence: ["firestore:/projects/{projectId}"]
  - id: R-005
    text: Organization files are read only by organization members
    type: data-access
    target: { store: storage, path: "/orgs/{orgId}/files/{path=**}" }
    ops: [read, list]
    requires:
      atom: { op: exists, doc: "/orgs/{param.orgId}/members/{actor.uid}" }
    evidence: ["storage:/orgs/{orgId}/files/{path=**}"]
  - id: R-006
    text: Every project belongs to an organization
    type: invariant
    target: { store: firestore, path: "/projects/{projectId}" }
    kind: not-null
    columns: [orgId]
    evidence: ["firestore:/projects/{projectId}"]
  - id: R-007
    text: A project is active or archived
    type: invariant
    target: { store: firestore, path: "/projects/{projectId}" }
    kind: enum
    columns: [status]
    values: [active, archived]
    evidence: ["firestore:/projects/{projectId}"]
  - id: R-008
    text: Project notes are read only by members of the project's organization
    type: data-access
    target: { store: firestore, path: "/projects/{projectId}/notes/{noteId}" }
    ops: [read, list]
    requires:
      and:
        - ref: signed-in
        - atom: { op: in, left: "doc(/projects/{param.projectId}).orgId", right: "doc(/users/{actor.uid}).orgIds" }
    evidence: ["firestore:/projects/{projectId}/notes/{noteId}"]
  - id: R-009
    text: An organization's member list is read only by its members
    type: data-access
    target: { store: firestore, path: "/orgs/{orgId}/members/{uid}" }
    ops: [read, list]
    requires:
      atom: { op: exists, doc: "/orgs/{param.orgId}/members/{actor.uid}" }
    evidence: ["firestore:/orgs/{orgId}/members/{uid}"]
  - id: R-010
    text: Users read only their own user document
    type: data-access
    target: { store: firestore, path: "/users/{uid}" }
    ops: [read, list]
    requires:
      and:
        - atom: { op: authenticated }
        - atom: { op: eq, left: actor.uid, right: param.uid }
    evidence: ["firestore:/users/{uid}"]
  - id: R-011
    text: Organization files are written only by organization members
    type: data-access
    target: { store: storage, path: "/orgs/{orgId}/files/{path=**}" }
    ops: [create, update, delete]
    requires:
      atom: { op: exists, doc: "/orgs/{param.orgId}/members/{actor.uid}" }
    evidence: ["storage:/orgs/{orgId}/files/{path=**}"]
lastRuleId: 11
```
(Add `status: approved` and `approved: { by: golden, at: 2026-10-21, hash: x }` to every rule.)

- [ ] **Step 4: Stamp hashes**: `pnpm tsx scripts/approve-fixture.ts examples/golden-firebase/expected-rules.yaml`. Expect `stamped 11 rules and 1 vocabulary entries`.
- [ ] **Step 5: Check the clean app**: copy the app to a temp dir as `holdline.rules` and run `pnpm holdline scan` and `pnpm holdline check --strict` from it (or run the golden-patch suite once breakages exist). Every rule must be `pass`. If one is not, fix the app or the analyzer (with a unit test), not the rule.
- [ ] **Step 6: Write the eleven breakages.** Make each in a scratch git repo so the diff paths are app-relative:
```bash
scratch=$(mktemp -d) && cp -R examples/golden-firebase/. "$scratch" && cd "$scratch" && rm -rf breakages && git init -q && git add -A && git -c user.name=x -c user.email=x@x commit -qm base
# edit firestore.rules or storage.rules for one breakage, then:
git diff > <worktree>/examples/golden-firebase/breakages/R-00N.patch && git checkout -- .
```

| Patch | Edit | Only this rule fails because |
|---|---|---|
| R-001 | `allow read: if signedIn() && get(/databases/$(database)/documents/users/$(request.auth.uid)).data.orgIds.hasAny([resource.data.ownerOrg]);` | `hasAny` is opaque, so the read and list policies no longer prove the `in` lookup |
| R-002 | `allow create: if signedIn() && validProject();` | create no longer requires the caller's organizations; validProject keeps R-006 and R-007 |
| R-003 | `isOrgAdmin` body becomes `return request.auth != null;` | only update uses `isOrgAdmin` |
| R-004 | add `allow delete: if isOrgAdmin(resource.data.orgId);` under `/projects/{projectId}` | the delete requirement is `false` |
| R-005 | storage `allow read: if request.auth != null;` | the membership `exists` is gone for read and list |
| R-006 | `validProject` drops `request.resource.data.orgId != null &&` | create and update no longer imply `incoming.orgId != null`; `in` checks are unchanged |
| R-007 | `['active', 'archived', 'deleted']` | the status list is wider than the enum |
| R-008 | notes `allow read: if signedIn();` | notes no longer check the organization |
| R-009 | inside `match /orgs/{orgId}` add `match /{document=**} { allow read: if request.auth != null; }` | the catch-all overlaps only `/orgs/{orgId}/members/{uid}` among the rule targets |
| R-010 | users `allow read: if signedIn();` | the uid check is gone |
| R-011 | storage `allow write: if request.auth != null && request.resource.size < 10 * 1024 * 1024;` | writes no longer require membership; reads keep it |

Delete `breakages/.gitkeep`.
- [ ] **Step 7: Run the golden suite**: `pnpm vitest run packages/cli/test/golden-patch.test.ts` → `passes every expected rule on the clean app` and `catches R-001` … `catches R-011` PASS. A breakage that fails more than one rule means the app or the patch is wrong (or the analyzer is too coarse): fix it so exactly one rule fails.
- [ ] **Step 8: Update `examples/golden-firebase/README.md`**: a table of the eleven rules (id, type, what it shows) like `golden-ts-postgres`'s, and the breakage table above in one line per patch. Replace "The Firestore track … fills in" with the current description.
- [ ] **Step 9: `pnpm test && pnpm typecheck`** → PASS. **Step 10: Commit** `feat(golden-firebase): rules, expected rules and one breakage per rule`.

---

### Task 12: DogBase gate (controller only, private)

Run by the controller session, not a subagent, because it reads a private repository. **Nothing from this task's output enters the repo or the PR, except generic normalizations with invented examples.**

- [ ] **Step 1: Run the gate**:
```bash
test -d ~/Engineering/DogBase/dogbase/.holdline && echo "has .holdline" || echo "no .holdline"
cd ~/Engineering/DogBase/dogbase && node --import tsx/esm <worktree>/packages/cli/src/bin.ts scan
```
(If `tsx/esm` cannot be resolved from that directory, use `pnpm --dir <worktree> exec tsx <worktree>/packages/cli/src/bin.ts scan` with `cwd` set via `cd` first — the CLI scans `process.cwd()`.) Afterwards delete `~/Engineering/DogBase/dogbase/.holdline` if it did not exist before.
- [ ] **Step 2: Zero error diagnostics.** Read `.holdline/cache/facts.json` diagnostics before deleting. Any parse error is a parser gap: write a failing parser test with an invented minimal example of the same construct, fix, rerun.
- [ ] **Step 3: Review the opaque summary privately** (stdout of scan). Group the opaque texts into general Firestore patterns (for example `x is string`, `request.time` comparisons, `keys().hasOnly(...)`, `size()` checks). For the most common patterns that have an exact or polarity-safe mapping, add a normalization row with an invented example, a unit test, and a soundness row. Candidate: `x is <type>` in positive polarity implies `x != null` — only sound where the expression is not under `!` or a ternary test, so it needs a polarity flag in `normalizeCondition` (positive by default; `!` flips; a ternary test is both, so no weakening there). List the rest generically in As built.
- [ ] **Step 4: Report the opaque summary to the user in the session only.**

---

### Task 13: Docs, spec As built, final checks

**Files:**
- Modify: `docs/reference/facts.md`, `docs/reference/rules-file.md`, `docs/superpowers/specs/2026-10-21-data-layers-design.md`, `CLAUDE.md` only if its layout table needs the new package (it already lists `packages/analyzer-*`; no change expected)

- [ ] **Step 1: facts.md** — add a section "Firestore and Storage analyzer (`packages/analyzer-firestore`)" after "Analyzer contract": discovery rules, policy ids and match symbols (with the same-line `:col` suffix), op expansion, target prefix stripping, the normalization table as built (including per-atom `authenticated`, the `.get(k, d)` rule with `null` defaults, the bare-boolean row, Storage `request.resource.metadata`), opaque text, diagnostics (parse error message format, warnings), cache key. Update the Policy table note and the `exists` doc formats if anything changed.
- [ ] **Step 2: rules-file.md** — in "Vocabulary and recognizers", state that the Firestore analyzer turns calls to a zero-parameter function named by `firestore-function` into `{ ref }`, and inlines functions with parameters.
- [ ] **Step 3: Spec** — status line: `**Status:** Step 0 and Track B implemented (2026-10-21). Tracks A and C are not built yet.` (keep whatever Tracks A/C say if they merged first). Add `## As built (Track B)` with a table: section → difference (per-atom `authenticated` instead of whole-condition and why; `.get(k, null)`; bare boolean; `request.resource.metadata` in Storage; `firebase.json` at any depth and arrays; policy id `:col` suffix; allows outside a document prefix; interpolated match segments; Storage soundness model-only; emulator tests need Java 21; any DogBase-driven generic normalizations; the eleven golden rules; the golden-patch skeleton test change; anything else that differs).
- [ ] **Step 4: Privacy sweep**: `git diff main --stat` and grep the diff for DogBase terms you saw (search privately; do not write them anywhere): `git diff main | grep -i -E '<terms>'` must print nothing.
- [ ] **Step 5: `pnpm typecheck && pnpm test`** → PASS. **Step 6: Commit** `docs: record Track B as built and document the Firestore analyzer`.

---

## Self-review notes

- Spec 4.1 → Task 8; 4.2 → Tasks 1–3; 4.3 → Task 4; 4.4 → Tasks 5–7; 4.5 → nothing emitted (`collections` stays empty); 6.2 → Task 11; 7 → Task 12 (+ summary line Task 10); 8 → all; 9 → Task 9 and the unit tests.
- Type names used across tasks: `Node`, `Pos`, `ParseError`, `RulesAst`, `Allow`, `Scope`, `Env`, `Binding`, `rootEnv`, `Value`, `NormalizeContext`, `resolveValue`, `normalizeCondition`, `simplify`, `lookupPath`, `inlineCall`, `expandRules`, `expandOps`, `policyIds`, `AllowSite`, `MatchSite`, `discoverRulesFiles`, `analyzeRulesFile`, `firestoreAnalyzer`, `policySummary`.
