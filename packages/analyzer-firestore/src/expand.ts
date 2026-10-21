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

/**
 * How a concatenated match path relates to the document prefix (`/databases/{db}/documents`, Storage `/b/{bucket}/o`):
 * - `prefix`: its first three segments can match the prefix (first and third: the literal or a single-segment
 *   wildcard; second: any single segment, literal or wildcard), so they are stripped;
 * - `covering`: a rest wildcard (or an interpolation) occurs within the first three segments after segments
 *   that match, so the match can reach every document: its target is `/{<rest>=**}`;
 * - `outside`: it cannot match the prefix.
 */
type PrefixFit = { kind: 'prefix' } | { kind: 'covering'; seg: MatchSegment } | { kind: 'outside' }

function prefixFit(store: Store, segs: readonly MatchSegment[]): PrefixFit {
  const p = PREFIX[store]
  const expected = [p.first, undefined, p.last]
  for (let i = 0; i < 3; i++) {
    const s = segs[i]
    if (!s) return { kind: 'outside' }
    if (s.kind === 'interp' || (s.kind === 'wildcard' && s.rest)) return { kind: 'covering', seg: s }
    if (s.kind === 'literal' && expected[i] !== undefined && s.value !== expected[i]) return { kind: 'outside' }
  }
  return { kind: 'prefix' }
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
      return `{_interp${n}=**}`
    }).join('/')
  }

  private target(store: Store, segs: readonly MatchSegment[]): string {
    const fit = prefixFit(store, segs)
    if (fit.kind === 'prefix') return this.render(segs.slice(3))
    if (fit.kind === 'covering') return this.render([fit.seg])
    return this.render(segs)
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
    for (const fn of body.functions) {
      if (scope.functions.has(fn.name)) {
        this.out.warnings.push(`function ${fn.name} is declared twice in the same block; the last one is used`)
      }
      scope.functions.set(fn.name, { decl: fn, scope })
    }
    for (const allow of body.allows) {
      this.out.allows.push({ store, target: this.target(store, segs), ops: expandOps(allow.ops), allow, scope })
    }
    for (const m of body.matches) this.match(store, m, segs, scope, top)
  }

  /** True when a match holding allows (or a leaf match) in this subtree has a concatenated path without the prefix. */
  private outsidePrefix(store: Store, m: Match, outer: readonly MatchSegment[]): boolean {
    const segs = [...outer, ...m.path]
    const relevant = m.body.allows.length > 0 || m.body.matches.length === 0
    if (relevant && prefixFit(store, segs).kind === 'outside') return true
    return m.body.matches.some(c => this.outsidePrefix(store, c, segs))
  }

  private match(store: Store, m: Match, outer: MatchSegment[], scope: Scope, top: boolean): void {
    const segs = [...outer, ...m.path]
    if (top && this.outsidePrefix(store, m, outer)) {
      this.out.warnings.push(`match ${this.render(segs)} is not under ${PREFIX[store].display}`)
    }
    const target = this.target(store, segs)
    const key = `${store}:${target}`
    if (!this.seenTargets.has(key)) {
      this.seenTargets.add(key)
      this.out.matches.push({ store, target, line: m.line })
    }
    const names = m.path.flatMap(s => (s.kind === 'wildcard' ? [s.name] : []))
    const rest = m.path.flatMap(s => (s.kind === 'wildcard' && s.rest ? [s.name] : []))
    this.block(store, m.body, segs, new Scope(scope, new Set(names), new Set(rest)), false)
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
