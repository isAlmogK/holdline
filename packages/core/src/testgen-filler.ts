// Filler for a column a test row must set but the case does not care about ("complete row", spec 5.2).
// The generator and the Postgres runner share it, so a generated row and a runtime-completed row agree.
// `uuid` filler is a test value string: the runner maps every string in a uuid column to a UUID v5.

export type FillerContext = { enumLabels?: readonly string[]; checks?: readonly string[] }

const NUMERIC = /^(smallint|integer|bigint|int[248]?|numeric|decimal|real|double precision|float[48]?|serial|bigserial|smallserial)\b/

export function isNumericType(type: string): boolean {
  return NUMERIC.test(type.toLowerCase())
}

export function fillerValue(column: { name: string; type: string }, ctx: FillerContext = {}): unknown {
  const type = column.type.toLowerCase()
  if (type.endsWith('[]')) return []
  if (ctx.enumLabels && ctx.enumLabels.length > 0) return ctx.enumLabels[0]
  const literal = checkLiteral(column.name, ctx.checks ?? [])
  if (literal !== undefined) return literal
  if (type === 'uuid') return 'filler'
  if (isNumericType(type)) return 1
  if (type === 'boolean' || type === 'bool') return false
  if (type.startsWith('timestamp')) return '1970-01-01T00:00:00Z'
  if (type === 'date') return '1970-01-01'
  if (type === 'json' || type === 'jsonb') return {}
  return 'x'
}

// The first string literal of a CHECK that limits `column` to a list: `col = ANY (ARRAY['a'::text, ...])`
// (how Postgres prints `col IN ('a', ...)`) or `col IN ('a', ...)`.
export function checkLiteral(column: string, checks: readonly string[]): string | undefined {
  const col = column.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // The name must be the whole identifier: no word character on either side (a quoted name carries its quotes).
  const name = String.raw`(?:"${col}"|(?<![\w"])${col}(?![\w"]))`
  const forms = [
    new RegExp(String.raw`\(?${name}\)?(?:::\w+)?\s*=\s*ANY\s*\(\s*\(?ARRAY\s*\[\s*'((?:[^']|'')*)'`, 'i'),
    new RegExp(String.raw`\(?${name}\)?\s+IN\s*\(\s*'((?:[^']|'')*)'`, 'i'),
  ]
  for (const check of checks) {
    for (const form of forms) {
      const m = form.exec(check)
      if (m) return m[1]!.replace(/''/g, "'")
    }
  }
  return undefined
}
