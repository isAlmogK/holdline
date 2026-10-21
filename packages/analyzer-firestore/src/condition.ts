import { FALSE, TRUE, type Expr } from '@holdline/core'
import type { Node } from './ast.js'
import { compareValues } from './compare.js'
import { inlineCall } from './inline.js'
import { lookupArg, lookupPath } from './lookup-path.js'
import type { Env } from './scope.js'
import { resolveValue, type NormalizeContext, type Value } from './value.js'

/** Index of the `)` closing the `(` at index 0, skipping strings and comments; -1 when unbalanced. */
function closingParen(text: string): number {
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === "'" || c === '"') {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === '\\') i++
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2)
      if (i < 0) return -1
      i++
    } else if (c === '(') depth++
    else if (c === ')' && --depth === 0) return i
  }
  return -1
}

/** Drops outer parentheses that wrap the whole text: `((a))` → `a`, but `(a) && (b)` is kept. */
function stripOuterParens(text: string): string {
  let t = text.trim()
  while (t.startsWith('(') && closingParen(t) === t.length - 1) t = t.slice(1, -1).trim()
  return t
}

/** A condition Holdline cannot map exactly, named by its source text without outer parens, whitespace collapsed. */
export function opaque(node: Node, ctx: NormalizeContext): Expr {
  return { opaque: stripOuterParens(ctx.src.slice(node.start, node.end)).replace(/\s+/g, ' ').trim() }
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
    case 'ident': {
      // A param or let: the expression it is bound to, read as a condition in the env it was written in.
      const binding = env.bindings.get(node.name)
      if (binding) return normalizeCondition(binding.node, binding.env, ctx)
      break
    }
    case 'call': {
      const arg = lookupArg(node, 'exists', env, ctx)
      if (!arg) {
        const fn = inlineCall(node, env, ctx)
        if (fn.kind === 'ref') return { ref: fn.id }
        if (fn.kind === 'inline') return normalizeCondition(fn.node, fn.env, ctx)
        if (fn.kind === 'too-deep') return opaque(node, ctx)
        break
      }
      const p = lookupPath(arg, env, ctx)
      if (!p) return opaque(node, ctx)
      const atom: Expr = { atom: { op: 'exists', doc: p.path } }
      // A path holding `{actor.` errors in Firestore for an anonymous caller.
      return p.auth ? { and: [{ atom: { op: 'authenticated' } }, atom] } : atom
    }
  }
  // A bare value: a rules condition must be a boolean, so it holds exactly when it equals true.
  return compareValues('==', resolveValue(node, env, ctx), TRUE_VALUE) ?? opaque(node, ctx)
}
