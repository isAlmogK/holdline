import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import {
  approvedRecognizers, emptyPending, emptyRulesFile, factsCachePath, parseFacts, parsePendingFile, parseRulesFile,
  RulesFileError, scan, serializePendingFile, serializeRulesFile, type AnalyzerRecognizer, type Facts, type PendingFile,
  type RulesFile,
} from '@holdline/core'
import { analyzers } from './analyzers.js'
import { UsageError, type Io } from './io.js'

export const rulesPath = (root: string) => join(root, 'holdline.rules')
export const pendingPath = (root: string) => join(root, '.holdline/pending.yaml')
export const testsDir = (root: string) => join(root, '.holdline/tests')

async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw e
  }
}

export async function writeFileEnsured(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

export async function loadRules(root: string): Promise<RulesFile> {
  const text = await readIfExists(rulesPath(root))
  return text === undefined ? emptyRulesFile() : parseRulesFile(text)
}

export const saveRules = (root: string, file: RulesFile) => writeFileEnsured(rulesPath(root), serializeRulesFile(file))

export async function loadPending(root: string): Promise<PendingFile> {
  const text = await readIfExists(pendingPath(root))
  return text === undefined ? emptyPending() : parsePendingFile(text)
}

export const savePending = (root: string, p: PendingFile) => writeFileEnsured(pendingPath(root), serializePendingFile(p))

export async function loadFacts(root: string, factsFile?: string): Promise<Facts> {
  if (factsFile) {
    const path = isAbsolute(factsFile) ? factsFile : join(root, factsFile)
    const text = await readIfExists(path)
    if (text === undefined) throw new UsageError(`facts file not found: ${factsFile}`)
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch (e) {
      throw new UsageError(`${factsFile}: invalid JSON: ${(e as Error).message}`)
    }
    return parseFacts(json, factsFile)
  }
  const { facts } = await scanProject(root)
  await writeFileEnsured(factsCachePath(root), JSON.stringify(facts, null, 2))
  return facts
}

// Runs the analyzers with the recognizers of the approved vocabulary in holdline.rules. A missing or
// invalid rules file gives none: scanning does not depend on it (check reports a bad file itself).
export async function scanProject(root: string): ReturnType<typeof scan> {
  return scan(root, analyzers, { recognizers: await recognizers(root) })
}

async function recognizers(root: string): Promise<AnalyzerRecognizer[]> {
  const text = await readIfExists(rulesPath(root))
  if (text === undefined) return []
  try {
    return approvedRecognizers(parseRulesFile(text))
  } catch (e) {
    if (e instanceof RulesFileError) return []
    throw e
  }
}

export function approver(io: Io): string {
  if (io.env.HOLDLINE_USER) return io.env.HOLDLINE_USER
  try {
    const name = execFileSync('git', ['config', 'user.name'], { cwd: io.cwd, encoding: 'utf8' }).trim()
    if (name) return name
  } catch {
    // no git identity
  }
  return io.env.USER ?? 'unknown'
}

export const today = (io: Io) => (io.now?.() ?? new Date()).toISOString().slice(0, 10)
