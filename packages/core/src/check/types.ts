import type { Expr } from '../expr.js'
import type { FactIndex } from '../fact-index.js'
import type { Vocabulary } from '../logic.js'
import type { Result } from '../results.js'

export type CheckContext = { index: FactIndex; vocab: Vocabulary }
export type Violation = { message: string; at?: Result['at']; unproven?: Expr; fix?: string }
export type CheckOutcome = { stale: string } | { violations: Violation[] }
