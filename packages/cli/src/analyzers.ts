import { firestoreAnalyzer } from '@holdline/analyzer-firestore'
import { postgresAnalyzer } from '@holdline/analyzer-postgres'
import type { Analyzer } from '@holdline/core'

// Phase 1 and 2 analyzer packages register here.
export const analyzers: Analyzer[] = [postgresAnalyzer, firestoreAnalyzer]
