import { canonicalJson } from './canonical.js'
import type { Atom } from './expr.js'
import { FactIndex } from './fact-index.js'
import type { Facts, Op } from './facts.js'
import { andAtoms, atomImplies, expand, type Vocabulary } from './logic.js'
import { parsePattern } from './paths.js'
import type { DataAccessRule } from './rules.js'
import { holds } from './testgen-eval.js'
import { satisfy } from './testgen-satisfy.js'
import { opSkip } from './testgen-skip.js'
import { Unsupported, type World } from './testgen-world.js'

// The atoms the store's real policy for `op` needs beyond the rule's own (`ruleAtoms`), so the allowed world
// passes the whole policy and not only the part the rule is about. Candidates are the target's policies for
// `op`, in facts order, with their path params renamed to the rule target's. The first that is only an "and" of
// atoms, names no path param the target lacks, can be satisfied together with the rule and adds no per-op skip
// gives its extra atoms. `[]` when none does (the op then uses the rule atoms alone).
// `generatedFrom` hashes only the rule and vocabulary, so a test file reflects the facts at generation time.
export function policyAtoms(rule: DataAccessRule, op: Op, ruleAtoms: Atom[], vocab: Vocabulary, facts: Facts): Atom[] {
  const alone = solveFor(ruleAtoms, rule, op)
  // When the rule's own atoms cannot be tested on this op, it is skipped either way: keep that reason.
  if (!alone || opSkip(op, ruleAtoms, alone)) return []
  const params = targetParams(rule)
  for (const { condition } of new FactIndex(facts).alignedPolicies(rule.target, op)) {
    const atoms = andAtoms(expand(condition, vocab))
    if (!atoms || atoms.some(a => paramsOf(a).some(p => !params.has(p)))) continue
    const extras = atoms.filter((a, i) =>
      !ruleAtoms.some(b => equivalent(a, b)) && atoms.findIndex(b => equivalent(a, b)) === i)
    const all = [...ruleAtoms, ...extras]
    const w = solveFor(all, rule, op)
    if (w && !opSkip(op, all, w)) return extras
  }
  return []
}

// Two forms of one condition (`a == b` and `b == a`) count as the same atom.
const equivalent = (a: Atom, b: Atom) => atomImplies(a, b) && atomImplies(b, a)

function targetParams(rule: DataAccessRule): Set<string> {
  if (rule.target.store === 'postgres') return new Set()
  return new Set(parsePattern(rule.target.path).flatMap(s => (s.kind === 'literal' ? [] : [s.name])))
}

// The path params an atom reads, as an operand or a `{param.x}` placeholder.
function paramsOf(a: Atom): string[] {
  return [...canonicalJson(a).matchAll(/\bparam\.([A-Za-z0-9_]+)/g)].map(m => m[1]!)
}

function solveFor(atoms: Atom[], rule: DataAccessRule, op: Op): World | undefined {
  try {
    const w = satisfy(atoms, rule)
    return atoms.every(a => holds(w, a, op)) ? w : undefined
  } catch (e) {
    if (e instanceof Unsupported) return undefined
    throw e
  }
}
