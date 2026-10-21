import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Analyzer } from '../src/analyzer.js'
import { FileCache } from '../src/cache.js'
import { listFiles, scan } from '../src/scan.js'

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holdline-scan-'))
  await mkdir(join(root, 'src'), { recursive: true })
  await mkdir(join(root, 'node_modules/x'), { recursive: true })
  await writeFile(join(root, 'src/a.ts'), 'export const a = 1')
  await writeFile(join(root, 'node_modules/x/index.js'), '')
  return root
}

describe('listFiles', () => {
  it('lists project files and skips dependencies and Holdline state', async () => {
    const root = await fixture()
    await mkdir(join(root, '.holdline/cache'), { recursive: true })
    await writeFile(join(root, '.holdline/cache/facts.json'), '{}')
    expect(await listFiles(root)).toEqual(['src/a.ts'])
  })
})

describe('scan', () => {
  it('runs detected analyzers and merges their facts', async () => {
    const root = await fixture()
    const ts: Analyzer = {
      name: 'fake-ts', version: '1',
      detect: (_r, files) => files.some(f => f.endsWith('.ts')),
      analyze: async ctx => ({ symbols: ctx.files.map(f => ({ id: `ts:${f}`, kind: 'function', lang: 'ts' })) }),
    }
    const py: Analyzer = { name: 'fake-py', version: '1', detect: () => false, analyze: async () => ({}) }
    const out = await scan(root, [ts, py])
    expect(out.ran).toEqual(['fake-ts'])
    expect(out.facts.analyzers).toEqual([{ name: 'fake-ts', version: '1' }])
    expect(out.facts.symbols.map(s => s.id)).toEqual(['ts:src/a.ts'])
  })
  it('turns an analyzer crash into an error diagnostic', async () => {
    const root = await fixture()
    const bad: Analyzer = { name: 'bad', version: '1', detect: () => true, analyze: async () => { throw new Error('boom') } }
    const out = await scan(root, [bad])
    expect(out.facts.diagnostics).toEqual([{ analyzer: 'bad', file: '', message: 'analyzer failed: boom', severity: 'error' }])
  })
  it('turns invalid analyzer output into an error diagnostic', async () => {
    const root = await fixture()
    const bad: Analyzer = { name: 'bad', version: '1', detect: () => true, analyze: async () => ({ routes: [{ nope: 1 }] }) as never }
    const out = await scan(root, [bad])
    expect(out.facts.diagnostics[0]!.message).toMatch(/invalid facts/)
  })
})

describe('FileCache', () => {
  it('stores values by analyzer, version and content', async () => {
    const root = await fixture()
    const cache = new FileCache(root)
    expect(await cache.get('ts', '1', 'abc')).toBeUndefined()
    await cache.set('ts', '1', 'abc', { n: 1 })
    expect(await cache.get('ts', '1', 'abc')).toEqual({ n: 1 })
    expect(await cache.get('ts', '2', 'abc')).toBeUndefined()
  })
})
