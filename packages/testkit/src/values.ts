import { createHash } from 'node:crypto'
import { isNumericType } from '@holdline/core'

const URL_NAMESPACE = '6ba7b811-9dad-11d1-80b4-00c04fd430c8'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(s: string): boolean {
  return UUID.test(s)
}

// RFC 4122 version 5: sha1 over the namespace bytes and the name.
export function uuidV5(name: string): string {
  const ns = Buffer.from(URL_NAMESPACE.replaceAll('-', ''), 'hex')
  const hash = createHash('sha1').update(ns).update(`holdline:${name}`).digest()
  const b = hash.subarray(0, 16)
  b[6] = (b[6]! & 0x0f) | 0x50
  b[8] = (b[8]! & 0x3f) | 0x80
  const hex = b.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

// A stable integer in 1..30000 (fits smallint) for a non-numeric placeholder.
export function stableInt(s: string): number {
  return (createHash('sha256').update(s).digest().readUInt32BE(0) % 30_000) + 1
}

// Maps a test-case value to something the column type accepts; uuid placeholders are recorded in `uuids`.
export function mapValue(value: unknown, type: string, uuids: Map<string, string>): unknown {
  if (value === null || value === undefined) return null
  const t = type.trim().toLowerCase()
  if (t.endsWith('[]')) {
    return Array.isArray(value) ? value.map(v => mapValue(v, t.slice(0, -2), uuids)) : value
  }
  if (t === 'uuid' && typeof value === 'string') {
    if (isUuid(value)) return value
    const mapped = uuidV5(value)
    uuids.set(value, mapped)
    return mapped
  }
  if (isNumericType(t) && typeof value === 'string') return stableInt(value)
  if (t === 'json' || t === 'jsonb') return JSON.stringify(value)
  return value
}
