import type { Analyzer } from '@holdline/core'
import { firestoreAnalyzer } from '@holdline/analyzer-firestore'

// Phase 1 and 2 analyzer packages register here.
export const analyzers: Analyzer[] = [firestoreAnalyzer]
