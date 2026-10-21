import { isMap } from './world.js'

/** Values of the rules interpreter beyond plain data (strings, numbers, booleans, null, lists, maps). */

export const ERROR = Symbol('error') // a Firestore evaluation error
export type V = unknown // a rules value, or ERROR

export class PathValue { constructor(readonly segments: string[]) {} }
export class Namespace { constructor(readonly name: 'firestore') {} }

/**
 * An object with a fixed set of members the interpreter models (`request`, `resource`, a looked-up document).
 * Reading any other member (`request.time`, `resource.id`, ...) throws: it is unsupported, not a Firestore error.
 */
export class Members {
  constructor(readonly what: string, private readonly members: Record<string, V>) {}
  get(name: string): V {
    if (!Object.hasOwn(this.members, name)) throw new Error(`unsupported member ${this.what}.${name}`)
    return this.members[name]
  }
}

/** `v.key`: a field of a map, or a modelled member. A missing key, null or another type is a Firestore error. */
export function member(v: V, key: string): V {
  if (v instanceof Members) return v.get(key)
  if (v === ERROR || !isMap(v) || !Object.hasOwn(v, key)) return ERROR
  return v[key]
}

/** The text of one path segment from its parts' values: strings, and integers as digits; anything else is an error. */
export function segmentText(values: V[]): string | typeof ERROR {
  let text = ''
  for (const v of values) {
    if (typeof v === 'string') text += v
    else if (typeof v === 'number' && Number.isInteger(v)) text += String(v)
    else return ERROR
  }
  return text
}

/** The document `get(path)` gives (null when none is stored), or an error when `path` is not a document path. */
export function documentAt(path: V, docs: Record<string, Record<string, unknown>>): Members | null | typeof ERROR {
  if (!(path instanceof PathValue)) return ERROR
  const [databases, , documents, ...rest] = path.segments
  if (databases !== 'databases' || documents !== 'documents' || rest.length === 0) return ERROR
  const data = docs['/' + rest.join('/')]
  return data === undefined ? null : new Members('document', { data })
}
