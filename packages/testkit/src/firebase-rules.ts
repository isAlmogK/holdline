// Finds the one rules file a Firestore or Storage test run loads (spec 5.3), as a root-relative path.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ConfigError, listFiles, matchFiles, type HoldlineConfig } from '@holdline/core'

type Store = 'firestore' | 'storage'

const pointer = (v: unknown): string | undefined => {
  const rules = (v as { rules?: unknown } | null | undefined)?.rules
  return typeof rules === 'string' ? rules.replace(/^\.\//, '') : undefined
}

async function firebaseJson(root: string, store: Store): Promise<string | undefined> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(join(root, 'firebase.json'), 'utf8'))
  } catch {
    return undefined
  }
  const section = (raw as Record<string, unknown> | null)?.[store]
  return Array.isArray(section) ? pointer(section[0]) : pointer(section)
}

export async function resolveRulesFile(root: string, config: HoldlineConfig, store: Store): Promise<string | undefined> {
  const files = await listFiles(root)
  const globs = config[store]?.rules
  if (globs) {
    const matched = matchFiles(files, globs)
    if (matched.length > 1) throw new ConfigError(`testing needs exactly one ${store} rules file; ${matched.length} match`)
    return matched[0]
  }
  const pointed = await firebaseJson(root, store)
  if (pointed && files.includes(pointed)) return pointed
  return files.includes(`${store}.rules`) ? `${store}.rules` : undefined
}
