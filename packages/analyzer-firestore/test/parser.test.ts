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
  it('reports a bad wildcard at its opening brace', () => {
    const src = `service cloud.firestore { match /a/{b=*} {} }`
    expect(err(src)).toMatchObject({ line: 1, col: src.indexOf('{b=*}') + 1 })
    expect(src.indexOf('{b=*}') + 1).toBe(36)
  })
  it('reports junk at the top level and a missing function return', () => {
    expect(err(`match /a {}`)).toMatchObject({ line: 1, col: 1, message: expect.stringContaining("expected 'service'") })
    expect(err(`service cloud.firestore { function f() { let a = 1; } }`)).toMatchObject({ message: expect.stringContaining("expected 'return'") })
  })
})
