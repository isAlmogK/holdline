import { runChecks, summarize } from '@holdline/core'
import { formatAgent } from '../format/agent.js'
import { formatHuman } from '../format/human.js'
import { formatJson } from '../format/json.js'
import { UsageError, type Io } from '../io.js'
import { loadFacts, loadRules } from '../workspace.js'

export type CheckOptions = { facts?: string; format: string; strict?: boolean; rule?: string[] }

export async function checkCommand(opts: CheckOptions, io: Io): Promise<number> {
  if (!['human', 'agent', 'json'].includes(opts.format)) throw new UsageError(`unknown format ${opts.format}: use human, agent or json`)
  const file = await loadRules(io.cwd)
  const missing = (opts.rule ?? []).filter(id => !file.rules.some(r => r.id === id))
  if (missing.length > 0) throw new UsageError(`no rule ${missing.join(', ')}`)
  const facts = await loadFacts(io.cwd, opts.facts)
  const { results, muted, mutedRules } = runChecks(facts, file, { only: opts.rule })
  const summary = summarize(results, muted)
  const texts = new Map([...file.rules.map(r => [r.id, r.text] as const), ...file.vocabulary.map(v => [`vocabulary:${v.id}`, v.text] as const)])
  const out = opts.format === 'json' ? formatJson(results, summary, mutedRules)
    : opts.format === 'agent' ? formatAgent(results, summary, texts, mutedRules)
    : formatHuman(results, summary, texts, mutedRules)
  io.stdout(out)
  const failed = summary.violation + summary['unapproved-edit'] > 0
  const strictFailed = !!opts.strict && summary.stale + summary.unknown > 0
  return failed || strictFailed ? 1 : 0
}
