import { z } from 'zod'
import type { Facts } from './facts.js'
import { formatExpr } from './format.js'
import { ProposalBatchSchema } from './proposals.js'
import type { RulesFile } from './rules.js'

export function proposalJsonSchema(): object {
  return z.toJSONSchema(ProposalBatchSchema, { io: 'input' }) as object
}

const INSTRUCTIONS = `# Holdline: propose this codebase's business rules

You are reading a summary of a codebase produced by Holdline's analyzers. Propose the business
rules a careful senior engineer would want enforced on every future change: who may do what,
which records each user may read or write, which records must never be returned, which writes
must go through which service, and which data invariants must hold.

Guidelines:
- Propose 10 to 25 rules. Fewer, important rules beat many trivial ones.
- Write "text" in plain language a product owner can approve.
- Every rule needs "evidence": ids from the facts below that show the rule.
- Rule types: access (routes or symbols require a condition), data-access (database or Firestore
  policies require a condition), visibility (reads must filter), flow (writes must go through a
  symbol), invariant (schema constraints).
- When the code checks something through a helper (for example isAccountMember() or
  requireRole("admin")), add a "vocabulary" entry for it and use { "ref": "<id>" } in rules.
- Propose rules the code seems to intend even if the code breaks them; Holdline checks every
  proposal and shows broken ones to the user as questions.
- Do not repeat existing rules.
`

export function condenseFacts(facts: Facts, opts: { area?: string } = {}): { title: string; lines: string[] }[] {
  const fileOf = new Map(facts.symbols.map(s => [s.id, s.location?.file]))
  const inArea = (file: string | undefined) => !opts.area || (!!file && file.startsWith(opts.area))
  const guardsAt = (id: string) => facts.guards.filter(g => g.at === id).map(g => formatExpr(g.requires))

  const routes = facts.routes.filter(r => inArea(fileOf.get(r.handler))).map(r => {
    const checks = [r.id, ...r.middleware, r.handler].flatMap(guardsAt)
    const mw = r.middleware.length > 0 ? `; middleware ${r.middleware.join(', ')}` : ''
    return `${r.method} ${r.path} → ${r.handler}${mw}${checks.length > 0 ? `; checks ${checks.join(' and ')}` : '; no checks found'}`
  })

  const byTarget = new Map<string, string[]>()
  for (const op of facts.dataOps.filter(o => inArea(o.evidence?.file ?? fileOf.get(o.in)))) {
    const filter = op.filters ? ` (filters: ${formatExpr(op.filters)})` : ''
    byTarget.set(op.target, [...(byTarget.get(op.target) ?? []), `${op.op} in ${op.in}${filter}`])
  }
  const dataAccess = [...byTarget].map(([target, ops]) => `${target}: ${ops.join('; ')}`)

  const tables = facts.tables.filter(t => inArea(t.location?.file)).map(t => {
    const cols = t.columns.map(c => {
      const fk = t.foreignKeys.find(f => f.columns.length === 1 && f.columns[0] === c.name)
      const en = t.enums.find(e => e.column === c.name)
      return `${c.name} ${c.type}${c.nullable ? '' : ' not null'}${fk ? ` → ${fk.references.table}(${fk.references.columns.join(', ')})` : ''}${en ? ` in (${en.values.join(', ')})` : ''}`
    })
    const extra = [
      ...t.uniques.map(u => `unique(${u.join(', ')})`),
      ...t.checks.map(c => `check(${c.expr})`),
      `RLS ${t.rlsEnabled ? 'on' : 'off'}`,
    ]
    return `${t.name} [${t.id}]: ${[...cols, ...extra].join(', ')}`
  })

  const policies = facts.policies.filter(p => inArea(p.evidence?.file)).map(p =>
    `${p.store} ${p.target}: ${p.ops.join(', ')} if ${formatExpr(p.condition)} [${p.id}]`)
  const collections = facts.collections.map(c => `${c.path}${c.fields.length > 0 ? `: ${c.fields.join(', ')}` : ''}`)
  const ids = facts.symbols.filter(s => inArea(s.location?.file)).map(s => s.id)

  return [
    { title: '## Routes', lines: routes },
    { title: '## Data access', lines: dataAccess },
    { title: '## Tables', lines: tables },
    { title: '## Policies', lines: policies },
    { title: '## Collections', lines: collections },
    { title: '## Symbol ids (for evidence)', lines: ids },
  ].filter(s => s.lines.length > 0)
}

export function buildInferPrompt(facts: Facts, file: RulesFile, opts: { area?: string; budgetTokens?: number } = {}): string {
  const budgetChars = (opts.budgetTokens ?? 30_000) * 4
  const existing = file.rules.map(r => `- ${r.id} (${r.type}): ${r.text}`)
  const vocab = file.vocabulary.map(v => `- ${v.id}: ${v.text} = ${formatExpr(v.expr)}`)
  const header = [
    INSTRUCTIONS,
    '## Output',
    'Return only JSON matching this JSON Schema, with no prose around it:',
    '```json', JSON.stringify(proposalJsonSchema()), '```',
    existing.length > 0 ? `## Existing rules (do not repeat)\n${existing.join('\n')}` : '',
    vocab.length > 0 ? `## Existing vocabulary (reuse these ids)\n${vocab.join('\n')}` : '',
    '# Facts',
  ].filter(Boolean).join('\n')

  const out = [header]
  let used = header.length
  for (const section of condenseFacts(facts, opts)) {
    out.push(section.title)
    used += section.title.length + 1
    let shown = 0
    for (const line of section.lines) {
      if (used + line.length + 1 > budgetChars) break
      out.push(line)
      used += line.length + 1
      shown++
    }
    if (shown < section.lines.length) out.push(`… ${section.lines.length - shown} more not shown; use --area <path> to narrow`)
  }
  return out.join('\n')
}
