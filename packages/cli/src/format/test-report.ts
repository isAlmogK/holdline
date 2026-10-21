import type { TestReport } from '@holdline/testkit'

export type TestOutput = TestReport

// Continuation lines of emulator and database messages sit under their first line.
const indent = (text: string) => text.replace(/\n/g, '\n    ')

export const REGENERATE_HINT = 'allow cases are built from the facts when the file was generated; after changing policies run holdline test --regenerate'

const GENERATED = {
  missing: 'generated: no test file',
  changed: 'regenerated: the rule changed',
  refreshed: 'regenerated: --regenerate (the facts changed)',
} as const

// `noCases`: reported rules with no case that ran (notes, and files whose cases were all skipped).
export function summarize(out: TestOutput): { passed: number; failed: number; rules: number; noCases: number } {
  const cases = out.files.flatMap(f => f.cases)
  const passed = cases.filter(c => c.passed).length
  return { passed, failed: cases.length - passed, rules: out.files.length, noCases: out.files.filter(f => f.cases.length === 0).length }
}

export function formatTestReport(out: TestOutput, format: 'human' | 'json'): string {
  const summary = summarize(out)
  if (format === 'json') return `${JSON.stringify({ files: out.files, infrastructure: out.infrastructure, summary }, null, 2)}\n`
  const lines: string[] = []
  for (const f of out.files) {
    const passed = f.cases.filter(c => c.passed).length
    const failed = f.cases.length - passed
    const counts = f.cases.length === 0 ? 'no cases' : failed > 0 ? `${passed} passed, ${failed} failed` : `${passed} passed`
    lines.push(`${f.rule}${f.store ? ` ${f.store}` : ''}: ${counts}${f.generated ? ` (${GENERATED[f.generated]})` : ''}`)
    for (const c of f.cases.filter(x => !x.passed)) lines.push(`  ✗ ${c.name}: ${indent(c.detail ?? `expected ${c.expect}, got ${c.actual}`)}`)
    for (const s of f.skipped) lines.push(`  - skipped: ${s}`)
  }
  // A denied allow case is often a file generated against older policies.
  if (out.files.some(f => f.cases.some(c => !c.passed && c.expect === 'allow' && c.actual === 'deny'))) lines.push('', REGENERATE_HINT)
  if (out.infrastructure.length > 0) {
    if (lines.length > 0) lines.push('')
    lines.push('Could not run:')
    for (const i of out.infrastructure) lines.push(`  ${i.store}: ${indent(i.message)}`)
  }
  if (lines.length > 0) lines.push('')
  const none = summary.noCases === 0 ? '' : summary.noCases === 1 ? ' (1 rule has no runnable cases)' : ` (${summary.noCases} rules have no runnable cases)`
  lines.push(`${summary.passed} passed, ${summary.failed} failed in ${summary.rules} ${summary.rules === 1 ? 'rule' : 'rules'}${none}`)
  return `${lines.join('\n')}\n`
}
