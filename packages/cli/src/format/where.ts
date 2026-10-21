import type { Result } from '@holdline/core'

export function where(r: Result): string {
  if (!r.at) return ''
  return r.at.file ? `${r.at.file}${r.at.line ? `:${r.at.line}` : ''}` : r.at.symbol
}
