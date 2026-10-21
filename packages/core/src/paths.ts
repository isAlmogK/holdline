export type Segment =
  | { kind: 'literal'; value: string }
  | { kind: 'param'; name: string }
  | { kind: 'rest'; name: string }

export function parsePattern(path: string): Segment[] {
  return path.split('/').filter(Boolean).map((s): Segment => {
    const m = /^\{([A-Za-z0-9_.]+)(=\*\*)?\}$/.exec(s)
    if (!m) return { kind: 'literal', value: s }
    return m[2] ? { kind: 'rest', name: m[1]! } : { kind: 'param', name: m[1]! }
  })
}

export function patternsOverlap(a: string, b: string): boolean {
  const sa = parsePattern(a)
  const sb = parsePattern(b)
  const go = (i: number, j: number): boolean => {
    if (sa[i]?.kind === 'rest' || sb[j]?.kind === 'rest') return true
    if (i === sa.length || j === sb.length) return i === sa.length && j === sb.length
    const x = sa[i]!
    const y = sb[j]!
    if (x.kind === 'literal' && y.kind === 'literal' && x.value !== y.value) return false
    return go(i + 1, j + 1)
  }
  return go(0, 0)
}

export function alignParams(from: string, to: string): Map<string, string> {
  const a = parsePattern(from)
  const b = parsePattern(to)
  const map = new Map<string, string>()
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i]!
    const y = b[i]!
    if (x.kind === 'rest' || y.kind === 'rest') break
    if (x.kind === 'param' && y.kind === 'param') map.set(x.name, y.name)
  }
  return map
}

export function concretize(path: string, value: (param: string) => string): string {
  return '/' + parsePattern(path).map(s => (s.kind === 'literal' ? s.value : value(s.name))).join('/')
}

export function routeMatches(selector: string, route: { id: string; method: string; path: string }): boolean {
  if (selector.startsWith('route:')) return selector === route.id
  const m = /^(\S+)\s+(\/\S*)$/.exec(selector.trim())
  if (!m) throw new Error(`invalid route selector "${selector}": expected "METHOD /path" or "route:METHOD /path"`)
  const method = m[1]!
  if (method !== '*' && method.toUpperCase() !== route.method.toUpperCase()) return false
  return globMatch(m[2]!.split('/').filter(Boolean), route.path.split('/').filter(Boolean))
}

function globMatch(glob: string[], segs: string[]): boolean {
  if (glob.length === 0) return segs.length === 0
  const [head, ...rest] = glob
  if (head === '**') return segs.some((_, i) => globMatch(rest, segs.slice(i))) || globMatch(rest, [])
  if (segs.length === 0) return false
  return (head === '*' || head === segs[0]) && globMatch(rest, segs.slice(1))
}

export function normalizeTable(name: string): string {
  return name.includes('.') ? name : `public.${name}`
}
