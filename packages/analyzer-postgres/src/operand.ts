import type { Operand } from '@holdline/core'
import type { NormalizeEnv } from './normalize.js'
import { bareSelectTarget, constant, kindOf, nameList, type SqlNode } from './sql-ast.js'

const CLAIM_KEY = /^[A-Za-z0-9_]+$/

// A SQL value as an operand: a constant, a column (through the scope), a parameter, or a Supabase auth value.
export function operand(node: SqlNode | undefined, env: NormalizeEnv): Operand | undefined {
  const c = constant(node)
  if (c) return { literal: c.value }
  const k = kindOf(node)
  if (!k) return undefined
  const [kind, f] = k
  switch (kind) {
    case 'ColumnRef': {
      const fields = nameList(f.fields)
      if (fields.includes('')) return undefined
      const r = env.scope.column(fields)
      return r && 'operand' in r ? r.operand : undefined
    }
    case 'ParamRef': return env.scope.param(f.number as number)
    case 'SubLink': {
      const inner = f.subLinkType === 'EXPR_SUBLINK' ? bareSelectTarget(f.subselect) : undefined
      return inner ? operand(inner, env) : undefined
    }
    case 'FuncCall': return env.supabase ? authValue(f) : undefined
    case 'A_Expr': return env.supabase ? claim(f) : undefined
    case 'TypeCast': {
      // `auth.uid()::text`: the text form of a uuid is the uid itself. Other casts change values.
      const inner = operand(f.arg, env)
      const type = nameList(f.typeName?.names).at(-1)
      return type === 'text' && typeof inner === 'string' && (inner === 'actor.uid' || inner.startsWith('actor.claim.')) ? inner : undefined
    }
    default: return undefined
  }
}

function authValue(f: SqlNode): string | undefined {
  if ((f.args as unknown[] | undefined)?.length) return undefined
  const name = nameList(f.funcname).join('.')
  return name === 'auth.uid' ? 'actor.uid' : name === 'auth.role' ? 'actor.role' : undefined
}

// `auth.jwt() ->> 'k'` and `(auth.jwt() -> 'a') ->> 'k'`.
function claim(f: SqlNode): string | undefined {
  if (f.kind !== 'AEXPR_OP' || nameList(f.name).join() !== '->>') return undefined
  const path = jwtPath(f.lexpr)
  const key = constant(f.rexpr)?.value
  return path && typeof key === 'string' && CLAIM_KEY.test(key) ? `actor.claim.${[...path, key].join('.')}` : undefined
}

function jwtPath(node: SqlNode | undefined): string[] | undefined {
  const k = kindOf(node)
  if (!k) return undefined
  const [kind, f] = k
  if (kind === 'FuncCall') return !(f.args as unknown[] | undefined)?.length && nameList(f.funcname).join('.') === 'auth.jwt' ? [] : undefined
  if (kind === 'SubLink' && f.subLinkType === 'EXPR_SUBLINK') return jwtPath(bareSelectTarget(f.subselect))
  if (kind === 'A_Expr' && f.kind === 'AEXPR_OP' && nameList(f.name).join() === '->') {
    const path = jwtPath(f.lexpr)
    const key = constant(f.rexpr)?.value
    return path && typeof key === 'string' && CLAIM_KEY.test(key) ? [...path, key] : undefined
  }
  return undefined
}
