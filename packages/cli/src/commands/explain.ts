import { FactIndex, checkRule, formatExpr, hashRule, vocabularyMap } from '@holdline/core'
import YAML from 'yaml'
import { UsageError, type Io } from '../io.js'
import { loadFacts, loadRules } from '../workspace.js'
import { where } from '../format/where.js'

export async function explainCommand(id: string, opts: { facts?: string }, io: Io): Promise<number> {
  const file = await loadRules(io.cwd)
  const rule = file.rules.find(r => r.id === id)
  if (!rule) throw new UsageError(`no rule ${id}`)
  const facts = await loadFacts(io.cwd, opts.facts)
  const index = new FactIndex(facts)
  const lines = [`${rule.id} ${rule.text}`, `type: ${rule.type}`]
  if ('requires' in rule) lines.push(`requires: ${formatExpr(rule.requires)}`)
  if (rule.status === 'muted' && rule.muted) lines.push(`muted by ${rule.muted.by} on ${rule.muted.at}: ${rule.muted.reason}`)
  if (rule.approved) {
    const edited = rule.approved.hash !== hashRule(rule, vocabularyMap(file)) ? ' (edited since approval)' : ''
    lines.push(`approved by ${rule.approved.by} on ${rule.approved.at}${edited}`)
  } else {
    lines.push('not approved')
  }
  for (const ev of rule.evidence) {
    const at = index.at(ev)
    lines.push(`evidence: ${ev}${at.file ? ` (${at.file}${at.line ? `:${at.line}` : ''})` : ''}`)
  }
  if (rule.status === 'muted') {
    lines.push('muted, not enforced')
  } else {
    for (const r of checkRule(rule, { index, vocab: vocabularyMap(file) })) {
      lines.push(`${r.status}: ${r.message}${where(r) ? ` at ${where(r)}` : ''}`)
    }
  }
  lines.push('', YAML.stringify(rule, { lineWidth: 0 }).trimEnd())
  io.stdout(`${lines.join('\n')}\n`)
  return 0
}
