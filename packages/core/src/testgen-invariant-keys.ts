import { deepEqual } from './canonical.js'
import type { Table } from './facts.js'
import { normalizeTable } from './paths.js'
import type { InvariantRule } from './rules.js'
import { fillerValue, otherFillerValue } from './testgen-filler.js'

export type Row = Record<string, unknown>
export type Seed = { path: string; data: Row }

// A seed row in the referenced table for each foreign key whose columns are all set in `row`.
export function parentsOf(table: Table, row: Row): Seed[] {
  return table.foreignKeys.filter(fk => fk.columns.every(c => c in row)).map(fk => ({
    path: normalizeTable(fk.references.table),
    data: Object.fromEntries(fk.references.columns.map((rc, i) => [rc, row[fk.columns[i]!]])),
  }))
}

// A primary-key column the runner gives each row its own value for: not a foreign key and not set by the case.
export function runnerKeyed(table: Table, column: string): boolean {
  return table.primaryKey.includes(column) && !table.foreignKeys.some(fk => fk.columns.includes(column))
}

// The primary key and the unique keys of the table, other than the rule's own column set.
function otherKeys(rule: InvariantRule, table: Table): string[][] {
  const same = (key: string[]) => key.length === rule.columns.length && key.every(c => rule.columns.includes(c))
  return [...(table.primaryKey.length > 0 ? [table.primaryKey] : []), ...table.uniques].filter(k => !same(k))
}

// The columns a `unique` case's two rows set to different values: those of the other keys outside the rule's
// columns, except primary-key columns the runner keys. The valid row sets them too, so neither row takes a default.
export function keyColumns(rule: InvariantRule, table: Table): Set<string> {
  if (rule.kind !== 'unique') return new Set()
  return new Set(otherKeys(rule, table).flat().filter(c => !rule.columns.includes(c) && !runnerKeyed(table, c)))
}

// The row a `unique` case seeds before inserting `row` again: the rule's columns are the same, and every other key
// differs in at least one column, so only the rule's constraint can refuse the insert. A skip reason when some
// other key cannot differ (all its other columns have a single possible value, or it lies within the rule's columns).
export function uniqueDuplicate(rule: InvariantRule, table: Table, row: Row, parents: Seed[]): { row: Row; parents: Seed[] } | { skip: string } {
  const fkCols = new Set(table.foreignKeys.flatMap(fk => fk.columns))
  const dup: Row = { ...row }
  const varies = new Set<string>()
  for (const c of keyColumns(rule, table)) {
    const col = table.columns.find(x => x.name === c)
    if (!col) continue
    const value = fkCols.has(c) ? `${c}-2` : otherFillerValue(col, filler(table, c))
    if (value === undefined) continue
    dup[c] = value
    varies.add(c)
  }
  for (const key of otherKeys(rule, table)) {
    if (!key.some(c => varies.has(c) || (!rule.columns.includes(c) && runnerKeyed(table, c)))) {
      return { skip: `create: cannot isolate unique ${rule.columns.join(', ')} (another unique key covers ${key.join(', ')})` }
    }
  }
  const more = parentsOf(table, dup).filter(p => !parents.some(q => q.path === p.path && deepEqual(q.data, p.data)))
  return { row: dup, parents: more }
}

// The first foreign key other than the rule's own that covers one of the rule's columns: with it, a value with no
// referenced row is refused even when the rule's foreign key is gone.
export function otherForeignKey(rule: InvariantRule, table: Table): Table['foreignKeys'][number] | undefined {
  const own = (fk: Table['foreignKeys'][number]) => fk.columns.length === rule.columns.length
    && fk.columns.every(c => rule.columns.includes(c))
    && normalizeTable(fk.references.table) === normalizeTable(rule.references!.table)
  return table.foreignKeys.find(fk => !own(fk) && fk.columns.some(c => rule.columns.includes(c)))
}

export function filler(table: Table, column: string): { enumLabels?: string[]; checks: string[] } {
  return { enumLabels: table.enums.find(e => e.column === column)?.values, checks: table.checks.map(c => c.expr) }
}

export function firstValue(table: Table, column: { name: string; type: string }): unknown {
  return fillerValue(column, filler(table, column.name))
}
