// Dev-only: stamps every approved rule in a fixture rules file with its current hash.
import { readFile, writeFile } from 'node:fs/promises'
import { hashRule, parseRulesFile, serializeRulesFile, vocabularyMap } from '@holdline/core'

const path = process.argv[2]
if (!path) {
  console.error('usage: tsx scripts/approve-fixture.ts <rules.yaml>')
  process.exit(2)
}
const file = parseRulesFile(await readFile(path, 'utf8'), path)
const vocab = vocabularyMap(file)
const rules = file.rules.map(r => (r.status === 'approved' && r.approved ? { ...r, approved: { ...r.approved, hash: hashRule(r, vocab) } } : r))
await writeFile(path, serializeRulesFile({ ...file, rules }))
console.log(`stamped ${rules.filter(r => r.status === 'approved').length} rules in ${path}`)
