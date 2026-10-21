import { OPS, type Op } from '@holdline/core'
import type { Allow, AllowOp, Block, Match, MatchSegment, RulesAst, Service } from './ast.js'
import { Scope } from './scope.js'

export type Store = 'firestore' | 'storage'
export interface AllowSite { store: Store; target: string; ops: Op[]; allow: Allow; scope: Scope }
export interface MatchSite { store: Store; target: string; line: number }
export interface Expansion { allows: AllowSite[]; matches: MatchSite[]; warnings: string[] }

const SERVICES: Record<string, Store> = { 'cloud.firestore': 'firestore', 'firebase.storage': 'storage' }
const PREFIX = {
  firestore: { first: 'databases', last: 'documents', display: '/databases/{database}/documents' },
  storage: { first: 'b', last: 'o', display: '/b/{bucket}/o' },
} as const

const OP_MAP: Record<AllowOp, readonly Op[]> = {
  read: ['read', 'list'],
  get: ['read'],
  list: ['list'],
  write: ['create', 'update', 'delete'],
  create: ['create'],
  update: ['update'],
  delete: ['delete'],
}

/** Rules ops to Holdline ops, deduped, in core `OPS` order. */
export function expandOps(ops: readonly AllowOp[]): Op[] {
  const wanted = new Set<Op>(ops.flatMap(op => OP_MAP[op]))
  return OPS.filter(op => wanted.has(op))
}

function hasPrefix(store: Store, segs: readonly MatchSegment[]): boolean {
  const [a, b, c] = segs
  const p = PREFIX[store]
  return a?.kind === 'literal' && a.value === p.first
    && b?.kind === 'wildcard' && !b.rest
    && c?.kind === 'literal' && c.value === p.last
}

class Expander {
  readonly out: Expansion = { allows: [], matches: [], warnings: [] }
  private readonly interps = new Map<MatchSegment, number>()
  private readonly seenTargets = new Set<string>()

  private render(segs: readonly MatchSegment[]): string {
    if (segs.length === 0) return '/'
    return '/' + segs.map(s => {
      if (s.kind === 'literal') return s.value
      if (s.kind === 'wildcard') return s.rest ? `{${s.name}=**}` : `{${s.name}}`
      let n = this.interps.get(s)
      if (n === undefined) { n = this.interps.size + 1; this.interps.set(s, n) }
      return `{_interp${n}}`
    }).join('/')
  }

  private target(store: Store, segs: readonly MatchSegment[]): string {
    return this.render(hasPrefix(store, segs) ? segs.slice(3) : segs)
  }

  service(svc: Service): void {
    const store = SERVICES[svc.name]
    if (!store) {
      this.out.warnings.push(`service ${svc.name} is not Firestore or Storage; skipped`)
      return
    }
    this.block(store, svc.body, [], new Scope(undefined, new Set()), true)
  }

  private block(store: Store, body: Block, segs: MatchSegment[], scope: Scope, top: boolean): void {
    for (const fn of body.functions) scope.functions.set(fn.name, { decl: fn, scope })
    for (const allow of body.allows) {
      this.out.allows.push({ store, target: this.target(store, segs), ops: expandOps(allow.ops), allow, scope })
    }
    for (const m of body.matches) this.match(store, m, segs, scope, top)
  }

  private match(store: Store, m: Match, outer: MatchSegment[], scope: Scope, top: boolean): void {
    const segs = [...outer, ...m.path]
    if (top && !hasPrefix(store, segs)) {
      this.out.warnings.push(`match ${this.render(segs)} is not under ${PREFIX[store].display}`)
    }
    const target = this.target(store, segs)
    if (!this.seenTargets.has(target)) {
      this.seenTargets.add(target)
      this.out.matches.push({ store, target, line: m.line })
    }
    const names = m.path.flatMap(s => (s.kind === 'wildcard' ? [s.name] : []))
    this.block(store, m.body, segs, new Scope(scope, new Set(names)), false)
  }
}

export function expandRules(ast: RulesAst): Expansion {
  const x = new Expander()
  for (const svc of ast.services) x.service(svc)
  return x.out
}

/** One id per allow site and op, in order. Same target, op and line on a later allow adds `:<col>`. */
export function policyIds(sites: readonly AllowSite[]): string[] {
  const seen = new Set<string>()
  const ids: string[] = []
  for (const s of sites) {
    for (const op of s.ops) {
      let id = `${s.store}:${s.target}#${op}@${s.allow.line}`
      if (seen.has(id)) id += `:${s.allow.col}`
      seen.add(id)
      ids.push(id)
    }
  }
  return ids
}
