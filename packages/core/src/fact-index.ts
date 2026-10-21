import type { DataOp, Facts, Guard, Location, Op, Policy, Route, Table } from './facts.js'
import { normalizeTable, patternsOverlap, routeMatches } from './paths.js'
import type { DataTarget } from './rules.js'

const POLICY_STORE = { postgres: 'pg-rls', firestore: 'firestore', storage: 'storage' } as const

export class FactIndex {
  private readonly locations = new Map<string, Location | undefined>()
  private readonly callersOf = new Map<string, string[]>()

  constructor(readonly facts: Facts) {
    for (const s of facts.symbols) this.locations.set(s.id, s.location)
    for (const r of facts.routes) if (!this.locations.has(r.id)) this.locations.set(r.id, undefined)
    for (const t of facts.tables) this.locations.set(t.id, t.location)
    for (const p of facts.policies) this.locations.set(p.id, p.evidence)
    for (const [from, to] of facts.calls) this.callersOf.set(to, [...(this.callersOf.get(to) ?? []), from])
  }

  hasId(id: string): boolean {
    return this.locations.has(id)
  }

  at(id: string): { symbol: string; file?: string; line?: number } {
    const loc = this.locations.get(id)
    return loc ? { symbol: id, file: loc.file, line: loc.line } : { symbol: id }
  }

  fileOf(id: string): string | undefined {
    return this.locations.get(id)?.file
  }

  routesMatching(selector: string): Route[] {
    return this.facts.routes.filter(r => routeMatches(selector, r))
  }

  guardsAt(id: string): Guard[] {
    return this.facts.guards.filter(g => g.at === id)
  }

  guardChain(route: Route): Guard[] {
    return [route.id, ...route.middleware, route.handler].flatMap(id => this.guardsAt(id))
  }

  dataOps(target: DataTarget, ops?: readonly Op[]): DataOp[] {
    return this.facts.dataOps.filter(o =>
      o.store === target.store && targetMatches(target, o.target) && (!ops || ops.includes(o.op)))
  }

  policies(target: DataTarget, op: Op): Policy[] {
    return this.facts.policies.filter(p =>
      p.store === POLICY_STORE[target.store] && targetMatches(target, p.target) && p.ops.includes(op))
  }

  table(name: string): Table | undefined {
    const wanted = normalizeTable(name)
    return this.facts.tables.find(t => normalizeTable(t.name) === wanted)
  }

  targetExists(target: DataTarget): boolean {
    if (target.store === 'postgres') return !!this.table(target.table) || this.dataOps(target).length > 0
    return this.dataOps(target).length > 0
      || this.facts.policies.some(p => p.store === target.store && patternsOverlap(p.target, target.path))
      || this.facts.collections.some(c => patternsOverlap(c.path, target.path))
  }

  // True when every call path that reaches `symbol` passes through a symbol in `via`.
  // A `via` entry also covers its members: `ts:x#Repo` covers `ts:x#Repo.update`.
  coveredBy(symbol: string, via: readonly string[], visiting: ReadonlySet<string> = new Set()): boolean {
    if (via.some(v => symbol === v || symbol.startsWith(`${v}.`))) return true
    if (visiting.has(symbol)) return false
    const callers = this.callersOf.get(symbol) ?? []
    if (callers.length === 0) return false
    const next = new Set([...visiting, symbol])
    return callers.every(c => this.coveredBy(c, via, next))
  }

  errorFiles(): Set<string> {
    return new Set(this.facts.diagnostics.filter(d => d.severity === 'error').map(d => d.file))
  }
}

function targetMatches(target: DataTarget, name: string): boolean {
  return target.store === 'postgres'
    ? normalizeTable(name) === normalizeTable(target.table)
    : patternsOverlap(name, target.path)
}
