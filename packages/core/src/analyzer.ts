import type { FileCache } from './cache.js'
import type { HoldlineConfig } from './config.js'
import type { FactsInput } from './facts.js'
import { hashVocabulary } from './hash.js'
import type { RulesFile, VocabularyEntry } from './rules.js'

export type AnalyzerOutput = Omit<FactsInput, 'version' | 'analyzers'>

// What an approved vocabulary entry tells analyzers: these functions or symbols mean `{ ref: id }`.
export type AnalyzerRecognizer = { id: string; recognize: VocabularyEntry['recognize'] }

export interface AnalyzerContext {
  root: string
  files: readonly string[]
  cache: FileCache
  config: HoldlineConfig
  // Analyzers that use these must include them in their cache key.
  recognizers: AnalyzerRecognizer[]
}

export interface Analyzer {
  name: string
  version: string
  detect(root: string, files: readonly string[], config: HoldlineConfig): boolean | Promise<boolean>
  analyze(ctx: AnalyzerContext): Promise<AnalyzerOutput>
}

// The recognizers of the approved vocabulary entries: only entries whose `approved.hash` is current,
// and only entries that have recognizers.
export function approvedRecognizers(file: RulesFile): AnalyzerRecognizer[] {
  return file.vocabulary
    .filter(v => v.approved?.hash === hashVocabulary(v) && v.recognize.length > 0)
    .map(v => ({ id: v.id, recognize: v.recognize }))
}
