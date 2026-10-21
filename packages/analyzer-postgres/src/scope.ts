import type { Operand } from '@holdline/core'

export type Side = 'resource' | 'incoming'

// What a column reference means where it appears: an operand, a column of the innermost subquery's
// table, or blocked (a column the normalizer can't express, such as one of an enclosing subquery's table).
export type Resolved = { operand: Operand } | { inner: string } | { blocked: true }

export interface Scope {
  column(fields: string[]): Resolved | undefined
  param(n: number): Operand | undefined
}

const split = (table: string) => table.split('.') as [string, string]

// The policy's table: in USING its columns are the stored record, in WITH CHECK the incoming row.
export function tableScope(table: string, columns: ReadonlySet<string>, side: Side): Scope {
  const [schema, name] = split(table)
  return {
    column(fields) {
      const col = fields.at(-1)!
      const q = fields.slice(0, -1)
      const ours = q.length === 0 || (q.length === 1 && q[0] === name) || (q.length === 2 && q[0] === schema && q[1] === name)
      return ours && columns.has(col) ? { operand: `${side}.${col}` } : undefined
    },
    param: () => undefined,
  }
}

// A SQL function body: parameters by name or position ($1), bound to the caller's operands.
// The policy's table is not in scope inside a function.
export function functionScope(names: readonly string[], args: readonly Operand[]): Scope {
  return {
    column(fields) {
      const i = fields.length === 1 ? names.indexOf(fields[0]!) : -1
      return i >= 0 && i < args.length ? { operand: args[i]! } : undefined
    },
    param: n => args[n - 1],
  }
}

// A subquery over one table. Its own columns win over outer ones, as in SQL.
export function subqueryScope(table: string, alias: string, columns: ReadonlySet<string>, parent: Scope): Scope {
  const [schema, name] = split(table)
  return {
    column(fields) {
      const col = fields.at(-1)!
      const q = fields.slice(0, -1)
      const ours = q.length === 0 ? columns.has(col)
        : (q.length === 1 && q[0] === alias) || (q.length === 2 && alias === name && q[0] === schema && q[1] === name)
      if (ours) return columns.has(col) ? { inner: col } : { blocked: true }
      const outer = parent.column(fields)
      return outer && 'inner' in outer ? { blocked: true } : outer
    },
    param: n => parent.param(n),
  }
}
