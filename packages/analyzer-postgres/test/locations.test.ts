import { beforeAll, describe, expect, it } from 'vitest'
import { statementLocations } from '../src/locations.js'
import { loadSqlParser, type SqlParse } from '../src/pgparse.js'

let parse: SqlParse
beforeAll(async () => { parse = await loadSqlParser() })

describe('statementLocations', () => {
  it('records the line of each CREATE TABLE and CREATE POLICY, latest wins', () => {
    const where = statementLocations([
      { path: 'a.sql', sql: `-- héllo\ncreate table "Teams" (id int);\n\n/* note */\ncreate policy "Read all" on "Teams" for select using (true);\n` },
      { path: 'b.sql', sql: `create table app.items (id int);\ndrop policy "Read all" on "Teams";\n\ncreate policy "Read all" on public."Teams" using (true);` },
      { path: 'bad.sql', sql: 'create tabel x;' },
    ], parse)
    expect(where.tables).toEqual(new Map([
      ['public.Teams', { file: 'a.sql', line: 2 }],
      ['app.items', { file: 'b.sql', line: 1 }],
    ]))
    expect(where.policies).toEqual(new Map([['public.Teams#Read all', { file: 'b.sql', line: 4 }]]))
  })
})
