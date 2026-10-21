import type { FileCache } from './cache.js'
import type { HoldlineConfig } from './config.js'
import type { FactsInput } from './facts.js'

export type AnalyzerOutput = Omit<FactsInput, 'version' | 'analyzers'>

export interface AnalyzerContext {
  root: string
  files: readonly string[]
  cache: FileCache
  config: HoldlineConfig
}

export interface Analyzer {
  name: string
  version: string
  detect(root: string, files: readonly string[]): boolean | Promise<boolean>
  analyze(ctx: AnalyzerContext): Promise<AnalyzerOutput>
}
