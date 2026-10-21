import type { Atom, ComparisonOp, Expr, Operand } from './expr.js'

const SYMBOLS: Record<ComparisonOp, string> = { eq: '==', ne: '!=', in: 'in', lt: '<', gt: '>' }

export function formatOperand(o: Operand): string {
  return typeof o === 'string' ? o : JSON.stringify(o.literal)
}

export function formatAtom(a: Atom): string {
  switch (a.op) {
    case 'authenticated': return 'authenticated'
    case 'exists': return `exists(${a.doc})`
    case 'isNull': return `${formatOperand(a.operand)} is null`
    default: return `${formatOperand(a.left)} ${SYMBOLS[a.op]} ${formatOperand(a.right)}`
  }
}

export function formatExpr(e: Expr): string {
  if ('atom' in e) return formatAtom(e.atom)
  if ('ref' in e) return e.ref
  if ('opaque' in e) return `<${e.opaque}>`
  if ('not' in e) return `not (${formatExpr(e.not)})`
  if ('and' in e) return e.and.length === 0 ? 'true' : e.and.map(wrap).join(' and ')
  return e.or.length === 0 ? 'false' : e.or.map(wrap).join(' or ')
}

function wrap(e: Expr): string {
  return 'and' in e || 'or' in e ? `(${formatExpr(e)})` : formatExpr(e)
}
