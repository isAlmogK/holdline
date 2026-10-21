import { concretize } from './paths.js'
import type { DataAccessRule } from './rules.js'
import type { TestCase } from './testcase.js'
import type { Op } from './facts.js'
import type { World } from './testgen-world.js'

function targetPath(rule: DataAccessRule): string {
  return rule.target.store === 'postgres' ? rule.target.table : rule.target.path
}

export function toCase(name: string, w: World, dataWorld: World, rule: DataAccessRule, op: Op, expect: 'allow' | 'deny'): TestCase {
  const path = rule.target.store === 'postgres' ? storePath(rule) : concretize(targetPath(rule), p => w.params[p] ?? `${p}-1`)
  const record = structuredClone(w.resource)
  const seed = structuredClone([...(op === 'create' ? [] : [{ path: storePath(rule), data: record }]), ...w.docs])
  const data = op === 'create' || op === 'update' ? structuredClone({ ...dataWorld.resource, ...w.incoming }) : undefined
  const listPath = path.split('/').slice(0, -1).join('/')
  return {
    name,
    as: w.actor ? { ...w.actor, claims: { ...w.actor.claims } } : null,
    seed: rule.target.store === 'postgres' ? seed : seed.map(s => {
      const own = s.path === storePath(rule)
      const store = rule.target.store === 'storage' ? { store: own ? 'storage' as const : 'firestore' as const } : {}
      return { path: own ? path : s.path, ...store, data: s.data }
    }),
    do: { op, path: op === 'list' && rule.target.store !== 'postgres' ? listPath : path, ...(data ? { data } : {}) },
    expect,
  }
}

export function storePath(rule: DataAccessRule): string {
  return rule.target.store === 'postgres' ? rule.target.table.includes('.') ? rule.target.table : `public.${rule.target.table}` : targetPath(rule)
}
