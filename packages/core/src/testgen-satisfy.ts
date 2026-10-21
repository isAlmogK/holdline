import { isLookupOperand, type Atom } from './expr.js'
import { formatAtom } from './format.js'
import { concretize } from './paths.js'
import type { DataAccessRule } from './rules.js'
import { addDoc, current, nextValue, read, resolveDocCreating, set, Unsupported, type World } from './testgen-world.js'

// A pin fixes one operand to a value before the atoms are satisfied, so lookup and exists paths resolve against it.
export type Pin = { operand: string; value: unknown }

export const usesLookup = (a: Atom): boolean =>
  a.op === 'isNull' ? isLookupOperand(a.operand) : a.op !== 'authenticated' && a.op !== 'exists' && (isLookupOperand(a.left) || isLookupOperand(a.right))

// Plain atoms first, then lookups, then `exists` (both may create the stored-record fields their paths need).
const stage = (a: Atom) => (a.op === 'exists' ? 2 : usesLookup(a) ? 1 : 0)

export function freshWorld(rule: DataAccessRule): World {
  const params: Record<string, string> = {}
  if (rule.target.store !== 'postgres') concretize(rule.target.path, name => (params[name] = `${name}-1`))
  // Only a Firestore record is a document: in Storage rules, `exists` and lookups read Firestore, never the object.
  const targetPath = rule.target.store === 'firestore' ? concretize(rule.target.path, p => params[p] ?? `${p}-1`) : undefined
  return { actor: { uid: 'user-1', claims: {} }, params, resource: {}, incoming: {}, docs: [], counter: 0, targetPath, recordLookup: false }
}

// Builds the world where every atom holds, except `skip`. Pins on plain operands go first; pins on
// lookup operands go with the lookup atoms, after the plain atoms have fixed the values their paths need.
export function satisfy(atoms: Atom[], rule: DataAccessRule, opts: { skip?: number; pins?: Pin[] } = {}): World {
  const w = freshWorld(rule)
  const pins = opts.pins ?? []
  for (const p of pins) if (!isLookupOperand(p.operand)) set(w, p.operand, p.value)
  let lookupPinsDone = false
  const applyLookupPins = () => {
    for (const p of pins) if (isLookupOperand(p.operand)) set(w, p.operand, p.value)
    lookupPinsDone = true
  }
  const order = atoms.map((a, i) => ({ a, i })).sort((x, y) => stage(x.a) - stage(y.a))
  for (const { a, i } of order) {
    if (i === opts.skip) continue
    if (!lookupPinsDone && stage(a) >= 1) applyLookupPins()
    switch (a.op) {
      case 'authenticated': break
      case 'isNull': set(w, a.operand, null); break
      case 'in': {
        if (isLookupOperand(a.right)) {
          const l = read(w, a.left)
          let v = l.fixed ? l.value : current(w, a.left)
          if (v === undefined) { v = nextValue(w); set(w, a.left, v) }
          set(w, a.right, [v]); break
        }
        const v = typeof a.right === 'string' ? undefined : a.right.literal
        if (!Array.isArray(v) || v.length === 0) throw new Unsupported(`cannot satisfy ${formatAtom(a)}`)
        set(w, a.left, v[0]); break
      }
      case 'eq': {
        const l = read(w, a.left)
        const r = read(w, a.right)
        if (l.fixed) set(w, a.right, l.value)
        else if (r.fixed) set(w, a.left, r.value)
        else {
          const lv = current(w, a.left)
          const rv = current(w, a.right)
          if (lv !== undefined) set(w, a.right, lv)
          else if (rv !== undefined) set(w, a.left, rv)
          else { const v = nextValue(w); set(w, a.left, v); set(w, a.right, v) }
        }
        break
      }
      case 'exists': addDoc(w, resolveDocCreating(w, a.doc)); break
      default: throw new Unsupported(`${a.op} conditions are not generated yet (${formatAtom(a)}); check them statically`)
    }
  }
  if (!lookupPinsDone) applyLookupPins()
  return w
}
