import type { Literal } from '@holdline/core'

// libpg-query returns untyped JSON in which every node is `{ <Kind>: { ...fields } }`. This is the only
// file that names the loose type; the rest of the package reads nodes through these helpers.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SqlNode = Record<string, any>

export function kindOf(node: SqlNode | undefined): [string, SqlNode] | undefined {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return undefined
  const keys = Object.keys(node)
  return keys.length === 1 ? [keys[0]!, node[keys[0]!] as SqlNode] : undefined
}

// `[{ String: { sval: 'auth' } }, { String: { sval: 'uid' } }]` → ['auth', 'uid']; `*` becomes ''.
export function nameList(list: SqlNode[] | undefined): string[] {
  return (list ?? []).map(n => (n?.String?.sval as string | undefined) ?? '')
}

const INTEGER = new Set(['int2', 'int4', 'int8', 'integer', 'bigint', 'smallint'])
const NUMERIC = new Set([...INTEGER, 'numeric', 'decimal', 'float4', 'float8', 'real'])
const TEXTUAL = new Set(['text', 'varchar', 'bpchar', 'char', 'character', 'name'])

// A constant, with a cast around it applied the way Postgres would for the values we can model.
// A cast that changes the value in a way we don't model (type modifiers, citext, a number to boolean) is not a constant.
export function constant(node: SqlNode | undefined): { value: Literal } | undefined {
  const k = kindOf(node)
  if (!k) return undefined
  const [kind, f] = k
  if (kind === 'TypeCast') {
    const inner = constant(f.arg)
    if (!inner) return inner
    const type = nameList(f.typeName?.names).at(-1) ?? ''
    if (f.typeName?.typmods) return undefined
    const v = inner.value
    if (v === null) return inner
    if (typeof v === 'number') {
      if (TEXTUAL.has(type)) return { value: (kindOf(f.arg)?.[1].fval?.fval as string | undefined) ?? String(v) } // keep `1.50` as written
      if (INTEGER.has(type)) return Number.isInteger(v) ? inner : undefined
      return NUMERIC.has(type) ? inner : undefined
    }
    if (typeof v === 'boolean') {
      if (TEXTUAL.has(type)) return { value: String(v) }
      return type === 'bool' || type === 'boolean' ? inner : undefined
    }
    if (typeof v !== 'string') return undefined
    if (NUMERIC.has(type)) {
      const n = Number(v)
      return v.trim() !== '' && Number.isFinite(n) && (!INTEGER.has(type) || Number.isInteger(n)) ? { value: n } : undefined
    }
    if (type === 'bool' || type === 'boolean' || type === 'citext') return undefined
    if (type === 'uuid') return { value: v.toLowerCase() }
    return inner
  }
  if (kind !== 'A_Const') return undefined
  if (f.isnull) return { value: null }
  if (f.sval) return { value: (f.sval.sval as string | undefined) ?? '' }
  if (f.ival) return { value: (f.ival.ival as number | undefined) ?? 0 }
  if (f.fval) return { value: Number(f.fval.fval) }
  if (f.boolval) return { value: f.boolval.boolval === true }
  return undefined
}

// The one expression of `SELECT <expr>` when the SELECT has nothing else (no FROM, WHERE, ...).
export function bareSelectTarget(select: SqlNode | undefined): SqlNode | undefined {
  const s = select?.SelectStmt as SqlNode | undefined
  if (!s || s.fromClause || s.whereClause || s.groupClause || s.havingClause || s.withClause || s.distinctClause
    || s.limitCount || s.limitOffset || s.valuesLists || (s.op && s.op !== 'SETOP_NONE')) return undefined
  const targets = s.targetList as SqlNode[] | undefined
  return targets?.length === 1 ? (targets[0]!.ResTarget?.val as SqlNode | undefined) : undefined
}

const WORD = /[A-Za-z0-9_."$]/

// The source text of a node, for opaque conditions (best effort: it is shown to people, never compared).
// Locations are byte offsets: from the first location in the node to the end of the token at the last one,
// widened to balance parentheses (a call's argument list, a parenthesized operand).
export function nodeText(source: string, node: SqlNode): string {
  const bytes = Buffer.from(source)
  const locations: number[] = []
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (k === 'location' && typeof x === 'number') { if (x >= 0) locations.push(x) } else walk(x)
      }
    }
  }
  walk(node)
  if (locations.length === 0) return source
  let start = Math.min(...locations)
  let end = tokenEnd(bytes, Math.max(...locations))
  if (bytes[end] === 40) { // the last token is a call: take its argument list up to the matching `)`
    let depth = 0
    for (; end < bytes.length; end++) {
      if (bytes[end] === 40) depth++
      else if (bytes[end] === 41 && --depth === 0) { end++; break }
    }
  }
  const open = () => [...bytes.subarray(start, end).toString()].reduce((d, c) => d + (c === '(' ? 1 : c === ')' ? -1 : 0), 0)
  while (end < bytes.length && open() > 0) end++
  while (start > 0 && open() < 0) start--
  return bytes.subarray(start, end).toString().trim()
}

function tokenEnd(b: Buffer, i: number): number {
  const isWord = (j: number) => b[j]! >= 128 || WORD.test(String.fromCharCode(b[j]!))
  if (b[i] === 39) { // a quoted string; '' is an escaped quote
    let j = i + 1
    while (j < b.length) {
      if (b[j] === 39) { if (b[j + 1] === 39) { j += 2; continue } return j + 1 }
      j++
    }
    return j
  }
  if (isWord(i)) { let j = i; while (j < b.length && isWord(j)) j++; return j }
  return i + 1
}
