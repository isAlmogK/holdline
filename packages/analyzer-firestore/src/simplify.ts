import { canonicalJson, type Expr } from '@holdline/core'

function containsOpaque(e: Expr): boolean {
  if ('opaque' in e) return true
  if ('and' in e) return e.and.some(containsOpaque)
  if ('or' in e) return e.or.some(containsOpaque)
  if ('not' in e) return containsOpaque(e.not)
  return false
}

/** Members of an and/or: simplified, nested same-kind members flattened, duplicates dropped (never opaque ones). */
function members(kind: 'and' | 'or', items: readonly Expr[]): Expr[] {
  const out: Expr[] = []
  const seen = new Set<string>()
  for (const item of items.map(simplify)) {
    const flat = kind === 'and' && 'and' in item ? item.and : kind === 'or' && 'or' in item ? item.or : [item]
    for (const m of flat) {
      if (!containsOpaque(m)) {
        const key = canonicalJson(m)
        if (seen.has(key)) continue
        seen.add(key)
      }
      out.push(m)
    }
  }
  return out
}

/** Logic-preserving cleanup of a normalized condition. Never drops or folds `opaque`. */
export function simplify(e: Expr): Expr {
  if ('and' in e || 'or' in e) {
    const kind = 'and' in e ? 'and' : 'or'
    const ms = members(kind, 'and' in e ? e.and : e.or)
    if (ms.length === 1) return ms[0]!
    return kind === 'and' ? { and: ms } : { or: ms }
  }
  if ('not' in e) {
    const inner = simplify(e.not)
    return 'not' in inner ? inner.not : { not: inner }
  }
  return e
}
