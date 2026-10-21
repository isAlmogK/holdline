import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import YAML from 'yaml'
import { z } from 'zod'

// Globs are matched against the repo-relative file list (`matchFiles`), so they cannot leave the repo.
const Glob = z.string().min(1)
  .refine(g => !/^([/\\]|[A-Za-z]:)/.test(g), 'globs are relative to the repository root, not absolute')
  .refine(g => !g.split('/').includes('..'), 'globs cannot contain a .. segment')
const Globs = z.array(Glob).min(1)

// A section with no body (`postgres:` alone) is YAML null: treat it as an empty section.
const section = <T extends z.ZodType>(schema: T) => z.preprocess(v => (v === null ? {} : v), schema).optional()

export const HoldlineConfigSchema = z.looseObject({
  postgres: section(z.strictObject({ migrations: Globs.optional(), dialect: z.enum(['supabase', 'plain']).optional() })),
  firestore: section(z.strictObject({ rules: Globs.optional() })),
  storage: section(z.strictObject({ rules: Globs.optional() })),
})
export type HoldlineConfig = z.output<typeof HoldlineConfigSchema>

export class ConfigError extends Error {
  constructor(message: string) { super(message); this.name = 'ConfigError' }
}

export const configPath = (root: string) => join(root, '.holdline/config.yaml')

export async function loadConfig(root: string): Promise<HoldlineConfig> {
  let text: string
  try {
    text = await readFile(configPath(root), 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw e
  }
  let raw: unknown
  try {
    raw = YAML.parse(text)
  } catch (e) {
    throw new ConfigError(`.holdline/config.yaml: invalid YAML: ${e instanceof Error ? e.message : String(e)}`)
  }
  const parsed = HoldlineConfigSchema.safeParse(raw ?? {})
  if (!parsed.success) throw new ConfigError(`.holdline/config.yaml: ${z.prettifyError(parsed.error)}`)
  return parsed.data
}
