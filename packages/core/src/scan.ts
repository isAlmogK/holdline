import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { promisify } from 'node:util'
import type { Analyzer } from './analyzer.js'
import { FileCache } from './cache.js'
import { loadConfig } from './config.js'
import { FactsError, emptyFacts, mergeFacts, parseFacts, type Facts } from './facts.js'

const SKIP = new Set(['node_modules', '.git', '.holdline', 'dist', 'build', '.venv', 'vendor', '.next', '.svelte-kit'])

export function factsCachePath(root: string): string {
  return join(root, '.holdline/cache/facts.json')
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

async function gitLines(root: string, args: string[]): Promise<string[]> {
  const { stdout } = await promisify(execFile)('git', ['ls-files', '-z', ...args], { cwd: root, maxBuffer: 64 * 1024 * 1024 })
  return stdout.split('\0').filter(Boolean)
}

export async function listFiles(root: string): Promise<string[]> {
  try {
    const [tracked, deleted] = await Promise.all([
      gitLines(root, ['--cached', '--others', '--exclude-standard']),
      gitLines(root, ['--deleted']),
    ])
    const gone = new Set(deleted)
    return tracked.filter(f => !gone.has(f) && !f.split('/').some(part => SKIP.has(part))).sort()
  } catch {
    // not a git repository, or git unavailable: walk the tree
  }
  const out: string[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile()) out.push(relative(root, full))
    }
  }
  await walk(root)
  return out.sort()
}

export async function scan(root: string, analyzers: readonly Analyzer[]): Promise<{ facts: Facts; ran: string[] }> {
  const files = await listFiles(root)
  // Outside the analyzer try/catch on purpose: a bad config is a usage error (exit 2), not an analyzer failure.
  const config = await loadConfig(root)
  const cache = new FileCache(root)
  const parts: Facts[] = []
  const ran: string[] = []
  const failed = (analyzer: Analyzer, message: string): Facts => ({
    ...emptyFacts(),
    analyzers: [{ name: analyzer.name, version: analyzer.version }],
    diagnostics: [{ analyzer: analyzer.name, file: '', message, severity: 'error' as const }],
  })
  for (const analyzer of analyzers) {
    let applies: boolean
    try {
      applies = await analyzer.detect(root, files)
    } catch (e) {
      ran.push(analyzer.name)
      parts.push(failed(analyzer, `analyzer failed during detect: ${errorMessage(e)}`))
      continue
    }
    if (!applies) continue
    ran.push(analyzer.name)
    try {
      const output = await analyzer.analyze({ root, files, cache, config })
      parts.push(parseFacts({ version: 1, ...output, analyzers: [{ name: analyzer.name, version: analyzer.version }] }, analyzer.name))
    } catch (e) {
      parts.push(e instanceof FactsError ? failed(analyzer, `invalid facts: ${e.message}`) : failed(analyzer, `analyzer failed: ${errorMessage(e)}`))
    }
  }
  return { facts: mergeFacts(parts), ran }
}
