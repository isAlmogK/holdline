import type { Expr } from '@holdline/core'
import { normalizeCondition } from '../../src/condition.js'
import { expandRules } from '../../src/expand.js'
import { parseRules } from '../../src/parser.js'
import { rootEnv } from '../../src/scope.js'
import { simplify } from '../../src/simplify.js'

export function cond(condition: string, opts: { store?: 'firestore' | 'storage'; before?: string; inside?: string; path?: string; recognizers?: Record<string, string> } = {}): Expr {
  const store = opts.store ?? 'firestore'
  const inner = `${opts.before ?? ''}\nmatch ${opts.path ?? '/things/{thingId}'} { ${opts.inside ?? ''}\n allow read: if ${condition}; }`
  const src = store === 'firestore'
    ? `service cloud.firestore { match /databases/{database}/documents { ${inner} } }`
    : `service firebase.storage { match /b/{bucket}/o { ${inner} } }`
  const r = parseRules(src)
  if (!r.ok) throw new Error(r.error.message)
  const site = expandRules(r.ast).allows[0]!
  const ctx = { store, src, recognizers: new Map(Object.entries(opts.recognizers ?? {})), functionsUsed: new Set<string>() }
  return simplify(normalizeCondition(site.allow.condition!, rootEnv(site.scope), ctx))
}
