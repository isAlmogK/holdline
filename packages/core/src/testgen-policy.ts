import { deepEqual } from './canonical.js'
import type { Atom } from './expr.js'
import { FactIndex } from './fact-index.js'
import type { Facts, Op } from './facts.js'
import { andAtoms, expand, type Vocabulary } from './logic.js'
import type { DataAccessRule } from './rules.js'
import { holds } from './testgen-eval.js'
import { satisfy } from './testgen-satisfy.js'
import { Unsupported } from './testgen-world.js'

// The atoms the store's real policy for `op` needs beyond the rule's own (`ruleAtoms`), so the allowed world
// passes the whole policy and not only the part the rule is about. Candidates are the target's policies for
// `op`, in facts order; the first that is only an "and" of atoms and that a world can satisfy together with the
// rule gives its extra atoms. `[]` when none does (the op then uses the rule atoms alone).
// `generatedFrom` hashes only the rule and vocabulary, so a test file reflects the facts at generation time.
export function policyAtoms(rule: DataAccessRule, op: Op, ruleAtoms: Atom[], vocab: Vocabulary, facts: Facts): Atom[] {
  for (const policy of new FactIndex(facts).policies(rule.target, op)) {
    const atoms = andAtoms(expand(policy.condition, vocab))
    if (!atoms) continue
    const extras = atoms.filter((a, i) =>
      !ruleAtoms.some(b => deepEqual(a, b)) && atoms.findIndex(b => deepEqual(a, b)) === i)
    if (satisfiable([...ruleAtoms, ...extras], rule, op)) return extras
  }
  return []
}

function satisfiable(atoms: Atom[], rule: DataAccessRule, op: Op): boolean {
  try {
    const w = satisfy(atoms, rule)
    return atoms.every(a => holds(w, a, op))
  } catch (e) {
    if (e instanceof Unsupported) return false
    throw e
  }
}
