import { FALSE, TRUE, type Expr } from '@holdline/core'
import type { Node } from './ast.js'
import { compareValues } from './compare.js'
import type { Env } from './scope.js'
import { resolveValue, type NormalizeContext, type Value } from './value.js'

/** A condition Holdline cannot map exactly, named by its source text with whitespace collapsed. */
export function opaque(node: Node, ctx: NormalizeContext): Expr {
  return { opaque: ctx.src.slice(node.start, node.end).replace(/\s+/g, ' ').trim() }
}

const TRUE_VALUE: Value = { kind: 'literal', value: true }
const isAuth = (v: Value | undefined) => v?.kind === 'object' && v.name === 'request.auth'
const isNull = (v: Value | undefined) => v?.kind === 'literal' && v.value === null

/** `request.auth == null` / `!= null` (either order), or undefined for any other comparison. */
function authCheck(node: Extract<Node, { type: 'binary' }>, l: Value | undefined, r: Value | undefined): Expr | undefined {
  if (node.op !== '==' && node.op !== '!=') return undefined
  if (!((isAuth(l) && isNull(r)) || (isNull(l) && isAuth(r)))) return undefined
  const authenticated: Expr = { atom: { op: 'authenticated' } }
  return node.op === '!=' ? authenticated : { not: authenticated }
}

/**
 * Maps a rules condition to an Expr. Sound: whenever Firestore evaluates the condition to true, the Expr is
 * true in the Holdline model. Logic maps structurally; a comparison that cannot be mapped exactly is opaque.
 */
export function normalizeCondition(node: Node, env: Env, ctx: NormalizeContext): Expr {
  switch (node.type) {
    case 'bool':
      return node.value ? TRUE : FALSE
    case 'unary':
      if (node.op === '!') return { not: normalizeCondition(node.operand, env, ctx) }
      break
    case 'ternary': {
      const test = normalizeCondition(node.test, env, ctx)
      return { or: [
        { and: [test, normalizeCondition(node.then, env, ctx)] },
        { and: [{ not: test }, normalizeCondition(node.else, env, ctx)] },
      ] }
    }
    case 'binary': {
      if (node.op === '&&') return { and: [normalizeCondition(node.left, env, ctx), normalizeCondition(node.right, env, ctx)] }
      if (node.op === '||') return { or: [normalizeCondition(node.left, env, ctx), normalizeCondition(node.right, env, ctx)] }
      const l = resolveValue(node.left, env, ctx)
      const r = resolveValue(node.right, env, ctx)
      return authCheck(node, l, r) ?? compareValues(node.op, l, r) ?? opaque(node, ctx)
    }
  }
  // A bare value: a rules condition must be a boolean, so it holds exactly when it equals true.
  return compareValues('==', resolveValue(node, env, ctx), TRUE_VALUE) ?? opaque(node, ctx)
}
