import type { AnalyzerRecognizer, Expr } from '@holdline/core'
import { analyzeRulesFile } from '../../src/analyze-file.js'

/**
 * One rules condition on `match /things/{thingId}`. `before` holds declarations (functions) placed before the
 * match. `vocabulary` names zero-parameter functions an approved recognizer maps, with the vocabulary Expr
 * the user approved for each (the recognizer id is the function name).
 */
export interface Row {
  name: string
  store: 'firestore' | 'storage'
  condition: string
  before?: string
  vocabulary?: Record<string, Expr>
}

const USER_DOC = '/databases/$(database)/documents/users/$(request.auth.uid)'

/** One row per normalization rule in spec 4.4, plus the generic additions. Collection and field names are invented. */
export const ROWS: Row[] = [
  { name: 'auth != null', store: 'firestore', condition: 'request.auth != null' },
  { name: 'auth == null', store: 'firestore', condition: 'request.auth == null' },
  { name: 'auth.uid against a wildcard', store: 'firestore', condition: 'request.auth.uid == thingId' },
  { name: 'auth.token claim', store: 'firestore', condition: 'request.auth.token.admin == true' },
  { name: 'stored field', store: 'firestore', condition: `resource.data.status == 'open'` },
  { name: 'stored field by index', store: 'firestore', condition: `resource.data['status'] == 'open'` },
  { name: 'incoming field in a list', store: 'firestore', condition: `request.resource.data.status in ['a', 'b']` },
  { name: 'wildcard', store: 'firestore', condition: `thingId == 'x'` },
  { name: 'get(...).data.f with in', store: 'firestore', condition: `thingId in get(${USER_DOC}).data.orgIds` },
  { name: 'exists(...)', store: 'firestore', condition: 'exists(/databases/$(database)/documents/orgs/$(thingId)/members/$(request.auth.uid))' },
  { name: 'get with a fallback that never matches', store: 'firestore', condition: `resource.data.get('role', '') == 'admin'` },
  { name: 'get with a null fallback', store: 'firestore', condition: `resource.data.get('a', null) == null` },
  { name: 'get with a number fallback', store: 'firestore', condition: `resource.data.get('n', 0) > 2` },
  { name: 'less than', store: 'firestore', condition: 'resource.data.n < 3' },
  { name: 'greater than', store: 'firestore', condition: 'resource.data.n > 3' },
  { name: 'string ordering', store: 'firestore', condition: `resource.data.status > 'b'` },
  { name: 'auth.uid in a stored list or map', store: 'firestore', condition: 'request.auth.uid in resource.data.editors' },
  { name: 'and', store: 'firestore', condition: 'resource.data.a == 1 && resource.data.b == 2' },
  { name: 'or with an actor atom', store: 'firestore', condition: 'resource.data.a == 1 || request.auth.uid == resource.data.owner' },
  { name: 'not', store: 'firestore', condition: '!(resource.data.a == 1)' },
  { name: 'not over an actor atom', store: 'firestore', condition: '!(request.auth.uid == resource.data.owner)' },
  { name: 'ternary', store: 'firestore', condition: `resource.data.a == 1 ? request.auth != null : resource.data.status == 'open'` },
  { name: 'precedence without parentheses', store: 'firestore', condition: 'resource.data.a == 1 || resource.data.b == 2 && request.auth != null' },
  { name: 'true', store: 'firestore', condition: 'true' },
  { name: 'false', store: 'firestore', condition: 'false' },
  {
    name: 'function with params and a let',
    store: 'firestore',
    before: 'function isOwner(rec, uid) { let owner = rec.owner; return owner == uid; }',
    condition: `isOwner(resource.data, request.auth.uid) || resource.data.status == 'open'`,
  },
  {
    name: 'recognized function',
    store: 'firestore',
    before: 'function signedIn() { return request.auth != null; }',
    condition: `signedIn() && resource.data.status == 'open'`,
    vocabulary: { signedIn: { atom: { op: 'authenticated' } } },
  },
  {
    name: 'param and let bound to a boolean',
    store: 'firestore',
    before: `function check(ok) { let open = resource.data.status == 'open'; return ok && open; }`,
    condition: 'check(request.auth != null)',
  },
  {
    name: 'user function in value position',
    store: 'firestore',
    before: 'function ownerOf(rec) { return rec.owner; }',
    condition: 'ownerOf(resource.data) == request.auth.uid',
  },
  {
    name: 'param shadowing a global',
    store: 'firestore',
    before: `function h(resource) { return resource.data.status == 'open'; }`,
    condition: 'h(request.resource)',
  },
  { name: 'fallback on the right', store: 'firestore', condition: `'admin' == resource.data.get('role', '')` },
  {
    // The fallback satisfies the comparison, so that side stays opaque; the other side still decides.
    name: 'satisfying fallback stays opaque inside or',
    store: 'firestore',
    condition: `resource.data.get('role', 'admin') == 'admin' || resource.data.status == 'open'`,
  },
  { name: 'nested claim', store: 'firestore', condition: `request.auth.token.firebase.sign_in_provider == 'password'` },
  { name: 'bare boolean', store: 'firestore', condition: 'resource.data.published' },
  { name: 'Storage metadata', store: 'storage', condition: 'resource.metadata.owner == request.auth.uid' },
  { name: 'Storage firestore.exists', store: 'storage', condition: 'firestore.exists(/databases/(default)/documents/users/$(request.auth.uid))' },
  { name: 'Storage firestore.get', store: 'storage', condition: 'thingId in firestore.get(/databases/(default)/documents/users/$(request.auth.uid)).data.orgIds' },
]

/** The rules file for a row: its condition under `allow <op>` on `match /things/{thingId}`. */
export function rulesSource(row: Row, op: 'read' | 'create' = 'read'): string {
  const inner = `${row.before ?? ''}\n    match /things/{thingId} {\n      allow ${op}: if ${row.condition};\n    }`
  return row.store === 'firestore'
    ? `rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    ${inner}\n  }\n}\n`
    : `rules_version = '2';\nservice firebase.storage {\n  match /b/{bucket}/o {\n    ${inner}\n  }\n}\n`
}

/** True when the row reads `request.resource` (a write rule is where it is defined), in its condition or its functions. */
export const readsIncoming = (row: Row): boolean => `${row.before ?? ''} ${row.condition}`.includes('request.resource')

/** The vocabulary the row's recognized functions expand to, keyed by recognizer id. */
export const vocabularyOf = (row: Row): ReadonlyMap<string, Expr> => new Map(Object.entries(row.vocabulary ?? {}))

/** The Expr the real analyzer emits for the row's condition. Throws on a diagnostic: every row must parse. */
export function normalize(row: Row): Expr {
  const recognizers: AnalyzerRecognizer[] = Object.keys(row.vocabulary ?? {}).map(name => ({ id: name, recognize: [{ 'firestore-function': name }] }))
  const out = analyzeRulesFile(`${row.store}.rules`, rulesSource(row), recognizers)
  if (out.diagnostics?.length) throw new Error(`${row.name}: ${out.diagnostics.map(d => d.message).join('; ')}`)
  const policy = out.policies?.[0]
  if (!policy) throw new Error(`${row.name}: no policy`)
  return policy.condition as Expr // AnalyzerOutput is the facts input type; the analyzer emits an Expr
}
