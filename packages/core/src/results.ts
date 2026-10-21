import type { Expr } from './expr.js'
import type { ProposedRule, Rule } from './rules.js'

export const RESULT_STATUSES = ['pass', 'violation', 'stale', 'unknown', 'unapproved-edit'] as const
export type ResultStatus = (typeof RESULT_STATUSES)[number]

export type Result = {
  rule: string
  status: ResultStatus
  target: string
  at?: { symbol: string; file?: string; line?: number }
  message: string
  unproven?: Expr
  fix?: string
}

export type Summary = Record<ResultStatus, number> & { muted: number; rules: number }

export function summarize(results: Result[], muted: number): Summary {
  const summary: Summary = { pass: 0, violation: 0, stale: 0, unknown: 0, 'unapproved-edit': 0, muted, rules: 0 }
  const worst = new Map<string, ResultStatus>()
  for (const r of results) {
    const prev = worst.get(r.rule)
    if (!prev || RESULT_STATUSES.indexOf(r.status) > RESULT_STATUSES.indexOf(prev)) worst.set(r.rule, r.status)
  }
  for (const status of worst.values()) summary[status]++
  summary.rules = worst.size
  return summary
}

export function describeTarget(rule: Rule | ProposedRule): string {
  const t = rule.target
  if ('routes' in t) return `routes ${t.routes}`
  if ('symbol' in t) return t.symbol
  return t.store === 'postgres' ? `pg:${t.table}` : `${t.store}:${t.path}`
}
