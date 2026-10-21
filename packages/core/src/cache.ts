import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { sha256Hex } from './canonical.js'

export class FileCache {
  constructor(private readonly root: string) {}

  private path(analyzer: string, version: string, content: string): string {
    return join(this.root, '.holdline/cache/files', analyzer, `${sha256Hex(`${version}\0${content}`)}.json`)
  }

  async get<T>(analyzer: string, version: string, content: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(this.path(analyzer, version, content), 'utf8')) as T
    } catch {
      return undefined
    }
  }

  async set(analyzer: string, version: string, content: string, value: unknown): Promise<void> {
    const p = this.path(analyzer, version, content)
    await mkdir(dirname(p), { recursive: true })
    await writeFile(p, JSON.stringify(value))
  }
}
