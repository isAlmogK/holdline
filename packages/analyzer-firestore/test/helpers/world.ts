import fc from 'fast-check'

/** The model world the interpreter, the evaluator and the emulator all use. */
export interface World {
  actor: null | { uid: string; claims: Record<string, unknown> }
  params: Record<string, string> // wildcard values, e.g. { thingId: 't1' }
  resource: Record<string, unknown> | undefined // stored record (undefined: no document)
  incoming: Record<string, unknown> | undefined // request.resource.data / metadata
  docs: Record<string, Record<string, unknown>> // other documents by concrete path ('/users/u1')
}

export const UIDS = ['u1', 'u2'] as const
export const THING_IDS = ['t1', 'x', 'u1'] as const
/** Every document a row may look up: users by uid, org members by thing id and uid. */
export const DOC_PATHS: readonly string[] = [
  ...UIDS.map(u => `/users/${u}`),
  ...THING_IDS.flatMap(t => UIDS.map(u => `/orgs/${t}/members/${u}`)),
]
const scalar = fc.constantFrom<unknown>('open', 'a', 'b', 'admin', '', 1, 2, 3, 4, true, false, null, 'u1', 'u2', 't1', 'x')
const listItem = fc.constantFrom<string | number>('a', 'b', 'admin', '', 1, 2, 3, 'u1', 'u2', 't1', 'x')
const ids = fc.constantFrom('t1', 'x', 'u1', 'u2')
const value: fc.Arbitrary<unknown> = fc.oneof(
  { arbitrary: scalar, weight: 6 },
  { arbitrary: fc.array(listItem, { maxLength: 3 }), weight: 2 },
  { arbitrary: fc.dictionary(ids, scalar, { maxKeys: 2, noNullPrototype: true }), weight: 1 },
)

/** A field's value: mostly what the rows compare it with, otherwise anything (including other types). */
const favoring = (favored: fc.Arbitrary<unknown>) => fc.oneof({ arbitrary: favored, weight: 3 }, { arbitrary: value, weight: 1 })

/** The fields the rows read; each is absent or holds a value. */
const FIELDS: Record<string, fc.Arbitrary<unknown>> = {
  status: favoring(fc.constantFrom('open', 'a', 'b', 'c')),
  n: favoring(fc.constantFrom(1, 2, 3, 4)),
  a: favoring(fc.constantFrom(1, 2)),
  b: favoring(fc.constantFrom(1, 2)),
  owner: favoring(fc.constantFrom('u1', 'u2')),
  role: favoring(fc.constantFrom('admin', '')),
  published: favoring(fc.boolean()),
  editors: favoring(fc.oneof(fc.array(ids, { maxLength: 2 }), fc.dictionary(ids, fc.boolean(), { maxKeys: 2, noNullPrototype: true }))),
  orgIds: favoring(fc.array(ids, { maxLength: 2 })),
}

const record: fc.Arbitrary<Record<string, unknown>> = fc.record(FIELDS, { requiredKeys: [], noNullPrototype: true })

const actor = fc.option(
  fc.record({ uid: fc.constantFrom(...UIDS), claims: fc.record({ admin: fc.boolean() }, { requiredKeys: [], noNullPrototype: true }) }, { noNullPrototype: true }),
  { nil: null },
)

/** Worlds from a small domain, so equalities between actor, params, fields and documents happen often. */
export const worldArb: fc.Arbitrary<World> = fc.record({
  actor,
  params: fc.record({ thingId: fc.constantFrom(...THING_IDS) }, { noNullPrototype: true }),
  resource: fc.option(record, { nil: undefined }),
  incoming: fc.option(record, { nil: undefined }),
  // Optional keys come out absent, never undefined.
  docs: fc.record(Object.fromEntries(DOC_PATHS.map(p => [p, record])), { requiredKeys: [], noNullPrototype: true }) as fc.Arbitrary<World['docs']>,
}, { noNullPrototype: true })

/** Structural equality of model values: lists by order, maps by keys. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameValue(x, b[i]))
  }
  if (isMap(a) && isMap(b)) {
    const ka = Object.keys(a)
    return ka.length === Object.keys(b).length && ka.every(k => k in b && sameValue(a[k], b[k]))
  }
  return false
}

/** A plain record (a Firestore map), not a list, null or a class instance. */
export function isMap(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const proto: unknown = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}
