import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/** A temp repo holding the given files (path -> content); `files` is the sorted path list. */
export async function repo(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'holdline-fs-'))
  for (const [p, c] of Object.entries(files)) {
    await mkdir(dirname(join(root, p)), { recursive: true })
    await writeFile(join(root, p), c)
  }
  return { root, files: Object.keys(files).sort() }
}
