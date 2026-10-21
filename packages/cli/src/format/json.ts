import type { Result, Summary } from '@holdline/core'

export function formatJson(results: Result[], summary: Summary): string {
  return `${JSON.stringify({ summary, results }, null, 2)}\n`
}
