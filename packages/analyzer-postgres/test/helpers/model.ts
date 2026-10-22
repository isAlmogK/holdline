import type { Atom, Expr, Operand } from '@holdline/core'

// A small model of the facts' expression semantics (facts.md "Expressions" and the anonymous caller convention).
export type Row = Record<string, string | number | null>
export interface World {
  actor: { uid: string; claims: Record<string, unknown> } | null
  resource?: Row
  incoming?: Row
  tables: Record<string, Row[]>
}

const ACTOR = Symbol('anonymous actor')

function value(o: Operand, w: World): unknown {
  if (typeof o !== 'string') return o.literal
  if (o.startsWith('actor.')) {
    if (!w.actor) return ACTOR
    if (o === 'actor.uid') return w.actor.uid
    const path = o === 'actor.role' ? ['role'] : o.slice('actor.claim.'.length).split('.')
    return path.reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), w.actor.claims) ?? null
  }
  if (o.startsWith('resource.')) return w.resource?.[o.slice('resource.'.length)] ?? null
  if (o.startsWith('incoming.')) return w.incoming?.[o.slice('incoming.'.length)] ?? null
  throw new Error(`model cannot read ${o}`)
}

// `pg:<schema.table>?c={o}&…`: true when every placeholder is set and some row matches all columns.
function exists(doc: string, w: World): boolean {
  if (!doc.startsWith('pg:')) throw new Error(`model cannot read ${doc}`)
  const [table, query = ''] = doc.slice(3).split('?')
  const want = query.split('&').map(p => p.split('=') as [string, string]).map(([c, ref]) => [c, value(ref.slice(1, -1), w)] as const)
  if (want.some(([, v]) => v === null || v === ACTOR)) return false
  return (w.tables[table!] ?? []).some(r => want.every(([c, v]) => r[c] === v))
}

function holds(a: Atom, w: World): boolean {
  if (a.op === 'authenticated') return w.actor !== null
  if (a.op === 'exists') return exists(a.doc, w)
  if (a.op === 'isNull') { const v = value(a.operand, w); return v !== ACTOR && v === null }
  const l = value(a.left, w)
  const r = value(a.right, w)
  if (l === ACTOR || r === ACTOR || l === null || r === null) return false
  switch (a.op) {
    case 'eq': return l === r
    case 'ne': return l !== r
    case 'lt': return (l as number) < (r as number)
    case 'gt': return (l as number) > (r as number)
    case 'in': return Array.isArray(r) && r.includes(l as string | number)
  }
}

export function evaluate(e: Expr, w: World): boolean {
  if ('and' in e) return e.and.every(x => evaluate(x, w))
  if ('or' in e) return e.or.some(x => evaluate(x, w))
  if ('not' in e) return !evaluate(e.not, w)
  if ('atom' in e) return holds(e.atom, w)
  throw new Error(`model cannot evaluate ${JSON.stringify(e)}`)
}
