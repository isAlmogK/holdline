import { FactIndex } from './fact-index.js'
import type { Facts, Table } from './facts.js'
import { normalizeTable } from './paths.js'
import type { InvariantRule } from './rules.js'
import type { TestCase, TestFile } from './testcase.js'
import { firstValue, keyColumns, otherForeignKey, parentsOf, runnerKeyed, uniqueDuplicate, type Row, type Seed } from './testgen-invariant-keys.js'

export const INVALID_ENUM = '__holdline_invalid__'

// Postgres invariant cases (spec 5.4): one complete valid row that must insert, then rows that break the
// invariant and must be rejected. They run as superuser with foreign keys on, so every foreign key the row
// sets gets a seeded parent row. Primary-key columns are left to the runner unless the rule names them or
// they are foreign keys. A reject case that another key or foreign key would also refuse is skipped, so a
// reject case passes only through the rule's own constraint.
export function postgresInvariantCases(rule: InvariantRule & { target: { store: 'postgres' } }, facts: Facts | undefined): Pick<TestFile, 'cases' | 'skipped'> {
  const path = normalizeTable(rule.target.table)
  if (rule.kind === 'check') return { cases: [], skipped: ['check expressions are tested statically only'] }
  const table = facts ? new FactIndex(facts).table(path) : undefined
  if (!table) return { cases: [], skipped: [`table ${path} is not in the facts; run holdline scan, then holdline test --regenerate`] }
  const { row, parents } = validRow(rule, table)
  const create = (name: string, data: Row, expect: 'allow' | 'reject', seed: Seed[] = parents): TestCase =>
    ({ name, as: null, seed: structuredClone(seed), do: { op: 'create', path, data: structuredClone(data) }, expect })
  const cases = [create('create: a complete valid row inserts', row, 'allow')]
  const skipped: string[] = []
  const cols = rule.columns.join(', ')
  switch (rule.kind) {
    case 'not-null':
      for (const c of rule.columns) cases.push(create(`create: rejects ${c} null`, { ...row, [c]: null }, 'reject'))
      break
    case 'fk': {
      const other = otherForeignKey(rule, table)
      if (other) {
        skipped.push(`create: cannot isolate fk ${cols} (another foreign key covers ${other.columns.join(', ')})`)
        break
      }
      const missing = Object.fromEntries(rule.columns.map((c, i) => [c, `missing-${i + 1}`]))
      cases.push(create(`create: rejects ${cols} with no matching ${normalizeTable(rule.references!.table)} row`, { ...row, ...missing }, 'reject'))
      break
    }
    case 'unique': {
      const dup = uniqueDuplicate(rule, table, row, parents)
      if ('skip' in dup) skipped.push(dup.skip)
      else cases.push(create(`create: rejects a second row with the same ${cols}`, row, 'reject', [...parents, ...dup.parents, { path, data: dup.row }]))
      break
    }
    case 'enum':
      for (const c of rule.columns) cases.push(create(`create: rejects ${c} '${INVALID_ENUM}'`, { ...row, [c]: INVALID_ENUM }, 'reject'))
      break
  }
  return { cases, skipped }
}

// The columns the rule names, every NOT NULL column without a default and, for `unique`, the other keys' columns.
function validRow(rule: InvariantRule, table: Table): { row: Row; parents: Seed[] } {
  const fkCols = new Set(table.foreignKeys.flatMap(fk => fk.columns))
  const keyed = keyColumns(rule, table)
  const row: Row = {}
  for (const col of table.columns) {
    const named = rule.columns.includes(col.name)
    const required = !col.nullable && col.default === undefined
    if (!named && !required && !keyed.has(col.name)) continue
    if (!named && runnerKeyed(table, col.name)) continue
    if (fkCols.has(col.name)) row[col.name] = `${col.name}-1`
    else if (rule.kind === 'enum' && named) row[col.name] = rule.values![0]
    else row[col.name] = firstValue(table, col)
  }
  return { row, parents: parentsOf(table, row) }
}
