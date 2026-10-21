import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
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

const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

describe('listFiles', () => {
  it('lists project files and skips dependencies and Holdline state', async () => {
    const root = await fixture()
    await mkdir(join(root, '.holdline/cache'), { recursive: true })
    await writeFile(join(root, '.holdline/cache/facts.json'), '{}')
    expect(await listFiles(root)).toEqual(['src/a.ts'])
  })
  it.skipIf(!hasGit)('lists non-ASCII paths verbatim and drops tracked files deleted from disk', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holdline-git-'))
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src/café.ts'), 'export const c = 1')
    await writeFile(join(root, 'src/gone.ts'), 'export const g = 1')
    execFileSync('git', ['init', '-q'], { cwd: root })
    execFileSync('git', ['add', '-A'], { cwd: root })
    await rm(join(root, 'src/gone.ts'))
    expect(await listFiles(root)).toEqual(['src/café.ts'])
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
    expect(out.facts.analyzers).toEqual([{ name: 'bad', version: '1' }])
  })
  it('keeps scanning when a detect throws or rejects', async () => {
    const root = await fixture()
    const broken: Analyzer = { name: 'broken', version: '1', detect: async () => { throw new Error('nope') }, analyze: async () => ({}) }
    const healthy: Analyzer = {
      name: 'healthy', version: '1', detect: () => true,
      analyze: async () => ({ symbols: [{ id: 'h:1', kind: 'function', lang: 'ts' }] }),
    }
    const out = await scan(root, [broken, healthy])
    expect(out.ran).toEqual(['broken', 'healthy'])
    expect(out.facts.symbols.map(s => s.id)).toEqual(['h:1'])
    expect(out.facts.diagnostics).toEqual([{ analyzer: 'broken', file: '', message: 'analyzer failed during detect: nope', severity: 'error' }])
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
