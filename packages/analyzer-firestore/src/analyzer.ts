import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Analyzer, AnalyzerContext, AnalyzerOutput, Diagnostic } from '@holdline/core'
import { analyzeRulesFile } from './analyze-file.js'
import { discoverRulesFiles } from './discover.js'

export const ANALYZER_NAME = 'firestore'
export const ANALYZER_VERSION = '0.1.0'

async function analyzeCached(ctx: AnalyzerContext, file: string): Promise<AnalyzerOutput> {
  let content: string
  try {
    content = await readFile(join(ctx.root, file), 'utf8')
  } catch (e) {
    const message = `could not read: ${e instanceof Error ? e.message : String(e)}`
    return { diagnostics: [{ analyzer: ANALYZER_NAME, file, severity: 'error', message }] }
  }
  const key = JSON.stringify({ file, recognizers: ctx.recognizers }) + '\0' + content
  const hit = await ctx.cache.get<AnalyzerOutput>(ANALYZER_NAME, ANALYZER_VERSION, key)
  if (hit) return hit
  let out: AnalyzerOutput
  try {
    out = analyzeRulesFile(file, content, ctx.recognizers)
  } catch (e) {
    // One file's crash (e.g. a stack overflow on deep nesting) must not discard other files' facts. Not cached.
    const message = `analysis failed: ${e instanceof Error ? e.message : String(e)}`
    return { diagnostics: [{ analyzer: ANALYZER_NAME, file, severity: 'error', message }] }
  }
  await ctx.cache.set(ANALYZER_NAME, ANALYZER_VERSION, key, out)
  return out
}

export const firestoreAnalyzer: Analyzer = {
  name: ANALYZER_NAME,
  version: ANALYZER_VERSION,
  async detect(root, files, config) {
    if (config.firestore?.rules || config.storage?.rules) return true
    const d = await discoverRulesFiles(root, files, config)
    return d.files.length > 0 || d.errors.length > 0
  },
  async analyze(ctx) {
    const discovery = await discoverRulesFiles(ctx.root, ctx.files, ctx.config)
    const out: Required<Pick<AnalyzerOutput, 'policies' | 'symbols' | 'diagnostics'>> = {
      policies: [],
      symbols: [],
      diagnostics: discovery.errors.map((e): Diagnostic => ({ analyzer: ANALYZER_NAME, file: e.file, message: e.message, severity: 'error' })),
    }
    for (const file of discovery.files) {
      const part = await analyzeCached(ctx, file)
      out.policies.push(...(part.policies ?? []))
      out.symbols.push(...(part.symbols ?? []))
      out.diagnostics.push(...(part.diagnostics ?? []))
    }
    return out
  },
}
