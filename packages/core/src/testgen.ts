import { deepEqual } from './canonical.js'
import { isLookupOperand, type Atom } from './expr.js'
import { formatAtom } from './format.js'
import { hashRule } from './hash.js'
import { expand, flattenAnd, type Vocabulary } from './logic.js'
import { concretize } from './paths.js'
import type { DataAccessRule, Rule } from './rules.js'
import type { TestCase, TestFile } from './testcase.js'
import type { Op } from './facts.js'
import { denyWorld } from './testgen-deny.js'
import { holds } from './testgen-eval.js'
import { satisfy } from './testgen-satisfy.js'
import { Unsupported, type World } from './testgen-world.js'

export function generateTests(rule: Rule, vocab: Vocabulary): TestFile | undefined {
  if (rule.type !== 'data-access') return undefined
  const base = { rule: rule.id, generatedFrom: hashRule(rule, vocab), store: rule.target.store, cases: [] as TestCase[], skipped: [] as string[] }
  const parts = flattenAnd(expand(rule.requires, vocab))
  if (!parts.every((p): p is { atom: Atom } => 'atom' in p)) {
    return { ...base, skipped: ['the requirement must be only "and" of atoms to generate cases; check it statically'] }
  }
  const atoms = parts.map(p => p.atom).filter((a, i, all) => all.findIndex(b => deepEqual(a, b)) === i)
  try {
    const satisfied = satisfy(atoms, rule)
    const unmet = atoms.find(a => !holds(satisfied, a))
    if (unmet) throw new Unsupported(`cannot satisfy ${formatAtom(unmet)} together with the other conditions`)
    const readsRecord = satisfied.recordLookup || atoms.some(readsStoredRecord)
    const denies = atoms.map((_, i) => denyWorld(atoms, i, rule, satisfied))
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
        const denied = denies[i]
        if (denied) base.cases.push(toCase(`${op}: denied without ${formatAtom(a)}`, denied, satisfied, rule, op, 'deny'))
        else base.skipped.push(`${op}: cannot deny only ${formatAtom(a)} (other conditions depend on the same values)`)
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
