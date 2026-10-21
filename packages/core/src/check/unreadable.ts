import type { ProposedRule, Rule } from '../rules.js'
import type { CheckContext } from './types.js'

// Files whose facts the rule's verdict rests on.
function dependencyFiles(rule: Rule | ProposedRule, { index }: CheckContext): Set<string> {
  const files = new Set<string>()
  const add = (id: string | undefined) => {
    const file = id === undefined ? undefined : index.fileOf(id)
    if (file) files.add(file)
  }
  const t = rule.target
  if ('routes' in t) {
    for (const r of index.routesMatching(t.routes)) {
      add(r.id)
      add(r.handler)
      r.middleware.forEach(add)
    }
  } else if ('symbol' in t) {
    add(t.symbol)
  } else {
    if (t.store === 'postgres') add(index.table(t.table)?.id)
    for (const op of ['read', 'list', 'create', 'update', 'delete'] as const) {
      for (const p of index.policies(t, op)) add(p.id)
    }
    for (const o of index.dataOps(t)) {
      if (o.evidence?.file) files.add(o.evidence.file)
      add(o.in)
    }
  }
  return files
}

// A reason the rule cannot be judged, or undefined when everything it depends on was read.
export function unreadableReason(rule: Rule | ProposedRule, ctx: CheckContext): string | undefined {
  const errors = ctx.index.facts.diagnostics.filter(d => d.severity === 'error')
  if (errors.length === 0) return undefined
  const crashed = errors.find(d => d.file === '')
  if (crashed) return `The ${crashed.analyzer} analyzer failed (${crashed.message}), so facts are missing and this rule cannot be checked.`
  const evidence = 'evidence' in rule ? rule.evidence : []
  const unresolved = evidence.find(id => !ctx.index.hasId(id))
  if (unresolved) return `Evidence ${unresolved} was not found and an analyzer reported errors, so this rule cannot be checked.`
  const deps = dependencyFiles(rule, ctx)
  for (const id of evidence) {
    const file = ctx.index.fileOf(id)
    if (file) deps.add(file)
  }
  const t = rule.target
  const suffix = 'store' in t ? (t.store === 'postgres' ? '.sql' : '.rules') : undefined
  const bad = errors.find(d => deps.has(d.file) || (suffix !== undefined && d.file.endsWith(suffix)))
  return bad ? `${bad.file} could not be read (${bad.message}), so this rule cannot be checked.` : undefined
}
