import { TRUE, type AnalyzerOutput, type AnalyzerRecognizer, type Diagnostic, type Policy, type SymbolFact } from '@holdline/core'
import { normalizeCondition } from './condition.js'
import { expandRules, policyIds } from './expand.js'
import { parseRules } from './parser.js'
import { countFunctions, rootEnv } from './scope.js'
import { simplify } from './simplify.js'
import type { NormalizeContext } from './value.js'

const ANALYZER = 'firestore'

/** Function name -> vocabulary id; the first entry wins on a duplicate name. */
function recognizerMap(recognizers: readonly AnalyzerRecognizer[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const r of recognizers) {
    for (const entry of r.recognize) {
      if ('firestore-function' in entry && !map.has(entry['firestore-function'])) map.set(entry['firestore-function'], r.id)
    }
  }
  return map
}

/** Facts of one rules file: one policy per allow and op, one symbol per match, diagnostics for what cannot be read. */
export function analyzeRulesFile(file: string, src: string, recognizers: readonly AnalyzerRecognizer[]): AnalyzerOutput {
  const parsed = parseRules(src)
  if (!parsed.ok) {
    const { line, col, message } = parsed.error
    return { diagnostics: [{ analyzer: ANALYZER, file, severity: 'error', message: `line ${line}, column ${col}: ${message}` }] }
  }
  const { ast } = parsed
  const expansion = expandRules(ast)
  const diagnostics: Diagnostic[] = expansion.warnings.map(message => ({ analyzer: ANALYZER, file, severity: 'warning', message }))
  if (ast.services.length === 0) diagnostics.push({ analyzer: ANALYZER, file, severity: 'warning', message: 'no service block' })

  const recognizerIds = recognizerMap(recognizers)
  const functionCounts = countFunctions(ast)
  const ids = policyIds(expansion.allows)
  const policies: Policy[] = []
  let next = 0
  for (const site of expansion.allows) {
    const ctx: NormalizeContext = { store: site.store, src, recognizers: recognizerIds, functionCounts, functionsUsed: new Set() }
    const condition = site.allow.condition ? simplify(normalizeCondition(site.allow.condition, rootEnv(site.scope), ctx)) : TRUE
    const functions = [...ctx.functionsUsed].sort()
    for (const op of site.ops) {
      policies.push({
        id: ids[next++]!,
        store: site.store,
        target: site.target,
        ops: [op],
        condition,
        functions,
        evidence: { file, line: site.allow.line },
      })
    }
  }
  const symbols: SymbolFact[] = expansion.matches.map(m => ({
    id: `${m.store}:${m.target}`,
    kind: 'match',
    lang: m.store,
    location: { file, line: m.line },
  }))
  return { policies, symbols, diagnostics }
}
