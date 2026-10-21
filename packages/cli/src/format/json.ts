import type { MutedRule, Result, Summary } from '@holdline/core'

export function formatJson(results: Result[], summary: Summary, mutedRules: MutedRule[] = []): string {
  return `${JSON.stringify({ summary, mutedRules, results }, null, 2)}\n`
}
