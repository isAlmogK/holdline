import type { Expr, Facts } from '@holdline/core'

const MAX_TEXT = 120
const UNKNOWN_FILE = '(unknown file)'

function opaqueTexts(expr: Expr, out: string[]): void {
  if ('opaque' in expr) out.push(expr.opaque)
  else if ('and' in expr) expr.and.forEach(e => opaqueTexts(e, out))
  else if ('or' in expr) expr.or.forEach(e => opaqueTexts(e, out))
  else if ('not' in expr) opaqueTexts(expr.not, out)
}

function cut(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

interface FileSummary {
  policies: number
  // opaque text -> lines; Map keeps first-appearance order
  opaque: Map<string, Set<number>>
}

// One block per Firestore or Storage rules file; '' when there are no such policies.
export function policySummary(facts: Facts): string {
  const files = new Map<string, FileSummary>()
  const policies = facts.policies
    .filter(p => p.store === 'firestore' || p.store === 'storage')
    .map((p, i) => ({ p, i }))
    .sort((a, b) => (a.p.evidence?.line ?? 0) - (b.p.evidence?.line ?? 0) || a.i - b.i)
  for (const { p } of policies) {
    const file = p.evidence?.file ?? UNKNOWN_FILE
    const summary = files.get(file) ?? { policies: 0, opaque: new Map() }
    files.set(file, summary)
    summary.policies++
    const texts: string[] = []
    opaqueTexts(p.condition, texts)
    for (const text of texts) {
      const lines = summary.opaque.get(text) ?? new Set<number>()
      summary.opaque.set(text, lines)
      lines.add(p.evidence?.line ?? 0)
    }
  }
  let out = ''
  for (const file of [...files.keys()].sort()) {
    const { policies: n, opaque } = files.get(file)!
    const count = [...opaque.values()].reduce((sum, lines) => sum + lines.size, 0)
    out += `${file}: ${plural(n, 'policy', 'policies')}, ${plural(count, 'opaque sub-condition', 'opaque sub-conditions')}\n`
    for (const [text, lines] of opaque) {
      const sorted = [...lines].sort((a, b) => a - b)
      out += `  opaque: ${cut(text)} (${sorted.length === 1 ? 'line' : 'lines'} ${sorted.join(', ')})\n`
    }
  }
  return out
}
