import { FactIndex } from './fact-index.js'
import type { Facts, Table } from './facts.js'
import { normalizeTable } from './paths.js'
import type { InvariantRule } from './rules.js'
import type { TestCase, TestFile } from './testcase.js'
import { fillerValue } from './testgen-filler.js'

type Row = Record<string, unknown>
type Seed = { path: string; data: Row }
export const INVALID_ENUM = '__holdline_invalid__'

// Postgres invariant cases (spec 5.4): one complete valid row that must insert, then rows that break the
// invariant and must be rejected. They run as superuser with foreign keys on, so every foreign key the row
// sets gets a seeded parent row. Primary-key columns are left to the runner unless the rule names them or
// they are foreign keys, so two rows of a `unique` case differ in their key.
export function postgresInvariantCases(rule: InvariantRule & { target: { store: 'postgres' } }, facts: Facts | undefined): Pick<TestFile, 'cases' | 'skipped'> {
  const path = normalizeTable(rule.target.table)
  if (rule.kind === 'check') return { cases: [], skipped: ['check expressions are tested statically only'] }
  const table = facts ? new FactIndex(facts).table(path) : undefined
  if (!table) return { cases: [], skipped: [`table ${path} is not in the facts; run holdline scan, then holdline test`] }
  const { row, parents } = validRow(rule, table)
  const create = (name: string, data: Row, expect: 'allow' | 'reject', seed: Seed[] = parents): TestCase =>
    ({ name, as: null, seed: structuredClone(seed), do: { op: 'create', path, data: structuredClone(data) }, expect })
  const cases = [create('create: a complete valid row inserts', row, 'allow')]
  const cols = rule.columns.join(', ')
  switch (rule.kind) {
    case 'not-null':
      for (const c of rule.columns) cases.push(create(`create: rejects ${c} null`, { ...row, [c]: null }, 'reject'))
      break
    case 'fk': {
      const missing = Object.fromEntries(rule.columns.map((c, i) => [c, `missing-${i + 1}`]))
      cases.push(create(`create: rejects ${cols} with no matching ${normalizeTable(rule.references!.table)} row`, { ...row, ...missing }, 'reject'))
      break
    }
    case 'unique':
      cases.push(create(`create: rejects a second row with the same ${cols}`, row, 'reject', [...parents, { path, data: row }]))
      break
    case 'enum':
      for (const c of rule.columns) cases.push(create(`create: rejects ${c} '${INVALID_ENUM}'`, { ...row, [c]: INVALID_ENUM }, 'reject'))
      break
  }
  return { cases, skipped: [] }
}

function validRow(rule: InvariantRule, table: Table): { row: Row; parents: Seed[] } {
  const fkCols = new Set(table.foreignKeys.flatMap(fk => fk.columns))
  const pk = new Set(table.primaryKey)
  const row: Row = {}
  for (const col of table.columns) {
    const named = rule.columns.includes(col.name)
    const required = !col.nullable && col.default === undefined
    if (!named && !required) continue
    if (pk.has(col.name) && !named && !fkCols.has(col.name)) continue
    if (fkCols.has(col.name)) row[col.name] = `${col.name}-1`
    else if (rule.kind === 'enum' && named) row[col.name] = rule.values![0]
    else row[col.name] = fillerValue(col, {
      enumLabels: table.enums.find(e => e.column === col.name)?.values,
      checks: table.checks.map(c => c.expr),
    })
  }
  const parents: Seed[] = []
  for (const fk of table.foreignKeys) {
    if (!fk.columns.every(c => c in row)) continue
    const data = Object.fromEntries(fk.references.columns.map((rc, i) => [rc, row[fk.columns[i]!]]))
    parents.push({ path: normalizeTable(fk.references.table), data })
  }
  return { row, parents }
}
