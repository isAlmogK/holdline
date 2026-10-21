import type { Expr } from '../expr.js'
import { implies, renameParams } from '../logic.js'
import { alignParams, normalizeTable } from '../paths.js'
import type { InvariantRule, ProposedRule } from '../rules.js'
import type { CheckContext, CheckOutcome, Violation } from './types.js'

type Invariant = Extract<InvariantRule | ProposedRule, { type: 'invariant' }>

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i])
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every(x => b.includes(x))
const normalizeSql = (s: string): string => {
  let out = s.toLowerCase().replace(/\s+/g, ' ').trim()
  while (/^\(.*\)$/.test(out) && wrapped(out)) out = out.slice(1, -1).trim()
  return out
}
// True when the first "(" closes at the very end, so stripping it is safe.
function wrapped(s: string): boolean {
  let depth = 0
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++
    else if (s[i] === ')' && --depth === 0) return i === s.length - 1
  }
  return false
}

export function checkInvariant(rule: Invariant, ctx: CheckContext): CheckOutcome {
  return rule.target.store === 'postgres' ? checkTable(rule, rule.target.table, ctx) : checkDocs(rule, ctx)
}

function checkTable(rule: Invariant, tableName: string, { index }: CheckContext): CheckOutcome {
  const table = index.table(tableName)
  if (!table) return { stale: `table ${tableName} not found` }
  const at = index.at(table.id)
  const fail = (message: string, fix: string): CheckOutcome => ({ violations: [{ message, at, fix }] })
  const cols = rule.columns.join(', ')
  switch (rule.kind) {
    case 'not-null': {
      const missing = rule.columns.filter(c => !table.columns.some(col => col.name === c))
      if (missing.length > 0) return fail(`${table.name} has no column ${missing.join(', ')}`, `Restore ${missing.join(', ')} on ${table.name}.`)
      const nullable = rule.columns.filter(c => table.columns.find(col => col.name === c)!.nullable)
      return nullable.length === 0 ? { violations: [] }
        : fail(`${table.name}.${nullable.join(', ')} allows NULL`, nullable.map(c => `ALTER TABLE ${table.name} ALTER COLUMN ${c} SET NOT NULL;`).join(' '))
    }
    case 'fk': {
      const ref = rule.references!
      const found = table.foreignKeys.some(fk => sameList(fk.columns, rule.columns)
        && normalizeTable(fk.references.table) === normalizeTable(ref.table) && sameList(fk.references.columns, ref.columns))
      return found ? { violations: [] }
        : fail(`${table.name}(${cols}) has no foreign key to ${ref.table}(${ref.columns.join(', ')})`,
          `ALTER TABLE ${table.name} ADD FOREIGN KEY (${cols}) REFERENCES ${ref.table}(${ref.columns.join(', ')});`)
    }
    case 'unique': {
      const found = [table.primaryKey, ...table.uniques].some(u => u.length > 0 && sameSet(u, rule.columns))
      return found ? { violations: [] } : fail(`${table.name}(${cols}) is not unique`, `ALTER TABLE ${table.name} ADD UNIQUE (${cols});`)
    }
    case 'check': {
      const expr = rule.expr
      const found = expr !== undefined && table.checks.some(c => normalizeSql(c.expr) === normalizeSql(expr))
      return found ? { violations: [] }
        : fail(`${table.name} has no CHECK ${rule.expr ? `(${rule.expr})` : `on ${cols}`}`, `ALTER TABLE ${table.name} ADD CHECK (${rule.expr ?? '…'});`)
    }
    case 'enum': {
      const values = rule.values!
      const bad = rule.columns.filter(c => {
        const e = table.enums.find(x => x.column === c)
        return !e || !sameSet(e.values, values)
      })
      return bad.length === 0 ? { violations: [] }
        : fail(`${table.name}.${bad.join(', ')} does not allow exactly ${values.join(', ')}`, `Make ${bad.join(', ')} an enum of ${values.join(', ')}.`)
    }
  }
}

function checkDocs(rule: Invariant, { index, vocab }: CheckContext): CheckOutcome {
  const t = rule.target
  if (t.store === 'postgres') return { violations: [] }
  if (!index.targetExists(t)) return { stale: `nothing matches ${t.store}:${t.path}` }
  if (rule.kind !== 'not-null' && rule.kind !== 'enum') {
    return { violations: [{ message: `${rule.kind} is not supported for ${t.store} targets`, fix: `Enforce ${rule.kind} in application code or move the data to postgres.` }] }
  }
  const writes = [...index.policies(t, 'create'), ...index.policies(t, 'update')]
  const required = (c: string): Expr => rule.kind === 'enum'
    ? { atom: { op: 'in', left: `incoming.${c}`, right: { literal: rule.values! } } }
    : { atom: { op: 'ne', left: `incoming.${c}`, right: { literal: null } } }
  const violations: Violation[] = writes.flatMap(p => {
    const condition = renameParams(p.condition, alignParams(p.target, t.path))
    const unchecked = rule.columns.filter(c => !implies(condition, required(c), vocab).ok)
    const what = rule.kind === 'enum' ? `restrict ${unchecked.join(', ')} to ${rule.values!.join(', ')}` : `require ${unchecked.join(', ')} to be non-null`
    return unchecked.length === 0 ? [] : [{
      message: `A write rule for ${t.store}:${t.path} does not ${what}`,
      at: index.at(p.id),
      fix: `Make this rule ${what} on request.resource.data.`,
    }]
  })
  return { violations: dedupe(violations) }
}

function dedupe(vs: Violation[]): Violation[] {
  const seen = new Set<string>()
  return vs.filter(v => (seen.has(v.at?.symbol ?? v.message) ? false : (seen.add(v.at?.symbol ?? v.message), true)))
}
