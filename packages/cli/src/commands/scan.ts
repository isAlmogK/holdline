import { factsCachePath } from '@holdline/core'
import { relative } from 'node:path'
import type { Io } from '../io.js'
import { policySummary } from '../format/policy-summary.js'
import { scanProject, writeFileEnsured } from '../workspace.js'

export async function scanCommand(io: Io): Promise<number> {
  const { facts, ran } = await scanProject(io.cwd)
  const path = factsCachePath(io.cwd)
  await writeFileEnsured(path, JSON.stringify(facts, null, 2))
  if (ran.length === 0) {
    io.stdout(`No analyzer recognized this project. Wrote empty facts to ${relative(io.cwd, path)}.\n`)
    return 0
  }
  const errors = facts.diagnostics.filter(d => d.severity === 'error').length
  io.stdout(`Scanned with ${ran.join(', ')}: ${facts.routes.length} routes, ${facts.dataOps.length} data operations, ${facts.tables.length} tables, ${facts.policies.length} policies${errors ? `, ${errors} errors` : ''}.\n`)
  const summary = policySummary(facts)
  if (summary) io.stdout(summary)
  return errors > 0 ? 3 : 0
}
