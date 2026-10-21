import { deepEqual } from './canonical.js'
import { isLookupOperand, type Atom, type Operand } from './expr.js'
import { formatAtom } from './format.js'
import { hashRule } from './hash.js'
import { expand, flattenAnd, type Vocabulary } from './logic.js'
import { concretize } from './paths.js'
import type { DataAccessRule, Rule } from './rules.js'
import type { TestCase, TestFile } from './testcase.js'
import type { Op } from './facts.js'
import { addDoc, nextValue, read, resolveDoc, set, settable, Unsupported, type World } from './testgen-world.js'

export function generateTests(rule: Rule, vocab: Vocabulary): TestFile | undefined {
  if (rule.type !== 'data-access') return undefined
  const base = { rule: rule.id, generatedFrom: hashRule(rule, vocab), store: rule.target.store, cases: [] as TestCase[], skipped: [] as string[] }
  const parts = flattenAnd(expand(rule.requires, vocab))
  if (!parts.every((p): p is { atom: Atom } => 'atom' in p)) {
    return { ...base, skipped: ['the requirement must be only "and" of atoms to generate cases; check it statically'] }
  }
  const atoms = parts.map(p => p.atom).filter((a, i, all) => all.findIndex(b => deepEqual(a, b)) === i)
  const readsRecord = atoms.some(readsStoredRecord)
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
  return { actor: { uid: 'user-1', claims: {} }, params, resource: {}, incoming: {}, docs: [], counter: 0 }
}

const usesLookup = (a: Atom): boolean =>
  a.op === 'isNull' ? isLookupOperand(a.operand) : a.op !== 'authenticated' && a.op !== 'exists' && (isLookupOperand(a.left) || isLookupOperand(a.right))

// Plain atoms first, then lookups (they may create the stored-record fields their paths need), then `exists`.
const stage = (a: Atom) => (a.op === 'exists' ? 2 : usesLookup(a) ? 1 : 0)

function satisfy(atoms: Atom[], rule: DataAccessRule, skip = -1): World {
  const w = freshWorld(rule)
  const order = atoms.map((a, i) => ({ a, i })).sort((x, y) => stage(x.a) - stage(y.a))
  for (const { a, i } of order) {
    if (i === skip) continue
    switch (a.op) {
      case 'authenticated': break
      case 'isNull': set(w, a.operand, null); break
      case 'in': {
        if (isLookupOperand(a.right)) {
          const l = read(w, a.left)
          const v = l.fixed ? l.value : nextValue(w)
          if (!l.fixed) set(w, a.left, v)
          set(w, a.right, [v]); break
        }
        const v = literalValue(a.right)
        if (!Array.isArray(v) || v.length === 0) throw new Unsupported(`cannot satisfy ${formatAtom(a)}`)
        set(w, a.left, v[0]); break
      }
      case 'eq': {
        const l = read(w, a.left)
        const r = read(w, a.right)
        if (l.fixed) set(w, a.right, l.value)
        else if (r.fixed) set(w, a.left, r.value)
        else { const v = nextValue(w); set(w, a.left, v); set(w, a.right, v) }
        break
      }
      case 'exists': addDoc(w, resolveDoc(w, a.doc)); break
      default: throw new Unsupported(`${a.op} conditions are not generated yet (${formatAtom(a)}); check them statically`)
    }
  }
  return w
}

function breakAtom(atoms: Atom[], index: number, rule: DataAccessRule): World {
  const a = atoms[index]!
  if (a.op === 'exists') {
    const w = satisfy(atoms, rule, index)
    // A lookup on the same document would seed it again, so the missing document must be removed too.
    if (!a.doc.startsWith('pg:')) {
      const path = resolveDoc(satisfy(atoms, rule), a.doc).path
      w.docs = w.docs.filter(d => d.path !== path)
    }
    return w
  }
  const w = satisfy(atoms, rule)
  switch (a.op) {
    case 'authenticated': w.actor = null; break
    case 'isNull': set(w, a.operand, 'not-null', true); break
    case 'in': {
      if (!isLookupOperand(a.right)) { set(w, a.left, 'not-allowed', true); break }
      if (isRecordOperand(a.left)) set(w, a.left, 'other-value', true)
      else set(w, a.right, ['other-value'], true)
      break
    }
    case 'eq': {
      // Prefer breaking the stored or incoming record, then a looked-up field; fall back to the actor's claims or role.
      const sides = [a.left, a.right]
      const side = sides.find(isRecordOperand) ?? sides.find(isLookupOperand) ?? sides.find(settable)
      if (side) set(w, side, 'other-value', true)
      else if (w.actor) w.actor.uid = 'user-2'
      break
    }
  }
  return w
}

const isRecordOperand = (o: Operand) => typeof o === 'string' && /^(resource|incoming)\./.test(o)

function toCase(name: string, w: World, dataWorld: World, rule: DataAccessRule, op: Op, expect: 'allow' | 'deny'): TestCase {
  const path = rule.target.store === 'postgres' ? storePath(rule) : concretize(targetPath(rule), p => w.params[p] ?? `${p}-1`)
  const record = structuredClone(w.resource)
  const seed = structuredClone([...(op === 'create' ? [] : [{ path: storePath(rule), data: record }]), ...w.docs])
  const data = op === 'create' || op === 'update' ? structuredClone({ ...dataWorld.resource, ...w.incoming }) : undefined
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

function readsStoredRecord(a: Atom): boolean {
  const isResource = (o: unknown) =>
    typeof o === 'string' && (o.startsWith('resource.') || (isLookupOperand(o) && o.includes('{resource.')))
  if (a.op === 'exists') return a.doc.includes('{resource.')
  if (a.op === 'authenticated') return false
  if (a.op === 'isNull') return isResource(a.operand)
  return Object.values(a).some(isResource)
}

function literalValue(o: Operand): unknown {
  return typeof o === 'string' ? undefined : o.literal
}
