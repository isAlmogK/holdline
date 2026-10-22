import { isLookupOperand, type Atom } from './expr.js'
import type { Op } from './facts.js'
import type { World } from './testgen-world.js'

// Why `op` cannot be tested with `atoms` (satisfied by `satisfied`), or `undefined` when it can.
export function opSkip(op: Op, atoms: Atom[], satisfied: World): string | undefined {
  if ((op === 'read' || op === 'list' || op === 'delete') && atoms.some(readsIncoming)) {
    return `${op}: the condition reads the incoming write, which ${op} does not send`
  }
  if (op === 'list' && Object.keys(satisfied.resource).length > 0) return 'list: needs query filters to test; read cases cover the condition'
  if (op === 'create' && (satisfied.recordLookup || atoms.some(readsStoredRecord))) {
    return 'create: the condition reads the stored record, which does not exist on create'
  }
  return undefined
}

// True when an atom reads `<root>.*` directly or in a lookup or `exists` path placeholder.
function reads(a: Atom, root: 'resource' | 'incoming'): boolean {
  const mentions = (o: unknown) =>
    typeof o === 'string' && (o.startsWith(`${root}.`) || (isLookupOperand(o) && o.includes(`{${root}.`)))
  if (a.op === 'exists') return a.doc.includes(`{${root}.`)
  if (a.op === 'authenticated') return false
  if (a.op === 'isNull') return mentions(a.operand)
  return Object.values(a).some(mentions)
}

const readsStoredRecord = (a: Atom) => reads(a, 'resource')
// Only create and update send data, so a condition on it cannot be tested on read, list or delete.
const readsIncoming = (a: Atom) => reads(a, 'incoming')
