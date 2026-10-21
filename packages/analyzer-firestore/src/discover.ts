import { readFile } from 'node:fs/promises'
import { posix } from 'node:path'
import { matchFiles, type HoldlineConfig } from '@holdline/core'

export interface Discovery { files: string[]; warnings: { file: string; message: string }[] }

const STORES = ['firestore', 'storage'] as const
type Store = (typeof STORES)[number]

const CONFIG_FILE = '.holdline/config.yaml'

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The `rules` strings of a firebase.json `firestore` or `storage` value: an object or an array of objects. */
function rulesPaths(value: unknown): string[] {
  const entries = Array.isArray(value) ? value : [value]
  return entries.flatMap(e => (isObject(e) && typeof e.rules === 'string' ? [e.rules] : []))
}

/** Rules files of this repo: config globs, root defaults and `firebase.json` pointers, sorted and deduplicated. */
export async function discoverRulesFiles(root: string, files: readonly string[], config: HoldlineConfig): Promise<Discovery> {
  const found = new Set<string>()
  const warnings: Discovery['warnings'] = []
  const fileSet = new Set(files)
  const fromJson: Store[] = []

  for (const store of STORES) {
    const globs = config[store]?.rules
    if (globs) {
      const matched = matchFiles(files, globs)
      if (matched.length === 0) warnings.push({ file: CONFIG_FILE, message: `${store}.rules globs match no file` })
      for (const f of matched) found.add(f)
    } else {
      if (fileSet.has(`${store}.rules`)) found.add(`${store}.rules`)
      fromJson.push(store)
    }
  }

  if (fromJson.length > 0) {
    for (const file of files.filter(f => f === 'firebase.json' || f.endsWith('/firebase.json'))) {
      let json: unknown
      try {
        json = JSON.parse(await readFile(`${root}/${file}`, 'utf8'))
      } catch (e) {
        const message = e instanceof SyntaxError ? `invalid JSON: ${e.message}` : `could not read: ${e instanceof Error ? e.message : String(e)}`
        warnings.push({ file, message })
        continue
      }
      if (!isObject(json)) continue
      const dir = posix.dirname(file)
      for (const store of fromJson) {
        for (const rules of rulesPaths(json[store])) {
          const target = posix.normalize(posix.join(dir, rules))
          if (target.startsWith('..') || !fileSet.has(target)) {
            warnings.push({ file, message: `points at ${target}, which is not in the repository` })
          } else {
            found.add(target)
          }
        }
      }
    }
  }
  return { files: [...found].sort(), warnings }
}
