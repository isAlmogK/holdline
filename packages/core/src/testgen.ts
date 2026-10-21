import { canonicalJson, deepEqual } from './canonical.js'
import type { Atom, Operand } from './expr.js'
import { formatAtom } from './format.js'
import { hashRule } from './hash.js'
import { expand, flattenAnd, type Vocabulary } from './logic.js'
import { concretize } from './paths.js'
import type { DataAccessRule, Rule } from './rules.js'
import type { TestCase, TestFile } from './testcase.js'
import type { Op } from './facts.js'

type Actor = { uid: string; role?: string; claims: Record<string, unknown> }
type World = {
  actor: Actor | null
  params: Record<string, string>
  resource: Record<string, unknown>
  incoming: Record<string, unknown>
  docs: { path: string; data: Record<string, unknown> }[]
}

class Unsupported extends Error {}

export function generateTests(rule: Rule, vocab: Vocabulary): TestFile | undefined {
  if (rule.type !== 'data-access') return undefined
  const base = { rule: rule.id, generatedFrom: hashRule(rule, vocab), store: rule.target.store, cases: [] as TestCase[], skipped: [] as string[] }
  const parts = flattenAnd(expand(rule.requires, vocab))
  if (!parts.every((p): p is { atom: Atom } => 'atom' in p)) {
    return { ...base, skipped: ['the requirement must be only "and" of atoms to generate cases; check it statically'] }
  }
  const atoms = parts.map(p => p.atom).filter((a, i, all) => all.findIndex(b => deepEqual(a, b)) === i)
  const readsRecord = atoms.some(a => canonicalJson(a).includes('resource.'))
  try {
    const satisfied = satisfy(atoms, rule)
    for (const op of rule.ops) {
      if (op === 'list' && Object.keys(satisfied.resource).length > 0) {
        base.skipped.push('list: needs query filters to test; read cases cover the condition')
        continue
      }
      if (op === 'create' && readsRecord) {
        base.skipped.push('create: the condition reads the stored record, which does not exist on create')
        continue
      }
      base.cases.push(toCase(`${op}: allowed when every condition holds`, satisfied, satisfied, rule, op, 'allow'))
      atoms.forEach((a, i) => {
        base.cases.push(toCase(`${op}: denied without ${formatAtom(a)}`, breakAtom(atoms, i, rule), satisfied, rule, op, 'deny'))
      })
    }
  } catch (e) {
    if (!(e instanceof Unsupported)) throw e
    return { ...base, cases: [], skipped: [e.message] }
  }
  return base
}

function targetPath(rule: DataAccessRule): string {
  return rule.target.store === 'postgres' ? rule.target.table : rule.target.path
}

function freshWorld(rule: DataAccessRule): World {
  const params: Record<string, string> = {}
  if (rule.target.store !== 'postgres') concretize(rule.target.path, name => (params[name] = `${name}-1`))
  return { actor: { uid: 'user-1', claims: {} }, params, resource: {}, incoming: {}, docs: [] }
}

function satisfy(atoms: Atom[], rule: DataAccessRule, skip = -1): World {
  const w = freshWorld(rule)
  let counter = 0
  const order = atoms.map((a, i) => ({ a, i })).sort((x, y) => Number(x.a.op === 'exists') - Number(y.a.op === 'exists'))
  for (const { a, i } of order) {
    if (i === skip) continue
    switch (a.op) {
      case 'authenticated': break
      case 'isNull': set(w, a.operand, null); break
      case 'in': {
        const v = literalValue(a.right)
        if (!Array.isArray(v) || v.length === 0) throw new Unsupported(`cannot satisfy ${formatAtom(a)}`)
        set(w, a.left, v[0]); break
      }
      case 'eq': {
        const l = read(w, a.left)
        const r = read(w, a.right)
        if (l.fixed) set(w, a.right, l.value)
        else if (r.fixed) set(w, a.left, r.value)
        else { const v = `value-${++counter}`; set(w, a.left, v); set(w, a.right, v) }
        break
      }
      case 'exists': w.docs.push(resolveDoc(w, a.doc)); break
      default: throw new Unsupported(`${a.op} conditions are not generated yet (${formatAtom(a)}); check them statically`)
    }
  }
  return w
}

