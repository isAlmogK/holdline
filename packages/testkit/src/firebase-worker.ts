// Entry point run inside `firebase emulators:exec` (see emulator.ts): `<in.json> <out.json>`.
import { readFile, writeFile } from 'node:fs/promises'
import { FirebaseInputSchema, runFirebaseFiles } from './firebase-runner.js'

try {
  const input = FirebaseInputSchema.parse(JSON.parse(await readFile(process.argv[2]!, 'utf8')))
  const results = await runFirebaseFiles(input)
  await writeFile(process.argv[3]!, JSON.stringify(results))
  process.exit(0)
} catch (e) {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e))
  process.exit(1)
}
