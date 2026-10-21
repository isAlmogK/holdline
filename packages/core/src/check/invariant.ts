import { mentionsOperand, renameParams } from '../logic.js'
import { alignParams, normalizeTable } from '../paths.js'
import type { InvariantRule, ProposedRule } from '../rules.js'
import type { CheckContext, CheckOutcome, Violation } from './types.js'

type Invariant = Extract<InvariantRule | ProposedRule, { type: 'invariant' }>

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i])
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every(x => b.includes(x))
const normalizeSql = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim().replace(/^\((.*)\)$/, '$1').trim()

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
      const found = table.checks.some(c => rule.expr
        ? normalizeSql(c.expr) === normalizeSql(rule.expr)
        : rule.columns.every(col => new RegExp(`\\b${col}\\b`).test(c.expr)))
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

function checkDocs(rule: Invariant, { index }: CheckContext): CheckOutcome {
  const t = rule.target
  if (t.store === 'postgres') return { violations: [] }
  if (!index.targetExists(t)) return { stale: `nothing matches ${t.store}:${t.path}` }
  const writes = [...index.policies(t, 'create'), ...index.policies(t, 'update')]
  const violations: Violation[] = writes.flatMap(p => {
    const condition = renameParams(p.condition, alignParams(p.target, t.path))
    const unchecked = rule.columns.filter(c => !mentionsOperand(condition, `incoming.${c}`))
    return unchecked.length === 0 ? [] : [{
      message: `A write rule for ${t.store}:${t.path} does not check ${unchecked.join(', ')}`,
      at: index.at(p.id),
      fix: `Check request.resource.data.${unchecked.join(', request.resource.data.')} in this rule.`,
    }]
  })
  return { violations: dedupe(violations) }
}

function dedupe(vs: Violation[]): Violation[] {
  const seen = new Set<string>()
  return vs.filter(v => (seen.has(v.at?.symbol ?? v.message) ? false : (seen.add(v.at?.symbol ?? v.message), true)))
}
