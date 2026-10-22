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

// A second value for a column, different from `fillerValue`'s, for a row that must differ from the filler row
// in that column (the seeded duplicate of a `unique` case). `undefined` when the column cannot take another value:
// an enum type or a CHECK list with a single label.
export function otherFillerValue(column: { name: string; type: string }, ctx: FillerContext = {}): unknown {
  const type = column.type.toLowerCase()
  if (type.endsWith('[]')) return [fillerValue({ name: column.name, type: type.slice(0, -2) })]
  if (ctx.enumLabels && ctx.enumLabels.length > 0) return ctx.enumLabels[1]
  const literals = checkLiterals(column.name, ctx.checks ?? [])
  if (literals !== undefined) return literals[1]
  if (type === 'uuid') return 'filler-2'
  if (isNumericType(type)) return 2
  if (type === 'boolean' || type === 'bool') return true
  if (type.startsWith('timestamp')) return '1970-01-02T00:00:00Z'
  if (type === 'date') return '1970-01-02'
  if (type === 'json' || type === 'jsonb') return { value: 2 }
  return 'x2'
}

// The first string literal of a CHECK that limits `column` to a list: `col = ANY (ARRAY['a'::text, ...])`
// (how Postgres prints `col IN ('a', ...)`) or `col IN ('a', ...)`.
export function checkLiteral(column: string, checks: readonly string[]): string | undefined {
  return checkLiterals(column, checks)?.[0]
}

// Every string literal of the first CHECK that limits `column` to a list (see `checkLiteral`).
export function checkLiterals(column: string, checks: readonly string[]): string[] | undefined {
  const col = column.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // The name must be the whole identifier: no word character on either side (a quoted name carries its quotes).
  const name = String.raw`(?:"${col}"|(?<![\w"])${col}(?![\w"]))`
  // A list body: quoted literals (which may hold `]` or `)`) and anything else up to the closing bracket.
  const forms = [
    new RegExp(String.raw`\(?${name}\)?(?:::\w+)?\s*=\s*ANY\s*\(\s*\(?ARRAY\s*\[\s*(?=')((?:'(?:[^']|'')*'|[^'\]])*)\]`, 'i'),
    new RegExp(String.raw`\(?${name}\)?\s+IN\s*\(\s*(?=')((?:'(?:[^']|'')*'|[^')])*)\)`, 'i'),
  ]
  for (const check of checks) {
    for (const form of forms) {
      const m = form.exec(check)
      if (m) return [...m[1]!.matchAll(/'((?:[^']|'')*)'/g)].map(l => l[1]!.replace(/''/g, "'"))
    }
  }
  return undefined
}
