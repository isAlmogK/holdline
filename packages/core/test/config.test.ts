import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConfigError, loadConfig } from '../src/config.js'
import type { Analyzer } from '../src/analyzer.js'
import { scan } from '../src/scan.js'

async function project(config?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holdline-config-'))
  if (config !== undefined) {
    await mkdir(join(root, '.holdline'), { recursive: true })
    await writeFile(join(root, '.holdline/config.yaml'), config)
  }
  return root
}

describe('loadConfig', () => {
  it('returns an empty config when the file is missing', async () => {
    expect(await loadConfig(await project())).toEqual({})
  })
  it('parses the known sections', async () => {
    const root = await project('postgres:\n  migrations: ["db/*.sql"]\n  dialect: supabase\nfirestore:\n  rules: [firestore.rules]\nstorage:\n  rules: [storage.rules]\n')
    expect(await loadConfig(root)).toEqual({
      postgres: { migrations: ['db/*.sql'], dialect: 'supabase' },
      firestore: { rules: ['firestore.rules'] },
      storage: { rules: ['storage.rules'] },
    })
  })
  it('keeps unknown top-level sections for later analyzers', async () => {
    expect(await loadConfig(await project('go:\n  modules: [svc]\n'))).toEqual({ go: { modules: ['svc'] } })
  })
  it('rejects bad values and bad YAML with ConfigError naming the file', async () => {
    await expect(loadConfig(await project('postgres:\n  dialect: oracle\n'))).rejects.toThrow(ConfigError)
    await expect(loadConfig(await project('postgres: [\n'))).rejects.toThrow(/\.holdline\/config\.yaml/)
  })
  it('scan passes the config to analyzers', async () => {
    const root = await project('firestore:\n  rules: [app.rules]\n')
    let seen: unknown
    const spy: Analyzer = { name: 'spy', version: '1', detect: () => true, analyze: async ctx => { seen = ctx.config; return {} } }
    await scan(root, [spy])
    expect(seen).toEqual({ firestore: { rules: ['app.rules'] } })
  })
})
