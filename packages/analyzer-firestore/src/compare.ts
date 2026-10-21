import { deepEqual, type ComparisonOp, type Expr, type Literal, type Operand } from '@holdline/core'
import type { BinaryOp } from './ast.js'
import type { Value } from './value.js'

const OPS: Partial<Record<BinaryOp, ComparisonOp>> = { '==': 'eq', '!=': 'ne', '<': 'lt', '>': 'gt', in: 'in' }

type Side = Extract<Value, { kind: 'operand' } | { kind: 'literal' }>

/** What Firestore gives for `a op b` on literals. True when unsure, so an unsure fallback stays opaque. */
function holdsFirestore(op: ComparisonOp, a: Literal, b: Literal): boolean {
  switch (op) {
    case 'eq': return deepEqual(a, b)
    case 'ne': return !deepEqual(a, b)
    // `!Array.isArray(b)` is unreachable: compareValues rejects a non-array literal on the right of `in` first.
    case 'in': return !Array.isArray(b) || b.some(x => deepEqual(x, a))
    case 'lt': return typeof a === 'number' && typeof b === 'number' ? a < b : true
    case 'gt': return typeof a === 'number' && typeof b === 'number' ? a > b : true
  }
}

/** What the Holdline model gives for `a op b` when one side is an absent field (null). */
function holdsModel(op: ComparisonOp, a: Literal, b: Literal): boolean {
  switch (op) {
    case 'eq': return deepEqual(a, b)
    case 'ne': return !deepEqual(a, b)
    case 'in': return Array.isArray(b) && b.some(x => deepEqual(x, a))
    case 'lt':
    case 'gt': return false
  }
}

/**
 * `x.get('f', d) op L` maps to `x.f op L` only when an absent field gives false both in Firestore (`d op L`)
 * and in the model (`null op L`), so the atom is exact. A null `d` is the model's own absent value.
 */
function fallbackExact(op: ComparisonOp, l: Side, r: Side): boolean {
  const fl = l.kind === 'operand' ? l.fallback : undefined
  const fr = r.kind === 'operand' ? r.fallback : undefined
  const left = fl && fl.value !== null ? fl.value : undefined
  const right = fr && fr.value !== null ? fr.value : undefined
  if (left === undefined && right === undefined) return true
  if (left !== undefined && right !== undefined) return false
  if (right !== undefined && op === 'in') return false
  if (left !== undefined) {
    if (r.kind !== 'literal') return false
    return !holdsFirestore(op, left, r.value) && !holdsModel(op, null, r.value)
  }
  if (l.kind !== 'literal') return false
  return !holdsFirestore(op, l.value, right!) && !holdsModel(op, l.value, null)
}

const toOperand = (v: Side): Operand => (v.kind === 'operand' ? v.operand : { literal: v.value })

/**
 * `left op right` with resolved sides, or undefined when it cannot be mapped exactly (the caller makes the
 * whole comparison opaque). An atom that reads `request.auth` gets its own `authenticated`.
 */
export function compareValues(op: BinaryOp, l: Value | undefined, r: Value | undefined): Expr | undefined {
  const atomOp = OPS[op]
  if (!l || !r || !atomOp) return undefined
  if ((l.kind !== 'operand' && l.kind !== 'literal') || (r.kind !== 'operand' && r.kind !== 'literal')) return undefined
  if (l.kind === 'literal' && r.kind === 'literal') return undefined
  if (atomOp === 'in' && r.kind === 'literal' && !Array.isArray(r.value)) return undefined
  if (!fallbackExact(atomOp, l, r)) return undefined
  const atom: Expr = { atom: { op: atomOp, left: toOperand(l), right: toOperand(r) } }
  const auth = (l.kind === 'operand' && l.auth) || (r.kind === 'operand' && r.auth)
  return auth ? { and: [{ atom: { op: 'authenticated' } }, atom] } : atom
}
