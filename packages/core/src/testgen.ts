import { deepEqual } from './canonical.js'
import { isLookupOperand, type Atom } from './expr.js'
import { formatAtom } from './format.js'
import { hashRule } from './hash.js'
import { expand, flattenAnd, type Vocabulary } from './logic.js'
import type { Rule } from './rules.js'
import type { TestCase, TestFile } from './testcase.js'
import { toCase } from './testgen-case.js'
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
    const readsWrite = atoms.some(readsIncoming)
    for (const op of rule.ops) {
      if (readsWrite && (op === 'read' || op === 'list' || op === 'delete')) {
        base.skipped.push(`${op}: the condition reads the incoming write, which ${op} does not send`)
        continue
      }
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

// True when an atom reads `<root>.*` directly or in a lookup or `exists` path placeholder.
function reads(a: Atom, root: 'resource' | 'incoming'): boolean {
  const mentions = (o: unknown) =>
    typeof o === 'string' && (o.startsWith(`${root}.`) || (isLookupOperand(o) && o.includes(`{${root}.`)))
  if (a.op === 'exists') return a.doc.includes(`{${root}.`)
  if (a.op === 'authenticated') return false
  if (a.op === 'isNull') return mentions(a.operand)
  return Object.values(a).some(mentions)
}

const readsStoredRecord = (a: Atom) => reads(a, 'resource')
// Only create and update send data, so a condition on it cannot be tested on read, list or delete.
const readsIncoming = (a: Atom) => reads(a, 'incoming')