function breakAtom(atoms: Atom[], index: number, rule: DataAccessRule): World {
  const a = atoms[index]!
  if (a.op === 'exists') return satisfy(atoms, rule, index)
  const w = satisfy(atoms, rule)
  switch (a.op) {
    case 'authenticated': w.actor = null; break
    case 'isNull': set(w, a.operand, 'not-null', true); break
    case 'in': set(w, a.left, 'not-allowed', true); break
    case 'eq': {
      // Prefer breaking the stored or incoming record; fall back to the actor's claims or role.
      const sides = [a.left, a.right]
      const side = sides.find(o => typeof o === 'string' && /^(resource|incoming)\./.test(o)) ?? sides.find(settable)
      if (side) set(w, side, 'other-value', true)
      else if (w.actor) w.actor.uid = 'user-2'
      break
    }
  }
  return w
}

function toCase(name: string, w: World, dataWorld: World, rule: DataAccessRule, op: Op, expect: 'allow' | 'deny'): TestCase {
  const path = rule.target.store === 'postgres' ? storePath(rule) : concretize(targetPath(rule), p => w.params[p] ?? `${p}-1`)
  const record = structuredClone(w.resource)
  const seed = structuredClone([...(op === 'create' ? [] : [{ path: storePath(rule), data: record }]), ...w.docs])
  const data = op === 'create' || op === 'update' ? structuredClone({ ...dataWorld.resource, ...dataWorld.incoming }) : undefined
  const listPath = path.split('/').slice(0, -1).join('/')
  return {
    name,
    as: w.actor ? { ...w.actor, claims: { ...w.actor.claims } } : null,
    seed: rule.target.store === 'postgres' ? seed : seed.map(s => (s.path === storePath(rule) ? { ...s, path } : s)),
    do: { op, path: op === 'list' && rule.target.store !== 'postgres' ? listPath : path, ...(data ? { data } : {}) },
    expect,
  }
}

function storePath(rule: DataAccessRule): string {
  return rule.target.store === 'postgres' ? rule.target.table.includes('.') ? rule.target.table : `public.${rule.target.table}` : targetPath(rule)
}

function literalValue(o: Operand): unknown {
  return typeof o === 'string' ? undefined : o.literal
}

function settable(o: Operand): boolean {
  return typeof o === 'string' && /^(resource|incoming|actor\.claim|actor\.role)/.test(o)
}

function read(w: World, o: Operand): { fixed: boolean; value: unknown } {
  if (typeof o !== 'string') return { fixed: true, value: o.literal }
  if (o === 'actor.uid') return { fixed: true, value: w.actor?.uid }
  if (o.startsWith('param.')) return { fixed: true, value: w.params[o.slice(6)] ?? `${o.slice(6)}-1` }
  return { fixed: false, value: undefined }
}

function assign(target: Record<string, unknown>, key: string, o: string, value: unknown, force: boolean): void {
  if (key.includes('.')) throw new Unsupported(`nested field ${o} is not generated yet; check it statically`)
  if (!force && key in target && !deepEqual(target[key], value)) throw new Unsupported(`conflicting conditions on ${o}; check them statically`)
  target[key] = value
}

function set(w: World, o: Operand, value: unknown, force = false): void {
  if (typeof o !== 'string') throw new Unsupported(`cannot set a literal to ${JSON.stringify(value)}`)
  if (o.startsWith('resource.')) assign(w.resource, o.slice(9), o, value, force)
  else if (o.startsWith('incoming.')) assign(w.incoming, o.slice(9), o, value, force)
  else if (o.startsWith('actor.claim.') && w.actor) assign(w.actor.claims, o.slice(12), o, value, force)
  else if (o === 'actor.role' && w.actor) {
    if (!force && w.actor.role !== undefined && w.actor.role !== String(value)) throw new Unsupported(`conflicting conditions on ${o}; check them statically`)
    w.actor.role = String(value)
  } else throw new Unsupported(`cannot set ${o} to ${JSON.stringify(value)}`)
}

function resolveDoc(w: World, doc: string): { path: string; data: Record<string, unknown> } {
  const fill = (operand: string) => {
    const r = read(w, operand)
    const v = r.fixed ? r.value : valueOf(w, operand)
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
