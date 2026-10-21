import { canonicalJson, deepEqual } from './canonical.js'
import { isLookupOperand, type Atom } from './expr.js'
import { formatAtom } from './format.js'
import { hashRule } from './hash.js'
import { andAtoms, expand, type Vocabulary } from './logic.js'
import type { DataAccessRule, InvariantRule, Rule } from './rules.js'
import type { TestCase, TestFile } from './testcase.js'
import type { Facts, Op } from './facts.js'
import { toCase } from './testgen-case.js'
import { denyWorld } from './testgen-deny.js'
import { holds } from './testgen-eval.js'
import { postgresInvariantCases } from './testgen-invariant.js'
import { firestoreInvariantCases } from './testgen-invariant-doc.js'
import { policyAtoms } from './testgen-policy.js'
import { satisfy } from './testgen-satisfy.js'
import { Unsupported, type World } from './testgen-world.js'

type Solved = { satisfied: World; denies: (World | undefined)[] }

export function generateTests(rule: Rule, vocab: Vocabulary, facts?: Facts): TestFile | undefined {
  if (rule.type === 'invariant') return invariantTests(rule, vocab, facts)
  if (rule.type !== 'data-access') return undefined
  const base = { rule: rule.id, generatedFrom: hashRule(rule, vocab), store: rule.target.store, cases: [] as TestCase[], skipped: [] as string[] }
  const parts = andAtoms(expand(rule.requires, vocab))
  if (!parts) {
    return { ...base, skipped: ['the requirement must be only "and" of atoms to generate cases; check it statically'] }
  }
  const ruleAtoms = parts.filter((a, i, all) => all.findIndex(b => deepEqual(a, b)) === i)
  // Ops whose policies add the same atoms share one solution.
  const solutions = new Map<string, Solved>()
  const solve = (atoms: Atom[]): Solved => {
    const key = canonicalJson(atoms)
    const known = solutions.get(key)
    if (known) return known
    const solved = solveAtoms(atoms, ruleAtoms.length, rule)
    solutions.set(key, solved)
    return solved
  }
  try {
    // A rule the generator cannot satisfy on its own skips the whole file, with or without facts.
    solve(ruleAtoms)
    for (const op of rule.ops) {
      const atoms = facts ? [...ruleAtoms, ...policyAtoms(rule, op, ruleAtoms, vocab, facts)] : ruleAtoms
      const { satisfied, denies } = solve(atoms)
      const skip = opSkip(op, atoms, satisfied)
      if (skip) {
        base.skipped.push(skip)
        continue
      }
      base.cases.push(toCase(`${op}: allowed when every condition holds`, satisfied, satisfied, rule, op, 'allow'))
      ruleAtoms.forEach((a, i) => {
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

// The allowed world for `atoms`, and a deny world for each of the first `denyCount` atoms (the rule's own):
// every other atom, a policy's extra atoms included, still holds in it.
function solveAtoms(atoms: Atom[], denyCount: number, rule: DataAccessRule): Solved {
  const satisfied = satisfy(atoms, rule)
  const unmet = atoms.find(a => !holds(satisfied, a))
  if (unmet) throw new Unsupported(`cannot satisfy ${formatAtom(unmet)} together with the other conditions`)
  const denies = atoms.slice(0, denyCount).map((_, i) => denyWorld(atoms, i, rule, satisfied))
  return { satisfied, denies }
}

function opSkip(op: Op, atoms: Atom[], satisfied: World): string | undefined {
  if ((op === 'read' || op === 'list' || op === 'delete') && atoms.some(readsIncoming)) {
    return `${op}: the condition reads the incoming write, which ${op} does not send`
  }
  if (op === 'list' && Object.keys(satisfied.resource).length > 0) return 'list: needs query filters to test; read cases cover the condition'
  if (op === 'create' && (satisfied.recordLookup || atoms.some(readsStoredRecord))) {
    return 'create: the condition reads the stored record, which does not exist on create'
  }
  return undefined
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

function invariantTests(rule: InvariantRule, vocab: Vocabulary, facts: Facts | undefined): TestFile {
  const base = { rule: rule.id, generatedFrom: hashRule(rule, vocab), store: rule.target.store }
  if (rule.target.store === 'storage') return { ...base, cases: [], skipped: ['storage invariants are not generated; check them statically'] }
  if (rule.target.store === 'postgres') return { ...base, ...postgresInvariantCases(rule as InvariantRule & { target: { store: 'postgres' } }, facts) }
  return { ...base, ...firestoreInvariantCases(rule, facts) }
}
