import { deepEqual } from './canonical.js'
import { isLookupOperand, parseLookup, type Atom, type Operand } from './expr.js'
import type { Op } from './facts.js'
import { read, type World } from './testgen-world.js'

// Evaluates one atom against a generated world. It is the generator's own check that a world
// satisfies or falsifies exactly the conditions it was built for; it never decides a rule check.
// `undefined` means "absent": an atom that compares an absent value is false, as is any atom
// that reads the actor when the caller is anonymous.

function field(data: unknown, name: string): unknown {
  return name.split('.').reduce<unknown>((d, k) => (d && typeof d === 'object' ? (d as Record<string, unknown>)[k] : undefined), data)
}

function docData(w: World, path: string): Record<string, unknown> | undefined {
  return path === w.targetPath ? w.resource : w.docs.find(d => d.path === path)?.data
}

function fill(w: World, template: string): string | undefined {
  let ok = true
  const out = template.replace(/\{([^}]+)\}/g, (_, operand: string) => {
    const v = value(w, operand)
    if (v === undefined || v === null) ok = false
    return String(v)
  })
  return ok ? out : undefined
}

function value(w: World, o: Operand): unknown {
  const r = read(w, o)
  if (r.fixed) return r.value
  if (typeof o !== 'string') return undefined
  const lookup = isLookupOperand(o) ? parseLookup(o) : undefined
  if (lookup) {
    const path = fill(w, lookup.path)
    return path === undefined ? undefined : field(docData(w, path), lookup.field)
  }
  if (o === 'actor.role') return w.actor?.role
  if (o.startsWith('actor.claim.')) return w.actor ? field(w.actor.claims, o.slice(12)) : undefined
  if (o.startsWith('resource.')) return field(w.resource, o.slice(9))
  if (o.startsWith('incoming.')) return field(w.incoming, o.slice(9))
  return undefined
}

// The record under test exists for every op but `create` (cases for other ops seed it).
function exists(w: World, doc: string, op: Op | undefined): boolean {
  if (doc.startsWith('pg:')) {
    const [table, query = ''] = doc.slice(3).split('?')
    const cols = query.split('&').filter(Boolean).map(pair => pair.split('=') as [string, string])
    const want = cols.map(([col, ref]) => [col, value(w, ref.replace(/^\{|\}$/g, ''))] as const)
    return want.every(([, v]) => v !== undefined) && w.docs.some(d => d.path === table && want.every(([col, v]) => deepEqual(d.data[col], v)))
  }
  const path = fill(w, doc)
  if (path !== undefined && path === w.targetPath) return op !== 'create'
  return path !== undefined && w.docs.some(d => d.path === path)
}

// `op` is the operation the world is used for; omitted, the record under test exists.
export function holds(w: World, a: Atom, op?: Op): boolean {
  switch (a.op) {
    case 'authenticated': return w.actor !== null
    case 'exists': return exists(w, a.doc, op)
    case 'isNull': return value(w, a.operand) === null
    case 'eq': {
      const l = value(w, a.left)
      const r = value(w, a.right)
      return l !== undefined && r !== undefined && deepEqual(l, r)
    }
    case 'in': {
      const l = value(w, a.left)
      const r = value(w, a.right)
      return l !== undefined && Array.isArray(r) && r.some(x => deepEqual(x, l))
    }
    default: return false
  }
}
