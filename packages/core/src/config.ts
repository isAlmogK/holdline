import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import YAML from 'yaml'
import { z } from 'zod'

const Globs = z.array(z.string().min(1)).min(1)

export const HoldlineConfigSchema = z.looseObject({
  postgres: z.strictObject({ migrations: Globs.optional(), dialect: z.enum(['supabase', 'plain']).optional() }).optional(),
  firestore: z.strictObject({ rules: Globs.optional() }).optional(),
  storage: z.strictObject({ rules: Globs.optional() }).optional(),
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
