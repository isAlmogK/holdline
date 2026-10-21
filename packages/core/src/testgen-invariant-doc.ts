import { FactIndex } from './fact-index.js'
import type { Facts, Policy } from './facts.js'
import { andAtoms, expand } from './logic.js'
import type { DataAccessRule, InvariantRule } from './rules.js'
import type { TestCase, TestFile } from './testcase.js'
import { toCase } from './testgen-case.js'
import { holds } from './testgen-eval.js'
import { INVALID_ENUM } from './testgen-invariant.js'
import { satisfy } from './testgen-satisfy.js'
import { set, Unsupported, type World } from './testgen-world.js'

// Firestore invariant cases (spec 5.4): `create` against the write rules, allowed with the field valid and
// denied with it missing (`not-null`) or not in the list (`enum`). The allowed world satisfies one of the
// target's create policies from the facts, so the case tests the field and not the rest of the condition.
export function firestoreInvariantCases(rule: InvariantRule, facts: Facts | undefined): Pick<TestFile, 'cases' | 'skipped'> {
  if (rule.target.store !== 'firestore') throw new Error('firestore invariants only')
  const target = rule.target
  const none = { cases: [], skipped: [`create: no create policy for ${target.path} in the facts that cases can be generated for`] }
  if (!facts || (rule.kind !== 'not-null' && rule.kind !== 'enum')) return none
  const policies = new FactIndex(facts).policies(target, 'create')
  for (const policy of policies) {
    const access: DataAccessRule = { id: rule.id, text: rule.text, type: 'data-access', target, ops: ['create'], requires: policy.condition, evidence: [], status: 'approved' }
    const world = allowWorld(access, rule)
    if (!world) continue
    const cases: TestCase[] = []
    const skipped: string[] = []
    const allowName = rule.kind === 'enum' ? `create: allowed with a valid ${rule.columns.join(', ')}` : `create: allowed with ${rule.columns.join(', ')} set`
    cases.push(toCase(allowName, world, world, access, 'create', 'allow'))
    for (const c of rule.columns) {
      const denied = structuredClone(world)
      if (rule.kind === 'enum') denied.incoming[c] = INVALID_ENUM
      else delete denied.incoming[c]
      // Firestore ORs the create rules, so another policy that lets the denied write through makes the case wrong.
      const why = otherPolicyAllows(denied, policies.filter(p => p.id !== policy.id))
      if (why) {
        skipped.push(`create: cannot deny only ${c} (${why})`)
        continue
      }
      const name = rule.kind === 'enum' ? `create: denied with ${c} '${INVALID_ENUM}'` : `create: denied without ${c}`
      cases.push(toCase(name, denied, denied, access, 'create', 'deny'))
    }
    return { cases, skipped }
  }
  return none
}

function otherPolicyAllows(denied: World, others: Policy[]): string | undefined {
  for (const other of others) {
    const atoms = andAtoms(expand(other.condition, new Map()))
    if (!atoms) return `create policy ${other.id} cannot be evaluated`
    if (atoms.every(a => holds(denied, a, 'create'))) return `another create policy allows it: ${other.id}`
  }
  return undefined
}

function allowWorld(access: DataAccessRule, rule: InvariantRule): World | undefined {
  const atoms = andAtoms(expand(access.requires, new Map()))
  if (!atoms) return undefined
  const pins = rule.kind === 'enum' ? rule.columns.map(c => ({ operand: `incoming.${c}`, value: rule.values![0] })) : []
  try {
    const w = satisfy(atoms, access, { pins })
    if (rule.kind === 'not-null') for (const c of rule.columns) if (w.incoming[c] === undefined) set(w, `incoming.${c}`, `present-1`)
    return atoms.every(a => holds(w, a, 'create')) ? w : undefined
  } catch (e) {
    if (e instanceof Unsupported) return undefined
    throw e
  }
}
