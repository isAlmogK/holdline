import { isLookupOperand, type Atom, type Operand } from './expr.js'
import { mentionsOperand } from './logic.js'
import type { DataAccessRule } from './rules.js'
import { holds } from './testgen-eval.js'
import { satisfy, type Pin } from './testgen-satisfy.js'
import { current, set, settable, Unsupported, type World } from './testgen-world.js'

const isRecordOperand = (o: Operand) => typeof o === 'string' && /^(resource|incoming)\./.test(o)
const pinnable = (o: Operand): o is string => typeof o === 'string' && (settable(o) || isLookupOperand(o))
const operandsOf = (a: Atom): Operand[] =>
  a.op === 'authenticated' || a.op === 'exists' ? [] : a.op === 'isNull' ? [a.operand] : [a.left, a.right]

// Pins that falsify one atom, in order of preference: the stored or incoming record, then a looked-up field,
// then a claim or role. A pin whose operand no other atom reads or builds a path from is tried first.
function pinsFor(a: Atom, others: Atom[]): Pin[] {
  const out: Pin[] = []
  const add = (o: Operand, value: unknown) => { if (pinnable(o)) out.push({ operand: o, value }) }
  if (a.op === 'isNull') add(a.operand, 'not-null')
  else if (a.op === 'in' && isLookupOperand(a.right)) {
    add(a.left, 'other-value')
    add(a.right, ['other-value'])
  } else if (a.op === 'in') add(a.left, 'not-allowed')
  else if (a.op === 'eq') {
    const sides = [a.left, a.right]
    for (const o of [...sides.filter(isRecordOperand), ...sides.filter(isLookupOperand), ...sides.filter(settable)]) {
      if (!out.some(p => p.operand === o)) add(o, 'other-value')
    }
  }
  const referenced = (p: Pin) => others.some(b => mentionsOperand({ atom: b }, p.operand))
  return out.filter(p => !referenced(p)).concat(out.filter(referenced))
}

// Gives the broken atom's other operands the values they have in the allowed world, so a deny case
// differs from the allowed one by the pin and what the pin forces.
function copyOperands(w: World, allow: World, a: Atom): void {
  for (const o of operandsOf(a)) {
    if (!pinnable(o)) continue
    try {
      const v = current(allow, o)
      if (current(w, o) === undefined && v !== undefined) set(w, o, v)
    } catch (e) {
      if (!(e instanceof Unsupported)) throw e
    }
  }
}

// Builds a world where atom `index` is false and every other atom holds, by solving again around a
// falsifying pin (not by editing the allowed world, which would leave paths keyed on the old value).
// Returns `undefined` when no such world exists.
export function denyWorld(atoms: Atom[], index: number, rule: DataAccessRule, allow: World): World | undefined {
  const a = atoms[index]!
  const only = (w: World) => atoms.every((b, j) => holds(w, b) === (j !== index))
  const attempt = (build: () => World): World | undefined => {
    try {
      const w = build()
      return only(w) ? w : undefined
    } catch (e) {
      if (e instanceof Unsupported) return undefined
      throw e
    }
  }
  if (a.op === 'authenticated') {
    // An anonymous caller also fails every atom that reads the actor; that cannot be avoided.
    const w = structuredClone(allow)
    w.actor = null
    return w
  }
  if (a.op === 'exists') return attempt(() => satisfy(atoms, rule, { skip: index }))
  const others = atoms.filter((_, j) => j !== index)
  for (const pin of pinsFor(a, others)) {
    const w = attempt(() => {
      const w = satisfy(atoms, rule, { skip: index, pins: [pin] })
      copyOperands(w, allow, a)
      return w
    })
    if (w) return w
  }
  // Last resort for `eq` on the actor id: another caller.
  if (a.op !== 'eq') return undefined
  return attempt(() => {
    const w = structuredClone(allow)
    if (w.actor) w.actor.uid = 'user-2'
    return w
  })
}
