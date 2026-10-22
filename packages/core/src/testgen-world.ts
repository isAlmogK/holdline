import { deepEqual } from './canonical.js'
import { isLookupOperand, parseLookup, type Operand } from './expr.js'

export type Actor = { uid: string; role?: string; claims: Record<string, unknown> }
export type SeedDoc = { path: string; data: Record<string, unknown> }
export type World = {
  actor: Actor | null
  params: Record<string, string>
  resource: Record<string, unknown>
  incoming: Record<string, unknown>
  docs: SeedDoc[]
  counter: number
  // The concretized Firestore path of the record under test (unset for Storage and Postgres). A lookup of this path writes to `resource`.
  targetPath?: string
  recordLookup: boolean
}

export class Unsupported extends Error {}

export function nextValue(w: World): string {
  return `value-${++w.counter}`
}

export function settable(o: Operand): boolean {
  return typeof o === 'string' && /^(resource|incoming|actor\.claim|actor\.role)/.test(o)
}

export function read(w: World, o: Operand): { fixed: boolean; value: unknown } {
  if (typeof o !== 'string') return { fixed: true, value: o.literal }
  if (o === 'actor.uid') return { fixed: true, value: w.actor?.uid }
  if (o.startsWith('param.')) return { fixed: true, value: w.params[o.slice(6)] ?? `${o.slice(6)}-1` }
  return { fixed: false, value: undefined }
}

function assign(target: Record<string, unknown>, key: string, o: string, value: unknown): void {
  if (key.includes('.')) throw new Unsupported(`nested field ${o} is not generated yet; check it statically`)
  if (key in target && !deepEqual(target[key], value)) throw new Unsupported(`conflicting conditions on ${o}; check them statically`)
  target[key] = value
}

// A seeded document is unique per Firestore path: docs from `exists` atoms and lookups on one path merge.
// A doc on the record's own path merges into the record (and, like a lookup of it, reads the stored record).
// Postgres rows (`pg:` docs have a table, not a `/path`) are never merged.
export function addDoc(w: World, doc: SeedDoc): SeedDoc {
  if (doc.path === w.targetPath) {
    w.recordLookup = true
    for (const [k, v] of Object.entries(doc.data)) assign(w.resource, k, k, v)
    return { path: doc.path, data: w.resource }
  }
  const existing = doc.path.startsWith('/') ? w.docs.find(d => d.path === doc.path) : undefined
  if (!existing) {
    w.docs.push(doc)
    return doc
  }
  for (const [k, v] of Object.entries(doc.data)) assign(existing.data, k, k, v)
  return existing
}

export function set(w: World, o: Operand, value: unknown): void {
  if (typeof o !== 'string') throw new Unsupported(`cannot set a literal to ${JSON.stringify(value)}`)
  const lookup = isLookupOperand(o) ? parseLookup(o) : undefined
  if (lookup) {
    const { path, data } = resolveDocCreating(w, lookup.path)
    if (path === w.targetPath) {
      w.recordLookup = true
      assign(w.resource, lookup.field, o, value)
    } else assign(addDoc(w, { path, data }).data, lookup.field, o, value)
  } else if (o.startsWith('resource.')) assign(w.resource, o.slice(9), o, value)
  else if (o.startsWith('incoming.')) assign(w.incoming, o.slice(9), o, value)
  else if (o.startsWith('actor.claim.') && w.actor) assign(w.actor.claims, o.slice(12), o, value)
  else if (o === 'actor.role' && w.actor) {
    if (w.actor.role !== undefined && w.actor.role !== String(value)) throw new Unsupported(`conflicting conditions on ${o}; check them statically`)
    w.actor.role = String(value)
  } else throw new Unsupported(`cannot set ${o} to ${JSON.stringify(value)}`)
}

// The value an operand has in the world so far (`undefined` when nothing has set it yet).
export function current(w: World, o: Operand): unknown {
  const r = read(w, o)
  if (r.fixed) return r.value
  const lookup = isLookupOperand(o) ? parseLookup(o) : undefined
  if (!lookup) return valueOf(w, o as string)
  if (lookup.field.includes('.')) throw new Unsupported(`nested field ${o} is not generated yet; check it statically`)
  let path: string
  try {
    path = resolveDoc(w, lookup.path).path
  } catch (e) {
    if (e instanceof Unsupported) return undefined
    throw e
  }
  const data = path === w.targetPath ? w.resource : w.docs.find(d => d.path === path)?.data
  return data?.[lookup.field]
}

// Resolves `{operand}` placeholders from the world; an unset one is skipped (`cannot resolve`).
export function resolveDoc(w: World, doc: string): SeedDoc {
  return resolve(w, doc, false)
}

// Like `resolveDoc`, but a stored-record or incoming field that nothing has set yet gets a fresh value
// (and is set in the world), because a lookup path that depends on it needs one.
export function resolveDocCreating(w: World, doc: string): SeedDoc {
  return resolve(w, doc, true)
}

function resolve(w: World, doc: string, create: boolean): SeedDoc {
  const fill = (operand: string) => {
    const r = read(w, operand)
    let v = r.fixed ? r.value : valueOf(w, operand)
    if (v === undefined && create && /^(resource|incoming)\./.test(operand)) {
      v = nextValue(w)
      set(w, operand, v)
    }
    if (v === undefined) throw new Unsupported(`cannot resolve {${operand}}`)
    return String(v)
  }
  if (doc.startsWith('pg:')) {
    const [table, query = ''] = doc.slice(3).split('?')
    const data: Record<string, unknown> = {}
    for (const pair of query.split('&').filter(Boolean)) {
      const [col, ref] = pair.split('=')
      data[col!] = fill(ref!.replace(/^\{|\}$/g, ''))
    }
    return { path: table!, data }
  }
  return { path: doc.replace(/\{([^}]+)\}/g, (_, operand: string) => fill(operand)), data: {} }
}

function valueOf(w: World, operand: string): unknown {
  const depth = operand.startsWith('actor.claim.') ? 3 : 2
  if (operand.split('.').length > depth) throw new Unsupported(`nested field ${operand} is not generated yet; check it statically`)
  if (operand.startsWith('resource.')) return w.resource[operand.slice(9)]
  if (operand.startsWith('incoming.')) return w.incoming[operand.slice(9)]
  if (operand.startsWith('actor.claim.')) return w.actor?.claims[operand.slice(12)]
  if (operand === 'actor.role') return w.actor?.role
  throw new Unsupported(`cannot read ${operand}`)
}
