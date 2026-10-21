import { describe, expect, it } from 'vitest'
import { matchFiles } from '../src/files.js'

const files = [
  'README.md',
  'firestore.rules',
  'packages/app/firestore.rules',
  'schema.sql',
  'supabase/migrations/001_init.sql',
  'supabase/migrations/002_dogs.sql',
  'supabase/migrations/old/000.sql',
  'db/a.sql',
  'db/x/y/b.sql',
  'db/x/notes.txt',
]

describe('matchFiles', () => {
  it('matches * within one segment', () => {
    expect(matchFiles(files, ['*.sql'])).toEqual(['schema.sql'])
    expect(matchFiles(files, ['supabase/migrations/*.sql'])).toEqual(['supabase/migrations/001_init.sql', 'supabase/migrations/002_dogs.sql'])
  })
  it('matches ** across any number of segments, including zero', () => {
    expect(matchFiles(files, ['**/firestore.rules'])).toEqual(['firestore.rules', 'packages/app/firestore.rules'])
    expect(matchFiles(files, ['db/**/*.sql'])).toEqual(['db/a.sql', 'db/x/y/b.sql'])
  })
  it('matches ? as one character and the rest literally', () => {
    expect(matchFiles(files, ['db/?.sql'])).toEqual(['db/a.sql'])
    expect(matchFiles(['a.b', 'axb'], ['a.b'])).toEqual(['a.b'])
  })
  it('returns a sorted list without duplicates, and nothing when no file matches', () => {
    expect(matchFiles(files, ['db/a.sql', 'db/*.sql', '*.sql'])).toEqual(['db/a.sql', 'schema.sql'])
    expect(matchFiles(files, ['migrations/*.sql'])).toEqual([])
  })
})
