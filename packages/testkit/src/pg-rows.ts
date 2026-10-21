// Turns a test-case row into a row the table accepts: values mapped to column types, missing
// NOT NULL columns filled, primary-key columns given the runner's key (spec 5.2).
import { fillerValue, isNumericType } from '@holdline/core'
import type { PgColumn, PgTable } from './pg-schema.js'
import { mapValue, uuidV5 } from './values.js'

// A seed's position, or 'do' for the row of the case's operation.
export type RowKey = number | 'do'

function column(table: PgTable, name: string): PgColumn {
  const col = table.columns.find(c => c.name === name)
  if (!col) throw new Error(`column ${name} does not exist on ${table.path}`)
  return col
}

// Maps only the given columns; an unknown column throws.
export function mapRow(table: PgTable, data: Record<string, unknown>, uuids: Map<string, string>): Record<string, unknown> {
  const row: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(data)) row[name] = mapValue(value, column(table, name).type, uuids)
  return row
}

function keyValue(table: PgTable, col: PgColumn, key: RowKey): unknown {
  const type = col.type.toLowerCase()
  if (type === 'uuid') return uuidV5(`${table.path}#${key}`)
  if (isNumericType(type)) return key === 'do' ? 999 : 1000 + key
  return `${table.path}-${key}`
}

export function completeRow(table: PgTable, data: Record<string, unknown>, key: RowKey, uuids: Map<string, string>): Record<string, unknown> {
  const row = mapRow(table, data, uuids)
  for (const col of table.columns) {
    if (col.name in row || col.identity === 'a' || col.generated) continue
    if (table.primaryKey.includes(col.name)) {
      row[col.name] = keyValue(table, col, key)
    } else if (col.notNull && !col.hasDefault && col.identity === '') {
      const filler = fillerValue(col, { enumLabels: col.enumLabels, checks: table.checks })
      row[col.name] = mapValue(filler, col.type, uuids)
    }
  }
  return row
}
