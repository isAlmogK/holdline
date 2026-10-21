type PatchOp = { op: 'add' | 'remove' | 'replace'; path: string; value?: unknown }

export function applyPatch<T>(doc: T, ops: PatchOp[]): T {
  const out = structuredClone(doc) as unknown
  for (const { op, path, value } of ops) {
    const keys = path.split('/').slice(1).map(k => k.replace(/~1/g, '/').replace(/~0/g, '~'))
    const last = keys.pop()!
    let parent = out as Record<string, unknown> | unknown[]
    for (const k of keys) parent = (parent as Record<string, unknown>)[k] as Record<string, unknown> | unknown[]
    if (parent === undefined || parent === null || typeof parent !== 'object') throw new Error(`patch parent missing: ${path}`)
    const exists = Array.isArray(parent) ? Number(last) >= 0 && Number(last) < parent.length : last in parent
    if ((op === 'replace' || op === 'remove') && !exists) throw new Error(`patch target missing: ${path}`)
    if (Array.isArray(parent)) {
      const i = last === '-' ? parent.length : Number(last)
      if (op === 'add') parent.splice(i, 0, value)
      else if (op === 'remove') parent.splice(i, 1)
      else parent[i] = value
    } else if (op === 'remove') {
      delete parent[last]
    } else {
      parent[last] = value
    }
  }
  return out as T
}
