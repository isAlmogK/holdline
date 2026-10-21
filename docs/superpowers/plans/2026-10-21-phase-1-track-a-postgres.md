# Holdline Phase 1 Track A (Postgres) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `packages/analyzer-postgres`, which reads tables and row level security policies from a project's SQL migrations, and `examples/golden-supabase`, whose twelve rules and twelve file-patch breakages prove it end to end.

**Architecture:** The analyzer applies the migrations to an in-process Postgres (PGlite, Postgres 18.6) with a small Supabase shim, reads the schema from the catalog, and normalizes each policy's `USING` / `WITH CHECK` text (from `pg_get_expr`) into Holdline's `Expr` by parsing it with `libpg-query` (the Postgres 18 parser as WASM). Statement locations also come from `libpg-query`. The whole output is cached by the migration contents. `applyMigrations` is exported for Track C's test runner.

**Tech Stack:** TypeScript 5.9, Node 20+, pnpm workspaces, Vitest 5, `@electric-sql/pglite` 0.5.11 (Postgres 18.6), `libpg-query` 18.1.5 (Postgres 18 parser), `@holdline/core`.

**Spec:** [`docs/superpowers/specs/2026-10-21-data-layers-design.md`](../specs/2026-10-21-data-layers-design.md), sections 3, 6.1 and 8 (Track A row). Reference docs to keep true: [`docs/reference/facts.md`](../../reference/facts.md), [`docs/reference/rules-file.md`](../../reference/rules-file.md).

## Global Constraints

- Node 20 or newer; ESM only; relative imports end in `.js`; TypeScript `strict: true`.
- Holdline makes no network calls and ships no model client. No model decides whether a check passes.
- Never pass silently. Anything the normalizer can't map exactly becomes `{ opaque: <sql text> }`. A normalization may be weaker than the SQL (allow more), never stronger: if the SQL allows a request, the `Expr` must be true for it.
- Analyzer packages depend, among workspace packages, only on `@holdline/core`. `analyzer-postgres` brings `@electric-sql/pglite` and `libpg-query` (exact versions above; PGlite's Postgres major must match the parser's).
- `libpg-query` and PGlite are loaded lazily (dynamic `import()`), only when the analyzer runs. Importing `@holdline/analyzer-postgres` must not load either.
- The libpg-query AST is untyped JSON. `src/sql-ast.ts` is the only file that defines the loose `SqlNode` type; other files use its helpers.
- Table and column names are emitted exactly as Postgres stores them. Ids: table `pg:<schema>.<table>`, policy `pg:<schema>.<table>#policy:<name>`.
- One responsibility per file; split files that pass about 200 lines.
- Files this track owns: `packages/analyzer-postgres/**`, `examples/golden-supabase/**`, one import and one array entry in `packages/cli/src/analyzers.ts`, the Postgres rows of the reference docs. Shared one-line edits, called out in the PR: root `package.json` (typecheck script), `packages/cli/package.json` (dependency), `packages/cli/test/golden-patch.test.ts` (per-app test timeout). Do not edit `packages/core`.
- Never commit DogBase code, rules or facts.
- Conventional commits on branch `claude/phase-1-postgres-09b28c`, never on `main`. Every commit message ends with:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- Tests that start PGlite set a 60 s timeout at the top of the file: `vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })`.

## File Structure

```
packages/analyzer-postgres/
  package.json, tsconfig.json
  src/index.ts        exports postgresAnalyzer, applyMigrations and their types
  src/detect.ts       findMigrations, detectPostgres, Dialect
  src/shim.ts         SUPABASE_SHIM (SQL)
  src/migrate.ts      readMigrations, runMigrations, applyMigrations
  src/tables.ts       readTables (catalog → Table facts), shortType, shortDefault, checkExpr
  src/catalog.ts      readCatalog: tables, relations, functions, policy rows
  src/pgparse.ts      loadSqlParser (lazy libpg-query)
  src/sql-ast.ts      SqlNode, kindOf, nameList, constant, bareSelectTarget, nodeText
  src/locations.ts    statementLocations
  src/scope.ts        Scope, tableScope, functionScope, subqueryScope
  src/operand.ts      operand(): SQL node → Operand (auth functions, claims, columns, constants)
  src/normalize.ts    normalizeCondition, toExpr (boolean structure, comparisons, null tests)
  src/subquery.ts     existsSubquery, inSubquery
  src/inline.ts       inlineCall (SQL helper functions)
  src/anon.ts         forAnonymous, requireSignIn
  src/policies.ts     buildPolicies (ops, restrictive, roles, sign-in)
  src/facts.ts        factsFromDatabase, analyzeMigrations
  src/analyzer.ts     postgresAnalyzer (detect, analyze, cache)
  test/helpers/model.ts      evaluate(Expr, World) for soundness tests
  test/helpers/project.ts    makeProject, contextFor
  test/*.test.ts
examples/golden-supabase/   Next.js stub, supabase/migrations/*.sql, expected-rules.yaml, breakages/R-001..R-012.patch
packages/cli/src/analyzers.ts        + postgresAnalyzer
packages/cli/package.json            + @holdline/analyzer-postgres
packages/cli/test/golden-patch.test.ts  per-app tests get a 120 s timeout
package.json                         typecheck also runs tsc -p packages/analyzer-postgres
docs/reference/facts.md, docs/superpowers/specs/2026-10-21-data-layers-design.md (As built, Track A)
```

## Facts about the tools (verified in a spike)

- `new PGlite()` / `PGlite.create()` takes about 2 s; `select version()` says `PostgreSQL 18.6`. Contrib extensions are separate imports: `import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp'`, `import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'`, passed as `PGlite.create({ extensions: { uuid_ossp, pgcrypto } })`.
- A PGlite query error has `message`, `code` (SQLSTATE) and `position` (1-based character offset into the executed text, as number or string). Unknown extension: `extension "postgis" is not available`.
- Postgres 18 lists NOT NULL constraints in `pg_constraint` with `contype = 'n'`; ignore them (nullability comes from `attnotnull`).
- `polroles` holds OID `0` for `PUBLIC`. `pg_get_expr` output examples:
  - `(( SELECT auth.uid() AS uid) = owner_id)`
  - `(EXISTS ( SELECT 1 FROM memberships m WHERE ((m.org_id = projects.org_id) AND (m.user_id = auth.uid()))))` (unqualified table names are in `public`; columns inside subqueries are qualified)
  - `(org_id IN ( SELECT memberships.org_id FROM memberships WHERE ...))`
  - `((auth.jwt() ->> 'role'::text) = 'x'::text)`, `(((auth.jwt() -> 'app_metadata'::text) ->> 'k'::text) = 'y'::text)`
  - `(amount = ANY (ARRAY[1, 2]))`, `(role = ANY (ARRAY['admin'::mrole, 'owner'::mrole]))`, `(owner_id IS NOT NULL)`, `(NOT (amount < 3))`, `is_member(org_id)`
- `format_type` gives `timestamp with time zone`, `character varying(20)`, `integer`; column defaults come back as `'member'::user_role`, `'x'::character varying`, `gen_random_uuid()`, `now()`. `pg_get_constraintdef` gives `CHECK ((amount > 0))`, `UNIQUE (org_id, user_id)`.
- `libpg-query`: `await loadModule()` once, then `parseSync(sql)` returns `{ stmts: [{ stmt, stmt_location?, stmt_len }] }`. `stmt_location` is a byte offset (absent for the first statement) and already points past comments. Node shapes: every node is `{ Kind: fields }`; `A_Const` is `{ sval: { sval } }`, `{ ival: { ival } }` (ival `0` is `{ ival: {} }`), `{ fval: { fval: '1.5' } }`, `{ boolval: { boolval: true } }` (false is `{ boolval: {} }`), `{ isnull: true }`; `A_Expr { kind: 'AEXPR_OP' | 'AEXPR_OP_ANY' | 'AEXPR_IN', name: [{ String: { sval } }], lexpr, rexpr }` (`IN (1, 2)` has `rexpr: { List: { items } }`); `BoolExpr { boolop: 'AND_EXPR' | 'OR_EXPR' | 'NOT_EXPR', args }`; `NullTest { arg, nulltesttype: 'IS_NULL' | 'IS_NOT_NULL' }`; `SubLink { subLinkType: 'EXISTS_SUBLINK' | 'ANY_SUBLINK' | 'EXPR_SUBLINK', testexpr?, operName?, subselect: { SelectStmt } }`; `FuncCall { funcname, args? }`; `ColumnRef { fields }` (`*` is `{ A_Star: {} }`); `TypeCast { arg, typeName: { names } }` (`::integer` has names `['pg_catalog', 'int4']`); `A_ArrayExpr { elements }`; `ParamRef { number }`; `RangeVar { schemaname?, relname, alias?: { aliasname } }`; `CreateStmt { relation: RangeVar }`; `CreatePolicyStmt { policy_name, table: RangeVar }`. Unquoted identifiers are already lowercased.

---

### Task 1: Package scaffold and migration discovery

**Files:**
- Create: `packages/analyzer-postgres/package.json`, `packages/analyzer-postgres/tsconfig.json`, `packages/analyzer-postgres/src/detect.ts`, `packages/analyzer-postgres/src/index.ts`
- Modify: root `package.json` (typecheck script)
- Test: `packages/analyzer-postgres/test/detect.test.ts`

**Interfaces:**
- Consumes: `matchFiles(files, globs)`, `HoldlineConfig` from `@holdline/core`.
- Produces:
  - `type Dialect = 'supabase' | 'plain'`
  - `interface MigrationPlan { paths: string[]; dialect: Dialect; configured: boolean }`
  - `findMigrations(files: readonly string[], config: HoldlineConfig): MigrationPlan`
  - `detectPostgres(files: readonly string[], config: HoldlineConfig): boolean`

- [ ] **Step 1: Create the package**

`packages/analyzer-postgres/package.json`:

```json
{
  "name": "@holdline/analyzer-postgres",
  "version": "0.0.0",
  "type": "module",
  "license": "Apache-2.0",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "@electric-sql/pglite": "0.5.11",
    "@holdline/core": "workspace:*",
    "libpg-query": "18.1.5"
  }
}
```

`packages/analyzer-postgres/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
```

Root `package.json` script becomes:

```json
"typecheck": "tsc -p packages/core && tsc -p packages/cli && tsc -p packages/analyzer-postgres",
```

Run: `pnpm install` (updates `pnpm-lock.yaml`).

- [ ] **Step 2: Write the failing test**

`packages/analyzer-postgres/test/detect.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { detectPostgres, findMigrations } from '../src/detect.js'

describe('findMigrations', () => {
  it('finds Supabase migrations in sorted order and picks the supabase dialect', () => {
    const files = ['supabase/migrations/002_b.sql', 'supabase/migrations/001_a.sql', 'src/app.ts']
    expect(findMigrations(files, {})).toEqual({
      paths: ['supabase/migrations/001_a.sql', 'supabase/migrations/002_b.sql'], dialect: 'supabase', configured: false,
    })
  })

  it('finds Prisma, Drizzle and plain migration folders with the plain dialect', () => {
    const files = [
      'prisma/migrations/0002_x/migration.sql', 'prisma/migrations/0001_init/migration.sql',
      'drizzle/0000_a.sql', 'migrations/001.sql', 'db/migrations/001.sql', 'db/seed.sql',
    ]
    expect(findMigrations(files, {})).toEqual({
      paths: ['db/migrations/001.sql', 'drizzle/0000_a.sql', 'migrations/001.sql',
        'prisma/migrations/0001_init/migration.sql', 'prisma/migrations/0002_x/migration.sql'],
      dialect: 'plain', configured: false,
    })
  })

  it('uses the configured globs and dialect instead of the defaults', () => {
    const files = ['sql/b.sql', 'sql/a.sql', 'supabase/migrations/001.sql']
    expect(findMigrations(files, { postgres: { migrations: ['sql/*.sql'], dialect: 'supabase' } }))
      .toEqual({ paths: ['sql/a.sql', 'sql/b.sql'], dialect: 'supabase', configured: true })
    expect(findMigrations(files, { postgres: { migrations: ['sql/*.sql'] } }).dialect).toBe('plain')
  })
})

describe('detectPostgres', () => {
  it('runs for migrations, a configured section, or a Prisma schema', () => {
    expect(detectPostgres(['supabase/migrations/001.sql'], {})).toBe(true)
    expect(detectPostgres(['src/app.ts'], { postgres: { migrations: ['none/*.sql'] } })).toBe(true)
    expect(detectPostgres(['prisma/schema.prisma'], {})).toBe(true)
    expect(detectPostgres(['src/app.ts', 'schema.sql'], {})).toBe(false)
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm vitest run packages/analyzer-postgres/test/detect.test.ts`
Expected: FAIL, cannot find `../src/detect.js`.

- [ ] **Step 4: Implement**

`packages/analyzer-postgres/src/detect.ts`:

```ts
import { matchFiles, type HoldlineConfig } from '@holdline/core'

export type Dialect = 'supabase' | 'plain'

const SUPABASE = 'supabase/migrations/*.sql'
const DEFAULT_GLOBS = [SUPABASE, 'prisma/migrations/*/migration.sql', 'drizzle/*.sql', 'migrations/*.sql', 'db/migrations/*.sql']

export interface MigrationPlan {
  paths: string[] // in apply order: every supported tool names migrations so that sorted order is apply order
  dialect: Dialect
  configured: boolean // postgres.migrations is set in .holdline/config.yaml
}

export function findMigrations(files: readonly string[], config: HoldlineConfig): MigrationPlan {
  const section = config.postgres ?? {}
  const configured = section.migrations !== undefined
  const paths = matchFiles(files, section.migrations ?? DEFAULT_GLOBS)
  const dialect = section.dialect ?? (matchFiles(paths, [SUPABASE]).length > 0 ? 'supabase' : 'plain')
  return { paths, dialect, configured }
}

// A Prisma schema without migrations still runs the analyzer, so it can say why there are no tables.
export function detectPostgres(files: readonly string[], config: HoldlineConfig): boolean {
  const plan = findMigrations(files, config)
  return plan.configured || plan.paths.length > 0 || files.includes('prisma/schema.prisma')
}
```

`packages/analyzer-postgres/src/index.ts` (grows in later tasks):

```ts
export { detectPostgres, findMigrations, type Dialect, type MigrationPlan } from './detect.js'
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `pnpm vitest run packages/analyzer-postgres/test/detect.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml packages/analyzer-postgres
git commit -m "feat(analyzer-postgres): scaffold package and find migrations"
```

---

### Task 2: Supabase shim and `applyMigrations`

**Files:**
- Create: `packages/analyzer-postgres/src/shim.ts`, `packages/analyzer-postgres/src/migrate.ts`, `packages/analyzer-postgres/test/helpers/project.ts`
- Modify: `packages/analyzer-postgres/src/index.ts`
- Test: `packages/analyzer-postgres/test/migrate.test.ts`

**Interfaces:**
- Consumes: `findMigrations`, `Dialect` (Task 1); `listFiles`, `HoldlineConfig` from core.
- Produces (Track C imports `applyMigrations` and these types):
  - `interface Migration { path: string; sql: string }`
  - `interface MigrationFailure { file: string; line?: number; message: string }`
  - `interface MigrationRun { db: PGlite; dialect: Dialect; migrations: Migration[]; failure?: MigrationFailure }` — the caller closes `db`.
  - `readMigrations(root: string, paths: readonly string[]): Promise<Migration[]>`
  - `runMigrations(migrations: readonly Migration[], dialect: Dialect): Promise<MigrationRun>`
  - `applyMigrations(root: string, config: HoldlineConfig, files?: readonly string[]): Promise<MigrationRun>` (`files` defaults to `listFiles(root)`)
  - Test helper `makeProject(files: Record<string, string>): Promise<string>` (temp dir).

- [ ] **Step 1: Write the failing tests**

`packages/analyzer-postgres/test/helpers/project.ts`:

```ts
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export async function makeProject(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holdline-pg-'))
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }
  return root
}
```

`packages/analyzer-postgres/test/migrate.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyMigrations, runMigrations, type MigrationRun } from '../src/migrate.js'
import { makeProject } from './helpers/project.js'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

let run: MigrationRun | undefined
afterEach(async () => { await run?.db.close(); run = undefined })

describe('applyMigrations', () => {
  it('applies Supabase migrations in order on top of the shim', async () => {
    const root = await makeProject({
      'supabase/migrations/002_b.sql': 'alter table public.a add column note text;',
      'supabase/migrations/001_a.sql': 'create table public.a (id uuid primary key default extensions.uuid_generate_v4(), owner uuid references auth.users (id));',
    })
    run = await applyMigrations(root, {})
    expect(run.failure).toBeUndefined()
    expect(run.dialect).toBe('supabase')
    expect(run.migrations.map(m => m.path)).toEqual(['supabase/migrations/001_a.sql', 'supabase/migrations/002_b.sql'])
    const cols = await run.db.query<{ attname: string }>(`select attname from pg_attribute where attrelid = 'public.a'::regclass and attnum > 0 order by attnum`)
    expect(cols.rows.map(r => r.attname)).toEqual(['id', 'owner', 'note'])
  })

  it('reads auth.uid(), auth.jwt() and auth.role() from request.jwt.claims', async () => {
    run = await runMigrations([], 'supabase')
    const before = await run.db.query<{ uid: string | null }>(`select auth.uid() as uid`)
    expect(before.rows[0]!.uid).toBeNull()
    await run.db.exec('begin')
    await run.db.query(`select set_config('request.jwt.claims', $1, true)`,
      [JSON.stringify({ sub: '00000000-0000-0000-0000-000000000001', role: 'authenticated', user_role: 'admin' })])
    const r = await run.db.query<{ uid: string; role: string; claim: string }>(`select auth.uid() as uid, auth.role() as role, auth.jwt() ->> 'user_role' as claim`)
    expect(r.rows[0]).toEqual({ uid: '00000000-0000-0000-0000-000000000001', role: 'authenticated', claim: 'admin' })
    await run.db.exec('rollback')
    // After a transaction-local setting is rolled back the setting is '' rather than unset: still null, not an error.
    expect((await run.db.query<{ uid: string | null }>(`select auth.uid() as uid`)).rows[0]!.uid).toBeNull()
  })

  it('lets the authenticated role use public tables (Supabase default privileges)', async () => {
    run = await runMigrations([{ path: 'm.sql', sql: 'create table public.t (id int);' }], 'supabase')
    await run.db.exec('begin; set local role authenticated; select * from public.t; rollback;')
  })

  it('does not create the shim for the plain dialect', async () => {
    run = await runMigrations([{ path: 'm.sql', sql: 'create schema auth; create table auth.users (id int);' }], 'plain')
    expect(run.failure).toBeUndefined()
  })

  it('stops at the first failing migration and reports its file, line and message', async () => {
    run = await runMigrations([
      { path: 'a.sql', sql: 'create table public.a (id int);' },
      { path: 'b.sql', sql: 'create table public.b (id int);\nselect nosuch from public.b;' },
      { path: 'c.sql', sql: 'create table public.c (id int);' },
    ], 'plain')
    expect(run.failure).toEqual({ file: 'b.sql', line: 2, message: 'column "nosuch" does not exist (line 2)' })
    const tables = await run.db.query<{ relname: string }>(`select relname from pg_class where relname in ('a', 'b', 'c') order by 1`)
    expect(tables.rows.map(r => r.relname)).toEqual(['a'])
  })

  it('names an extension PGlite does not ship', async () => {
    run = await runMigrations([{ path: 'x.sql', sql: 'create extension postgis;' }], 'plain')
    expect(run.failure?.message).toMatch(/extension "postgis" is not available/)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/analyzer-postgres/test/migrate.test.ts`
Expected: FAIL, cannot find `../src/migrate.js`.

- [ ] **Step 3: Implement**

`packages/analyzer-postgres/src/shim.ts`:

```ts
// What Supabase migrations expect to exist before they run. Claims come from the transaction-local
// setting `request.jwt.claims`; `nullif(..., '')` because a rolled-back local setting reads as ''.
export const SUPABASE_SHIM = `
create schema if not exists auth;
create schema if not exists storage;
create schema if not exists extensions;
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
grant usage on schema public, auth, storage, extensions to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
create function auth.jwt() returns jsonb language sql stable
  as $$ select nullif(current_setting('request.jwt.claims', true), '')::jsonb $$;
create function auth.uid() returns uuid language sql stable
  as $$ select (nullif(current_setting('request.jwt.claims', true), '')::json ->> 'sub')::uuid $$;
create function auth.role() returns text language sql stable
  as $$ select nullif(current_setting('request.jwt.claims', true), '')::json ->> 'role' $$;
create table auth.users (id uuid primary key, email text);
create table storage.buckets (id text primary key, name text not null, public boolean not null default false);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text,
  owner uuid,
  metadata jsonb
);
`
```

`packages/analyzer-postgres/src/migrate.ts`:

```ts
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PGlite } from '@electric-sql/pglite'
import { listFiles, type HoldlineConfig } from '@holdline/core'
import { findMigrations, type Dialect } from './detect.js'
import { SUPABASE_SHIM } from './shim.js'

export interface Migration { path: string; sql: string }
export interface MigrationFailure { file: string; line?: number; message: string }
export interface MigrationRun {
  db: PGlite // the caller closes it
  dialect: Dialect
  migrations: Migration[]
  failure?: MigrationFailure // the first migration that failed; later ones were not applied
}

export async function readMigrations(root: string, paths: readonly string[]): Promise<Migration[]> {
  return Promise.all(paths.map(async path => ({ path, sql: await readFile(join(root, path), 'utf8') })))
}

// A fresh in-memory Postgres; the Supabase shim for that dialect; each migration in its own transaction.
// Stops at the first failure, because later migrations would run against the wrong schema.
export async function runMigrations(migrations: readonly Migration[], dialect: Dialect): Promise<MigrationRun> {
  const { PGlite } = await import('@electric-sql/pglite')
  const { uuid_ossp } = await import('@electric-sql/pglite/contrib/uuid_ossp')
  const { pgcrypto } = await import('@electric-sql/pglite/contrib/pgcrypto')
  const db = await PGlite.create({ extensions: { uuid_ossp, pgcrypto } })
  const run: MigrationRun = { db, dialect, migrations: [...migrations] }
  if (dialect === 'supabase') await db.exec(SUPABASE_SHIM)
  for (const m of migrations) {
    try {
      await db.transaction(tx => tx.exec(m.sql))
    } catch (e) {
      return { ...run, failure: failureOf(m, e) }
    }
  }
  return run
}

function failureOf(m: Migration, e: unknown): MigrationFailure {
  const message = e instanceof Error ? e.message : String(e)
  const position = Number((e as { position?: unknown }).position)
  if (!Number.isInteger(position) || position < 1) return { file: m.path, message }
  const line = m.sql.slice(0, position - 1).split('\n').length
  return { file: m.path, line, message: `${message} (line ${line})` }
}

// The migrations of the project at `root`, applied the way the analyzer applies them (spec 3.2).
export async function applyMigrations(root: string, config: HoldlineConfig, files?: readonly string[]): Promise<MigrationRun> {
  const plan = findMigrations(files ?? await listFiles(root), config)
  return runMigrations(await readMigrations(root, plan.paths), plan.dialect)
}
```

Note: `applyMigrations` called on a temp dir that is not a git repository: `listFiles` falls back to a directory walk.

Add to `src/index.ts`:

```ts
export { applyMigrations, readMigrations, runMigrations, type Migration, type MigrationFailure, type MigrationRun } from './migrate.js'
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm vitest run packages/analyzer-postgres/test/migrate.test.ts && pnpm typecheck`
Expected: PASS. If `PGlite.create` with contrib extensions is not accepted by the types, cast the `extensions` object, never drop the extensions.

- [ ] **Step 5: Commit**

```bash
git add packages/analyzer-postgres
git commit -m "feat(analyzer-postgres): apply migrations in PGlite with the Supabase shim"
```

---

### Task 3: Read tables from the catalog

**Files:**
- Create: `packages/analyzer-postgres/src/tables.ts`
- Test: `packages/analyzer-postgres/test/tables.test.ts`, `packages/analyzer-postgres/test/golden-ts-postgres.test.ts`

**Interfaces:**
- Consumes: `runMigrations`, `readMigrations` (Task 2); `Table`, `parseFacts` from core.
- Produces:
  - `readTables(db: PGlite, excluded: readonly string[]): Promise<Table[]>` — every ordinary or partitioned table outside system schemas and `excluded`, sorted by schema then name, with no `location`.
  - `shortType(t: string): string`, `shortDefault(d: string): string`, `checkExpr(def: string): string`
  - `SYSTEM_SCHEMAS_SQL: string` — SQL condition on `n.nspname` excluding `information_schema` and `pg_*`.
  - `sqlList(names: readonly string[]): string` — quoted SQL list.

Formatting rules (record each in As built): verbose time types are shortened (`timestamp with time zone` → `timestamptz`, `timestamp without time zone` → `timestamp`, the same for `time`, keeping a precision `(3)` and an array suffix), `character varying` → `varchar`, `character` → `char`; other types stay as `format_type` prints them. A default that is a quoted literal with a cast (`'member'::user_role`) loses the cast. Foreign keys, uniques and checks are ordered by their first column's position, then name.

- [ ] **Step 1: Write the failing tests**

`packages/analyzer-postgres/test/tables.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { runMigrations, type MigrationRun } from '../src/migrate.js'
import { checkExpr, readTables, shortDefault, shortType } from '../src/tables.js'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const SQL = `
create type public.member_role as enum ('owner', 'admin', 'member');
create table public.orgs (id uuid primary key default gen_random_uuid(), name varchar(40) not null default 'x');
create table public.members (
  org_id uuid not null references public.orgs (id),
  user_id uuid not null,
  role public.member_role not null default 'member',
  joined timestamp(3) with time zone,
  constraint members_org_user_key unique (org_id, user_id)
);
create unique index members_user_only on public.members (user_id) where role = 'owner';
create unique index members_joined on public.members (joined);
create table public.invoices (id int primary key, amount int not null check (amount > 0));
alter table public.invoices enable row level security;
`

let run: MigrationRun
beforeAll(async () => { run = await runMigrations([{ path: 'm.sql', sql: SQL }], 'supabase') })
afterAll(async () => { await run.db.close() })

describe('readTables', () => {
  it('reads columns, keys, uniques, checks, enums and RLS, without the shim schemas', async () => {
    const tables = await readTables(run.db, ['auth', 'storage', 'extensions'])
    expect(tables.map(t => t.id)).toEqual(['pg:public.invoices', 'pg:public.members', 'pg:public.orgs'])
    const [invoices, members, orgs] = tables
    expect(orgs).toEqual({
      id: 'pg:public.orgs', name: 'public.orgs',
      columns: [
        { name: 'id', type: 'uuid', nullable: false, default: 'gen_random_uuid()' },
        { name: 'name', type: 'varchar(40)', nullable: false, default: "'x'" },
      ],
      primaryKey: ['id'], foreignKeys: [], uniques: [], checks: [], enums: [], rlsEnabled: false,
    })
    expect(members!.columns[2]).toEqual({ name: 'role', type: 'member_role', nullable: false, default: "'member'" })
    expect(members!.columns[3]).toEqual({ name: 'joined', type: 'timestamptz(3)', nullable: true })
    expect(members!.foreignKeys).toEqual([{ columns: ['org_id'], references: { table: 'public.orgs', columns: ['id'] } }])
    // the partial unique index is not a uniqueness guarantee and is left out
    expect(members!.uniques).toEqual([['org_id', 'user_id'], ['joined']])
    expect(members!.enums).toEqual([{ column: 'role', values: ['owner', 'admin', 'member'] }])
    expect(invoices!.checks).toEqual([{ name: 'invoices_amount_check', expr: '(amount > 0)' }])
    expect(invoices!.rlsEnabled).toBe(true)
  })
})

describe('formatting', () => {
  it('shortens verbose types and keeps the rest', () => {
    expect(shortType('timestamp with time zone')).toBe('timestamptz')
    expect(shortType('timestamp(3) without time zone[]')).toBe('timestamp(3)[]')
    expect(shortType('time with time zone')).toBe('timetz')
    expect(shortType('character varying(20)')).toBe('varchar(20)')
    expect(shortType('character(1)')).toBe('char(1)')
    expect(shortType('integer')).toBe('integer')
    expect(shortType('numeric(12,2)')).toBe('numeric(12,2)')
  })
  it('drops the cast from a quoted literal default only', () => {
    expect(shortDefault("'member'::user_role")).toBe("'member'")
    expect(shortDefault("'it''s'::text")).toBe("'it''s'")
    expect(shortDefault('now()')).toBe('now()')
    expect(shortDefault("('a'::text || 'b'::text)")).toBe("('a'::text || 'b'::text)")
  })
  it('removes the outer CHECK and NOT VALID', () => {
    expect(checkExpr('CHECK ((amount > 0))')).toBe('(amount > 0)')
    expect(checkExpr('CHECK ((amount > 0)) NOT VALID')).toBe('(amount > 0)')
  })
})
```

`packages/analyzer-postgres/test/golden-ts-postgres.test.ts` (the spec's done item 4; extended in Task 9 to run through the analyzer):

```ts
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { parseFacts } from '@holdline/core'
import { describe, expect, it, vi } from 'vitest'
import { readMigrations, runMigrations } from '../src/migrate.js'
import { readTables } from '../src/tables.js'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const app = fileURLToPath(new URL('../../../examples/golden-ts-postgres/', import.meta.url))
const byId = <T extends { id: string }>(xs: T[]) => [...xs].sort((a, b) => a.id.localeCompare(b.id))

describe('golden-ts-postgres', () => {
  it('reads the same tables from the migration as the hand-written facts (without locations)', async () => {
    const expected = parseFacts(JSON.parse(await readFile(`${app}fixtures/facts.json`, 'utf8'))).tables
    const run = await runMigrations(await readMigrations(app, ['prisma/migrations/0001_init/migration.sql']), 'plain')
    try {
      const tables = parseFacts({ version: 1, tables: await readTables(run.db, []) }).tables
      expect(byId(tables)).toEqual(byId(expected).map(({ location: _location, ...t }) => t))
    } finally {
      await run.db.close()
    }
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/analyzer-postgres/test/tables.test.ts packages/analyzer-postgres/test/golden-ts-postgres.test.ts`
Expected: FAIL, cannot find `../src/tables.js`.

- [ ] **Step 3: Implement**

`packages/analyzer-postgres/src/tables.ts`:

```ts
import type { PGlite } from '@electric-sql/pglite'
import type { Table } from '@holdline/core'

export const SYSTEM_SCHEMAS_SQL = `n.nspname <> 'information_schema' and n.nspname not like 'pg\\_%'`

export const sqlList = (names: readonly string[]) =>
  names.length === 0 ? `''` : names.map(n => `'${n.replace(/'/g, "''")}'`).join(', ')

// Aliases avoid reserved words ("table", "default").
interface TableRow { schema: string; tbl: string; rls: boolean }
interface ColumnRow { schema: string; tbl: string; name: string; type: string; nullable: boolean; dflt: string | null; enum_values: string[] | null }
interface ConstraintRow { schema: string; tbl: string; name: string; type: 'p' | 'u' | 'f' | 'c'; def: string; columns: string[]; ref_schema: string | null; ref_table: string | null; ref_columns: string[] }
interface IndexRow { schema: string; tbl: string; columns: string[] }

const SHORT: [RegExp, string][] = [
  [/^timestamp(\(\d+\))? with time zone/, 'timestamptz$1'],
  [/^timestamp(\(\d+\))? without time zone/, 'timestamp$1'],
  [/^time(\(\d+\))? with time zone/, 'timetz$1'],
  [/^time(\(\d+\))? without time zone/, 'time$1'],
  [/^character varying/, 'varchar'],
  [/^character(?=\(|\[|$)/, 'char'],
]

export function shortType(t: string): string {
  for (const [re, to] of SHORT) if (re.test(t)) return t.replace(re, to)
  return t
}

export function shortDefault(d: string): string {
  return d.replace(/^('(?:[^']|'')*')::[^'()]+$/, '$1')
}

export function checkExpr(def: string): string {
  return def.replace(/ NOT VALID$/, '').replace(/^CHECK \((.*)\)$/s, '$1')
}

export async function readTables(db: PGlite, excluded: readonly string[]): Promise<Table[]> {
  const where = `${SYSTEM_SCHEMAS_SQL} and n.nspname not in (${sqlList(excluded)}) and c.relkind in ('r', 'p')`
  const from = `pg_class c join pg_namespace n on n.oid = c.relnamespace`
  const tables = (await db.query<TableRow>(
    `select n.nspname as schema, c.relname as tbl, c.relrowsecurity as rls from ${from} where ${where} order by 1, 2`)).rows
  const columns = (await db.query<ColumnRow>(`
    select n.nspname as schema, c.relname as tbl, a.attname as name, format_type(a.atttypid, a.atttypmod) as type,
      not a.attnotnull as nullable, pg_get_expr(d.adbin, d.adrelid) as dflt,
      case when t.typtype = 'e' then array(select e.enumlabel::text from pg_enum e where e.enumtypid = t.oid order by e.enumsortorder) end as enum_values
    from pg_attribute a join ${from} on c.oid = a.attrelid join pg_type t on t.oid = a.atttypid
      left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where a.attnum > 0 and not a.attisdropped and ${where}
    order by 1, 2, a.attnum`)).rows
  const constraints = (await db.query<ConstraintRow>(`
    select n.nspname as schema, c.relname as tbl, k.conname as name, k.contype as type, pg_get_constraintdef(k.oid) as def,
      array(select a.attname::text from unnest(k.conkey) with ordinality u(num, i) join pg_attribute a on a.attrelid = k.conrelid and a.attnum = u.num order by u.i) as columns,
      fn.nspname as ref_schema, fc.relname as ref_table,
      array(select a.attname::text from unnest(k.confkey) with ordinality u(num, i) join pg_attribute a on a.attrelid = k.confrelid and a.attnum = u.num order by u.i) as ref_columns
    from pg_constraint k join ${from} on c.oid = k.conrelid
      left join pg_class fc on fc.oid = k.confrelid left join pg_namespace fn on fn.oid = fc.relnamespace
    where k.contype in ('p', 'u', 'f', 'c') and ${where}
    order by 1, 2, k.conkey[1], k.conname`)).rows
  // Unique indexes that back no constraint; partial and expression indexes don't guarantee uniqueness of the columns.
  const indexes = (await db.query<IndexRow>(`
    select n.nspname as schema, c.relname as tbl,
      array(select a.attname::text from unnest(i.indkey::int2[]) with ordinality u(num, o) join pg_attribute a on a.attrelid = i.indrelid and a.attnum = u.num where u.o <= i.indnkeyatts order by u.o) as columns
    from pg_index i join ${from} on c.oid = i.indrelid join pg_class ic on ic.oid = i.indexrelid
    where i.indisunique and not i.indisprimary and i.indexprs is null and i.indpred is null
      and not exists (select 1 from pg_constraint k where k.conindid = i.indexrelid) and ${where}
    order by 1, 2, i.indkey[0], ic.relname`)).rows

  const of = <R extends { schema: string; tbl: string }>(rows: R[], t: TableRow) => rows.filter(r => r.schema === t.schema && r.tbl === t.tbl)
  return tables.map((t): Table => {
    const name = `${t.schema}.${t.tbl}`
    const cols = of(columns, t)
    const cons = of(constraints, t)
    return {
      id: `pg:${name}`,
      name,
      columns: cols.map(c => ({ name: c.name, type: shortType(c.type), nullable: c.nullable, ...(c.dflt === null ? {} : { default: shortDefault(c.dflt) }) })),
      primaryKey: cons.find(k => k.type === 'p')?.columns ?? [],
      foreignKeys: cons.filter(k => k.type === 'f').map(k => ({ columns: k.columns, references: { table: `${k.ref_schema}.${k.ref_table}`, columns: k.ref_columns } })),
      uniques: [...cons.filter(k => k.type === 'u').map(k => k.columns), ...of(indexes, t).map(i => i.columns)],
      checks: cons.filter(k => k.type === 'c').map(k => ({ name: k.name, expr: checkExpr(k.def) })),
      enums: cols.filter(c => c.enum_values !== null).map(c => ({ column: c.name, values: c.enum_values! })),
      rlsEnabled: t.rls,
    }
  })
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm vitest run packages/analyzer-postgres/test/tables.test.ts packages/analyzer-postgres/test/golden-ts-postgres.test.ts && pnpm typecheck`
Expected: PASS. If the golden comparison differs, print both and fix the reader (never edit `fixtures/facts.json`); record any unavoidable difference for As built.

- [ ] **Step 5: Commit**

```bash
git add packages/analyzer-postgres
git commit -m "feat(analyzer-postgres): read tables, keys, checks and enums from the catalog"
```

---

### Task 4: SQL parser loader, AST helpers and statement locations

**Files:**
- Create: `packages/analyzer-postgres/src/pgparse.ts`, `packages/analyzer-postgres/src/sql-ast.ts`, `packages/analyzer-postgres/src/locations.ts`
- Test: `packages/analyzer-postgres/test/sql-ast.test.ts`, `packages/analyzer-postgres/test/locations.test.ts`

**Interfaces:**
- Consumes: `Migration` (Task 2); `Literal`, `Location` from core.
- Produces:
  - `type SqlNode` (loose libpg-query node), `interface ParsedStatement { stmt: SqlNode; stmt_location?: number; stmt_len?: number }`, `type SqlParse = (sql: string) => { stmts: ParsedStatement[] }`
  - `loadSqlParser(): Promise<SqlParse>` (loads `libpg-query` once, lazily)
  - `kindOf(node): [string, SqlNode] | undefined`, `nameList(list): string[]`, `constant(node): { value: Literal } | undefined`, `bareSelectTarget(select): SqlNode | undefined`, `nodeText(source: string, node: SqlNode): string`
  - `interface StatementLocations { tables: Map<string, Location>; policies: Map<string, Location> }` keyed `schema.table` and `schema.table#policy name`
  - `statementLocations(migrations: readonly Migration[], parse: SqlParse): StatementLocations`

Location rule: a table is located at its latest `CREATE TABLE` and a policy at its latest `CREATE POLICY` (the declaration line, as facts.md requires and `golden-ts-postgres` expects). `ALTER TABLE` statements are not used for locations (As built difference from spec 3.4).

- [ ] **Step 1: Write the failing tests**

`packages/analyzer-postgres/test/sql-ast.test.ts`:

```ts
import { beforeAll, describe, expect, it } from 'vitest'
import { loadSqlParser, type SqlParse } from '../src/pgparse.js'
import { bareSelectTarget, constant, nodeText, type SqlNode } from '../src/sql-ast.js'

let parse: SqlParse
beforeAll(async () => { parse = await loadSqlParser() })
const expr = (sql: string): SqlNode => bareSelectTarget(parse(`SELECT ${sql}`).stmts[0]!.stmt)!

describe('constant', () => {
  it('reads constants and strips casts', () => {
    expect(constant(expr(`'a'`))).toEqual({ value: 'a' })
    expect(constant(expr(`''`))).toEqual({ value: '' })
    expect(constant(expr(`0`))).toEqual({ value: 0 })
    expect(constant(expr(`-2`))).toEqual({ value: -2 })
    expect(constant(expr(`1.5`))).toEqual({ value: 1.5 })
    expect(constant(expr(`false`))).toEqual({ value: false })
    expect(constant(expr(`null`))).toEqual({ value: null })
    expect(constant(expr(`'admin'::member_role`))).toEqual({ value: 'admin' })
    expect(constant(expr(`'5'::integer`))).toEqual({ value: 5 })
    expect(constant(expr(`'A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11'::uuid`))).toEqual({ value: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' })
    expect(constant(expr(`'t'::boolean`))).toBeUndefined()
    expect(constant(expr(`x`))).toBeUndefined()
  })
})

describe('bareSelectTarget', () => {
  it('returns the single target of a SELECT with nothing else', () => {
    expect(bareSelectTarget(parse('SELECT 1').stmts[0]!.stmt)).toBeDefined()
    expect(bareSelectTarget(parse('SELECT 1, 2').stmts[0]!.stmt)).toBeUndefined()
    expect(bareSelectTarget(parse('SELECT 1 FROM t').stmts[0]!.stmt)).toBeUndefined()
    expect(bareSelectTarget(parse('SELECT 1 WHERE true').stmts[0]!.stmt)).toBeUndefined()
  })
})

describe('nodeText', () => {
  it('gives the source text of a node', () => {
    const source = `SELECT coalesce(a, 'é') = lower(b) AND c`
    const top = bareSelectTarget(parse(source).stmts[0]!.stmt)!
    const left = top.BoolExpr.args[0]
    expect(nodeText(source, left)).toBe(`coalesce(a, 'é') = lower(b)`)
    expect(nodeText(source, top)).toBe(`coalesce(a, 'é') = lower(b) AND c`)
    const call = `SELECT ((owner_id)::text = auth.uid())`
    expect(nodeText(call, bareSelectTarget(parse(call).stmts[0]!.stmt)!)).toBe('(owner_id)::text = auth.uid()')
  })
})
```

`packages/analyzer-postgres/test/locations.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/analyzer-postgres/test/sql-ast.test.ts packages/analyzer-postgres/test/locations.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`packages/analyzer-postgres/src/pgparse.ts`:

```ts
import type { SqlNode } from './sql-ast.js'

export interface ParsedStatement { stmt: SqlNode; stmt_location?: number; stmt_len?: number }
export type SqlParse = (sql: string) => { stmts: ParsedStatement[] }

let parser: Promise<SqlParse> | undefined

// libpg-query is a large WASM module: load it only when the Postgres analyzer runs.
export function loadSqlParser(): Promise<SqlParse> {
  parser ??= import('libpg-query').then(async m => {
    await m.loadModule()
    return (sql: string) => m.parseSync(sql) as unknown as { stmts: ParsedStatement[] }
  })
  return parser
}
```

`packages/analyzer-postgres/src/sql-ast.ts`:

```ts
import type { Literal } from '@holdline/core'

// libpg-query returns untyped JSON in which every node is `{ <Kind>: { ...fields } }`. This is the only
// file that names the loose type; the rest of the package reads nodes through these helpers.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SqlNode = Record<string, any>

export function kindOf(node: SqlNode | undefined): [string, SqlNode] | undefined {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return undefined
  const keys = Object.keys(node)
  return keys.length === 1 ? [keys[0]!, node[keys[0]!] as SqlNode] : undefined
}

// `[{ String: { sval: 'auth' } }, { String: { sval: 'uid' } }]` → ['auth', 'uid']; `*` becomes ''.
export function nameList(list: SqlNode[] | undefined): string[] {
  return (list ?? []).map(n => (n?.String?.sval as string | undefined) ?? '')
}

const NUMERIC = new Set(['int2', 'int4', 'int8', 'integer', 'bigint', 'smallint', 'numeric', 'decimal', 'float4', 'float8', 'real'])

// A constant, with a cast around it applied the way Postgres would for the values we can model:
// numbers parse, uuids lowercase, other string casts keep the string. A boolean cast of a string is not read.
export function constant(node: SqlNode | undefined): { value: Literal } | undefined {
  const k = kindOf(node)
  if (!k) return undefined
  const [kind, f] = k
  if (kind === 'TypeCast') {
    const inner = constant(f.arg)
    if (!inner || typeof inner.value !== 'string') return inner
    const type = nameList(f.typeName?.names).at(-1) ?? ''
    if (NUMERIC.has(type)) {
      const n = Number(inner.value)
      return inner.value.trim() !== '' && Number.isFinite(n) ? { value: n } : undefined
    }
    if (type === 'bool' || type === 'boolean') return undefined
    if (type === 'uuid') return { value: inner.value.toLowerCase() }
    return inner
  }
  if (kind !== 'A_Const') return undefined
  if (f.isnull) return { value: null }
  if (f.sval) return { value: (f.sval.sval as string | undefined) ?? '' }
  if (f.ival) return { value: (f.ival.ival as number | undefined) ?? 0 }
  if (f.fval) return { value: Number(f.fval.fval) }
  if (f.boolval) return { value: f.boolval.boolval === true }
  return undefined
}

// The one expression of `SELECT <expr>` when the SELECT has nothing else (no FROM, WHERE, ...).
export function bareSelectTarget(select: SqlNode | undefined): SqlNode | undefined {
  const s = select?.SelectStmt as SqlNode | undefined
  if (!s || s.fromClause || s.whereClause || s.groupClause || s.havingClause || s.withClause || s.distinctClause
    || s.limitCount || s.limitOffset || s.valuesLists || (s.op && s.op !== 'SETOP_NONE')) return undefined
  const targets = s.targetList as SqlNode[] | undefined
  return targets?.length === 1 ? (targets[0]!.ResTarget?.val as SqlNode | undefined) : undefined
}

const WORD = /[A-Za-z0-9_."$]/

// The source text of a node, for opaque conditions (best effort: it is shown to people, never compared).
// Locations are byte offsets: from the first location in the node to the end of the token at the last one,
// widened to balance parentheses (a call's argument list, a parenthesized operand).
export function nodeText(source: string, node: SqlNode): string {
  const bytes = Buffer.from(source)
  const locations: number[] = []
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (k === 'location' && typeof x === 'number') { if (x >= 0) locations.push(x) } else walk(x)
      }
    }
  }
  walk(node)
  if (locations.length === 0) return source
  let start = Math.min(...locations)
  let end = tokenEnd(bytes, Math.max(...locations))
  if (bytes[end] === 40) end++ // `auth.uid(`: the last token is a call with no arguments
  const open = () => [...bytes.subarray(start, end).toString()].reduce((d, c) => d + (c === '(' ? 1 : c === ')' ? -1 : 0), 0)
  while (end < bytes.length && open() > 0) end++
  while (start > 0 && open() < 0) start--
  return bytes.subarray(start, end).toString().trim()
}

function tokenEnd(b: Buffer, i: number): number {
  const isWord = (j: number) => b[j]! >= 128 || WORD.test(String.fromCharCode(b[j]!))
  if (b[i] === 39) { // a quoted string; '' is an escaped quote
    let j = i + 1
    while (j < b.length) {
      if (b[j] === 39) { if (b[j + 1] === 39) { j += 2; continue } return j + 1 }
      j++
    }
    return j
  }
  if (isWord(i)) { let j = i; while (j < b.length && isWord(j)) j++; return j }
  return i + 1
}
```

`packages/analyzer-postgres/src/locations.ts`:

```ts
import type { Location } from '@holdline/core'
import type { Migration } from './migrate.js'
import type { SqlParse } from './pgparse.js'
import { kindOf, type SqlNode } from './sql-ast.js'

export interface StatementLocations {
  tables: Map<string, Location> // 'schema.table' → latest CREATE TABLE
  policies: Map<string, Location> // 'schema.table#policy name' → latest CREATE POLICY
}

const relationKey = (rv: SqlNode) => `${rv.schemaname ?? 'public'}.${rv.relname}`

// Locations only: the schema itself always comes from the catalog. A file the parser rejects has no locations
// (applying it reports the error).
export function statementLocations(migrations: readonly Migration[], parse: SqlParse): StatementLocations {
  const out: StatementLocations = { tables: new Map(), policies: new Map() }
  for (const m of migrations) {
    let stmts
    try { stmts = parse(m.sql).stmts } catch { continue }
    const bytes = Buffer.from(m.sql)
    for (const s of stmts) {
      const k = kindOf(s.stmt)
      if (!k) continue
      const at = (): Location => ({ file: m.path, line: lineAt(bytes, s.stmt_location ?? 0) })
      if (k[0] === 'CreateStmt') out.tables.set(relationKey(k[1].relation), at())
      if (k[0] === 'CreatePolicyStmt') out.policies.set(`${relationKey(k[1].table)}#${k[1].policy_name}`, at())
    }
  }
  return out
}

// The 1-based line of the first token at or after a byte offset (skipping whitespace and comments).
function lineAt(bytes: Buffer, offset: number): number {
  let i = offset
  for (;;) {
    while (i < bytes.length && (bytes[i] === 32 || (bytes[i]! >= 9 && bytes[i]! <= 13))) i++
    if (bytes[i] === 45 && bytes[i + 1] === 45) { while (i < bytes.length && bytes[i] !== 10) i++; continue }
    if (bytes[i] === 47 && bytes[i + 1] === 42) { const end = bytes.indexOf('*/', i + 2); i = end < 0 ? bytes.length : end + 2; continue }
    break
  }
  return bytes.subarray(0, i).toString().split('\n').length
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm vitest run packages/analyzer-postgres/test/sql-ast.test.ts packages/analyzer-postgres/test/locations.test.ts && pnpm typecheck`
Expected: PASS. If `import('libpg-query')` types don't expose `loadModule`/`parseSync`, read `node_modules/libpg-query/wasm/index.d.ts` and adapt the import, keeping it dynamic.

- [ ] **Step 5: Commit**

```bash
git add packages/analyzer-postgres
git commit -m "feat(analyzer-postgres): parse SQL lazily and locate tables and policies"
```

---

### Task 5: Normalize policy expressions (operands, comparisons, boolean structure)

**Files:**
- Create: `packages/analyzer-postgres/src/scope.ts`, `packages/analyzer-postgres/src/operand.ts`, `packages/analyzer-postgres/src/normalize.ts`, `packages/analyzer-postgres/src/catalog.ts` (types only in this task; `readCatalog` lands in Task 7)
- Test: `packages/analyzer-postgres/test/normalize.test.ts`

**Interfaces:**
- Consumes: `SqlNode`, `kindOf`, `nameList`, `constant`, `bareSelectTarget`, `nodeText`, `SqlParse`, `loadSqlParser` (Task 4); `Expr`, `Operand`, `Atom` from core.
- Produces:
  - `catalog.ts`: `interface SqlFunction { schema: string; name: string; argNames: string[]; language: string; volatility: string; body: string }`, `interface CatalogIndex { relations: Map<string, Set<string>>; functions: Map<string, SqlFunction> }` (relations: `'schema.table'` → column names, every non-system table, shim schemas included; functions keyed `'schema.name/nargs'`).
  - `scope.ts`: `type Side = 'resource' | 'incoming'`, `type Resolved = { operand: Operand } | { inner: string } | { blocked: true }`, `interface Scope { column(fields: string[]): Resolved | undefined; param(n: number): Operand | undefined }`, `tableScope(table, columns, side)`, `functionScope(names, args)`, `subqueryScope(table, alias, columns, parent)`.
  - `normalize.ts`: `interface NormalizeEnv { source: string; scope: Scope; catalog: CatalogIndex; parse: SqlParse; supabase: boolean; depth: number; functions: Set<string> }`, `toExpr(node: SqlNode, env: NormalizeEnv): Expr`, `interface Normalized { expr: Expr; functions: string[] }`, `normalizeCondition(sql: string, ctx: { table: string; side: Side; catalog: CatalogIndex; parse: SqlParse; supabase: boolean }): Normalized`.
  - `operand.ts`: `operand(node: SqlNode | undefined, env: NormalizeEnv): Operand | undefined`.

Mapping in this task (spec 3.3 table; subqueries and functions are Task 6, and until then `SubLink` EXISTS/ANY and `FuncCall` in boolean position are `opaque`):

| SQL | Expr |
|---|---|
| `auth.uid()`, `(select auth.uid())`, `auth.uid()::text` (dialect supabase) | `actor.uid` |
| `auth.jwt() ->> 'k'`, `(auth.jwt() -> 'a') ->> 'k'` | `actor.claim.k`, `actor.claim.a.k` |
| `auth.role()` | `actor.role` |
| column of the policy's table (`c`, `t.c`, `s.t.c`) | `resource.c` (side `incoming`: `incoming.c`) |
| constants (casts applied by `constant`) | `{ literal }` |
| `=`, `<>`, `<`, `>` | `eq`, `ne`, `lt`, `gt` (`<=`, `>=` and others: opaque) |
| `a = ANY (ARRAY[...])`, `a IN (...)` with constant string/number items | `in` with an array literal |
| `auth.uid() IS NOT NULL` / `IS NULL` | `authenticated` / `not(authenticated)` |
| `c IS NULL` / `IS NOT NULL` on a non-actor operand | `isNull` / `not(isNull)` (on another actor operand: opaque) |
| `AND`, `OR`, `NOT`, `true`, `false` | `and`, `or`, `not`, `{ and: [] }`, `{ or: [] }` |
| `auth.role() = 'anon'` (or the `role` claim) | `not(authenticated)`; any other comparison of the role with `'anon'`: opaque |
| anything else | `{ opaque: <source text> }` |

Why the special cases: the facts' actor model has no anonymous role (an anonymous caller is "no actor", and every actor atom is false for it), so `auth.uid() IS NULL` must become `not(authenticated)`, not `isNull(actor.uid)`.

- [ ] **Step 1: Write the failing test**

`packages/analyzer-postgres/test/normalize.test.ts`:

```ts
import { beforeAll, describe, expect, it } from 'vitest'
import type { CatalogIndex } from '../src/catalog.js'
import { normalizeCondition } from '../src/normalize.js'
import { loadSqlParser, type SqlParse } from '../src/pgparse.js'
import type { Side } from '../src/scope.js'

let parse: SqlParse
beforeAll(async () => { parse = await loadSqlParser() })

const catalog: CatalogIndex = {
  relations: new Map([
    ['public.projects', new Set(['id', 'org_id', 'owner_id', 'status', 'n', 'deleted_at'])],
    ['public.memberships', new Set(['org_id', 'user_id', 'role'])],
    ['auth.users', new Set(['id', 'email'])],
  ]),
  functions: new Map(),
}

const norm = (sql: string, side: Side = 'resource', supabase = true) =>
  normalizeCondition(sql, { table: 'public.projects', side, catalog, parse, supabase }).expr
const atom = (a: object) => ({ atom: a })
const AUTH = atom({ op: 'authenticated' })

describe('normalizeCondition: operands', () => {
  it('maps auth functions and claims', () => {
    expect(norm('(owner_id = auth.uid())')).toEqual(atom({ op: 'eq', left: 'resource.owner_id', right: 'actor.uid' }))
    expect(norm('(( SELECT auth.uid() AS uid) = owner_id)')).toEqual(atom({ op: 'eq', left: 'actor.uid', right: 'resource.owner_id' }))
    expect(norm("((auth.uid())::text = 'x'::text)")).toEqual(atom({ op: 'eq', left: 'actor.uid', right: { literal: 'x' } }))
    expect(norm("((auth.jwt() ->> 'user_role'::text) = 'admin'::text)"))
      .toEqual(atom({ op: 'eq', left: 'actor.claim.user_role', right: { literal: 'admin' } }))
    expect(norm("(((auth.jwt() -> 'app_metadata'::text) ->> 'tier'::text) = 'gold'::text)"))
      .toEqual(atom({ op: 'eq', left: 'actor.claim.app_metadata.tier', right: { literal: 'gold' } }))
    expect(norm("(auth.role() = 'authenticated'::text)")).toEqual(atom({ op: 'eq', left: 'actor.role', right: { literal: 'authenticated' } }))
  })
  it('maps the policy table columns to the stored or incoming record', () => {
    expect(norm("(projects.status = 'a'::text)")).toEqual(atom({ op: 'eq', left: 'resource.status', right: { literal: 'a' } }))
    expect(norm("(public.projects.status = 'a'::text)", 'incoming')).toEqual(atom({ op: 'eq', left: 'incoming.status', right: { literal: 'a' } }))
  })
  it('leaves auth functions alone for the plain dialect', () => {
    expect(norm('(owner_id = auth.uid())', 'resource', false)).toEqual({ opaque: 'owner_id = auth.uid()' })
  })
  it('makes unknown columns, other casts and other functions opaque', () => {
    expect(norm("(nosuch = 'a'::text)")).toEqual({ opaque: "nosuch = 'a'::text" })
    expect(norm("((owner_id)::text = 'a'::text)")).toEqual({ opaque: "(owner_id)::text = 'a'::text" })
    expect(norm("(lower(status) = 'a'::text)")).toEqual({ opaque: "lower(status) = 'a'::text" })
  })
})

describe('normalizeCondition: comparisons and structure', () => {
  it('maps =, <>, <, > and leaves other operators opaque', () => {
    expect(norm("(status <> 'a'::text)")).toEqual(atom({ op: 'ne', left: 'resource.status', right: { literal: 'a' } }))
    expect(norm('(n < 3)')).toEqual(atom({ op: 'lt', left: 'resource.n', right: { literal: 3 } }))
    expect(norm('(n > 3)')).toEqual(atom({ op: 'gt', left: 'resource.n', right: { literal: 3 } }))
    expect(norm('(n >= 3)')).toEqual({ opaque: 'n >= 3' })
  })
  it('maps IN lists and = ANY (ARRAY[...]) to in', () => {
    const want = atom({ op: 'in', left: 'resource.status', right: { literal: ['a', 'b'] } })
    expect(norm("(status = ANY (ARRAY['a'::text, 'b'::text]))")).toEqual(want)
    expect(norm("status IN ('a', 'b')")).toEqual(want)
    expect(norm("status NOT IN ('a', 'b')")).toEqual({ opaque: "status NOT IN ('a', 'b')" })
    expect(norm('(status = ANY (ARRAY[owner_id]))')).toEqual({ opaque: 'status = ANY (ARRAY[owner_id])' })
  })
  it('maps null tests, with auth.uid() as sign-in', () => {
    expect(norm('(deleted_at IS NULL)')).toEqual(atom({ op: 'isNull', operand: 'resource.deleted_at' }))
    expect(norm('(deleted_at IS NOT NULL)')).toEqual({ not: atom({ op: 'isNull', operand: 'resource.deleted_at' }) })
    expect(norm('(auth.uid() IS NOT NULL)')).toEqual(AUTH)
    expect(norm('(auth.uid() IS NULL)')).toEqual({ not: AUTH })
    expect(norm("((auth.jwt() ->> 'k'::text) IS NULL)")).toHaveProperty('opaque')
  })
  it('maps AND, OR, NOT, true and false', () => {
    expect(norm("((status = 'a'::text) AND (NOT (n < 3)))")).toEqual({ and: [
      atom({ op: 'eq', left: 'resource.status', right: { literal: 'a' } }),
      { not: atom({ op: 'lt', left: 'resource.n', right: { literal: 3 } }) },
    ] })
    expect(norm("((status = 'a'::text) OR (n > 3))").or).toHaveLength(2)
    expect(norm('true')).toEqual({ and: [] })
    expect(norm('false')).toEqual({ or: [] })
  })
  it('treats the anon role as not signed in', () => {
    expect(norm("(auth.role() = 'anon'::text)")).toEqual({ not: AUTH })
    expect(norm("((auth.jwt() ->> 'role'::text) = 'anon'::text)")).toEqual({ not: AUTH })
    expect(norm("(auth.role() <> 'anon'::text)")).toEqual({ opaque: "auth.role() <> 'anon'::text" })
  })
  it('makes subqueries and helper calls opaque until they are supported', () => {
    expect(norm('is_member(org_id)')).toEqual({ opaque: 'is_member(org_id)' })
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/analyzer-postgres/test/normalize.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`packages/analyzer-postgres/src/catalog.ts` (types now; `readCatalog` is added in Task 7):

```ts
export interface SqlFunction {
  schema: string
  name: string
  argNames: string[]
  language: string // pg_language.lanname
  volatility: string // pg_proc.provolatile: i, s or v
  body: string // pg_proc.prosrc
}

// What the normalizer needs to know about the database.
export interface CatalogIndex {
  relations: Map<string, Set<string>> // 'schema.table' → column names, for every non-system table
  functions: Map<string, SqlFunction> // 'schema.name/nargs'
}
```

`packages/analyzer-postgres/src/scope.ts`:

```ts
import type { Operand } from '@holdline/core'

export type Side = 'resource' | 'incoming'

// What a column reference means where it appears: an operand, a column of the innermost subquery's
// table, or blocked (a column the normalizer can't express, such as one of an enclosing subquery's table).
export type Resolved = { operand: Operand } | { inner: string } | { blocked: true }

export interface Scope {
  column(fields: string[]): Resolved | undefined
  param(n: number): Operand | undefined
}

const split = (table: string) => table.split('.') as [string, string]

// The policy's table: in USING its columns are the stored record, in WITH CHECK the incoming row.
export function tableScope(table: string, columns: ReadonlySet<string>, side: Side): Scope {
  const [schema, name] = split(table)
  return {
    column(fields) {
      const col = fields.at(-1)!
      const q = fields.slice(0, -1)
      const ours = q.length === 0 || (q.length === 1 && q[0] === name) || (q.length === 2 && q[0] === schema && q[1] === name)
      return ours && columns.has(col) ? { operand: `${side}.${col}` } : undefined
    },
    param: () => undefined,
  }
}

// A SQL function body: parameters by name or position ($1), bound to the caller's operands.
// The policy's table is not in scope inside a function.
export function functionScope(names: readonly string[], args: readonly Operand[]): Scope {
  return {
    column(fields) {
      const i = fields.length === 1 ? names.indexOf(fields[0]!) : -1
      return i >= 0 && i < args.length ? { operand: args[i]! } : undefined
    },
    param: n => args[n - 1],
  }
}

// A subquery over one table. Its own columns win over outer ones, as in SQL.
export function subqueryScope(table: string, alias: string, columns: ReadonlySet<string>, parent: Scope): Scope {
  const [schema, name] = split(table)
  return {
    column(fields) {
      const col = fields.at(-1)!
      const q = fields.slice(0, -1)
      const ours = q.length === 0 ? columns.has(col)
        : (q.length === 1 && q[0] === alias) || (q.length === 2 && alias === name && q[0] === schema && q[1] === name)
      if (ours) return columns.has(col) ? { inner: col } : { blocked: true }
      const outer = parent.column(fields)
      return outer && 'inner' in outer ? { blocked: true } : outer
    },
    param: n => parent.param(n),
  }
}
```

`packages/analyzer-postgres/src/operand.ts`:

```ts
import type { Operand } from '@holdline/core'
import type { NormalizeEnv } from './normalize.js'
import { bareSelectTarget, constant, kindOf, nameList, type SqlNode } from './sql-ast.js'

const CLAIM_KEY = /^[A-Za-z0-9_]+$/

// A SQL value as an operand: a constant, a column (through the scope), a parameter, or a Supabase auth value.
export function operand(node: SqlNode | undefined, env: NormalizeEnv): Operand | undefined {
  const c = constant(node)
  if (c) return { literal: c.value }
  const k = kindOf(node)
  if (!k) return undefined
  const [kind, f] = k
  switch (kind) {
    case 'ColumnRef': {
      const fields = nameList(f.fields)
      if (fields.includes('')) return undefined
      const r = env.scope.column(fields)
      return r && 'operand' in r ? r.operand : undefined
    }
    case 'ParamRef': return env.scope.param(f.number as number)
    case 'SubLink': {
      const inner = f.subLinkType === 'EXPR_SUBLINK' ? bareSelectTarget(f.subselect) : undefined
      return inner ? operand(inner, env) : undefined
    }
    case 'FuncCall': return env.supabase ? authValue(f) : undefined
    case 'A_Expr': return env.supabase ? claim(f) : undefined
    case 'TypeCast': {
      // `auth.uid()::text`: the text form of a uuid is the uid itself. Other casts change values.
      const inner = operand(f.arg, env)
      const type = nameList(f.typeName?.names).at(-1)
      return type === 'text' && typeof inner === 'string' && (inner === 'actor.uid' || inner.startsWith('actor.claim.')) ? inner : undefined
    }
    default: return undefined
  }
}

function authValue(f: SqlNode): string | undefined {
  if ((f.args as unknown[] | undefined)?.length) return undefined
  const name = nameList(f.funcname).join('.')
  return name === 'auth.uid' ? 'actor.uid' : name === 'auth.role' ? 'actor.role' : undefined
}

// `auth.jwt() ->> 'k'` and `(auth.jwt() -> 'a') ->> 'k'`.
function claim(f: SqlNode): string | undefined {
  if (f.kind !== 'AEXPR_OP' || nameList(f.name).join() !== '->>') return undefined
  const path = jwtPath(f.lexpr)
  const key = constant(f.rexpr)?.value
  return path && typeof key === 'string' && CLAIM_KEY.test(key) ? `actor.claim.${[...path, key].join('.')}` : undefined
}

function jwtPath(node: SqlNode | undefined): string[] | undefined {
  const k = kindOf(node)
  if (!k) return undefined
  const [kind, f] = k
  if (kind === 'FuncCall') return !(f.args as unknown[] | undefined)?.length && nameList(f.funcname).join('.') === 'auth.jwt' ? [] : undefined
  if (kind === 'SubLink' && f.subLinkType === 'EXPR_SUBLINK') return jwtPath(bareSelectTarget(f.subselect))
  if (kind === 'A_Expr' && f.kind === 'AEXPR_OP' && nameList(f.name).join() === '->') {
    const path = jwtPath(f.lexpr)
    const key = constant(f.rexpr)?.value
    return path && typeof key === 'string' && CLAIM_KEY.test(key) ? [...path, key] : undefined
  }
  return undefined
}
```

`packages/analyzer-postgres/src/normalize.ts` (Task 6 replaces the two `opaque()` placeholders marked below):

```ts
import type { Atom, Expr, Operand } from '@holdline/core'
import type { CatalogIndex } from './catalog.js'
import { operand } from './operand.js'
import type { SqlParse } from './pgparse.js'
import { tableScope, type Scope, type Side } from './scope.js'
import { bareSelectTarget, constant, kindOf, nameList, nodeText, type SqlNode } from './sql-ast.js'

export interface NormalizeEnv {
  source: string // the text the nodes were parsed from, for opaque conditions
  scope: Scope
  catalog: CatalogIndex
  parse: SqlParse
  supabase: boolean // auth.uid(), auth.jwt() and auth.role() are Supabase's
  depth: number // helper function inlining depth
  functions: Set<string> // helper functions inlined so far, 'schema.name'
}

export interface Normalized { expr: Expr; functions: string[] }

const COMPARISON: Record<string, 'eq' | 'ne' | 'lt' | 'gt'> = { '=': 'eq', '<>': 'ne', '<': 'lt', '>': 'gt' }
const SIGNED_IN: Expr = { atom: { op: 'authenticated' } }

// A policy expression as pg_get_expr prints it, for the policy's table and side.
export function normalizeCondition(
  sql: string,
  ctx: { table: string; side: Side; catalog: CatalogIndex; parse: SqlParse; supabase: boolean },
): Normalized {
  const source = `SELECT ${sql}`
  let node: SqlNode | undefined
  try { node = bareSelectTarget(ctx.parse(source).stmts[0]?.stmt) } catch { node = undefined }
  if (!node) return { expr: { opaque: sql }, functions: [] }
  const functions = new Set<string>()
  const scope = tableScope(ctx.table, ctx.catalog.relations.get(ctx.table) ?? new Set(), ctx.side)
  const expr = toExpr(node, { source, scope, catalog: ctx.catalog, parse: ctx.parse, supabase: ctx.supabase, depth: 0, functions })
  return { expr, functions: [...functions].sort() }
}

export function toExpr(node: SqlNode, env: NormalizeEnv): Expr {
  const opaque = (): Expr => ({ opaque: nodeText(env.source, node) })
  const k = kindOf(node)
  if (!k) return opaque()
  const [kind, f] = k
  switch (kind) {
    case 'BoolExpr': {
      const args = (f.args as SqlNode[]).map(a => toExpr(a, env))
      return f.boolop === 'AND_EXPR' ? { and: args } : f.boolop === 'OR_EXPR' ? { or: args } : { not: args[0]! }
    }
    case 'A_Const': {
      const c = constant(node)?.value
      return c === true ? { and: [] } : c === false ? { or: [] } : opaque()
    }
    case 'A_Expr': return comparison(f, env) ?? opaque()
    case 'NullTest': return nullTest(f, env) ?? opaque()
    case 'SubLink': {
      if (f.subLinkType === 'EXPR_SUBLINK') {
        const inner = bareSelectTarget(f.subselect)
        return inner ? toExpr(inner, env) : opaque()
      }
      return opaque() // Task 6: EXISTS and IN subqueries
    }
    case 'FuncCall': return opaque() // Task 6: helper function inlining
    default: return opaque()
  }
}

function comparison(f: SqlNode, env: NormalizeEnv): Expr | undefined {
  const name = nameList(f.name)
  if (name.length !== 1) return undefined
  const op = name[0]!
  if (f.kind === 'AEXPR_OP' && op in COMPARISON) {
    const left = operand(f.lexpr, env)
    const right = operand(f.rexpr, env)
    return left === undefined || right === undefined ? undefined : atomExpr({ op: COMPARISON[op]!, left, right })
  }
  const items: SqlNode[] | undefined = op !== '=' ? undefined
    : f.kind === 'AEXPR_OP_ANY' ? arrayItems(f.rexpr)
    : f.kind === 'AEXPR_IN' ? (f.rexpr?.List?.items as SqlNode[] | undefined) : undefined
  if (!items) return undefined
  const left = operand(f.lexpr, env)
  const values = items.map(i => constant(i)?.value)
  if (left === undefined || values.some(v => typeof v !== 'string' && typeof v !== 'number')) return undefined
  return atomExpr({ op: 'in', left, right: { literal: values as (string | number)[] } })
}

function arrayItems(node: SqlNode | undefined): SqlNode[] | undefined {
  const k = kindOf(node)
  if (k?.[0] === 'TypeCast') return arrayItems(k[1].arg)
  return k?.[0] === 'A_ArrayExpr' ? ((k[1].elements as SqlNode[] | undefined) ?? []) : undefined
}

// The facts' actor model has no anonymous role: an anonymous caller is "no actor".
function atomExpr(a: Extract<Atom, { left: Operand }>): Expr | undefined {
  const sides = [a.left, a.right]
  const role = sides.some(o => o === 'actor.role' || o === 'actor.claim.role')
  const anon = sides.some(o => typeof o === 'object' && o !== null && 'literal' in o
    && (o.literal === 'anon' || (Array.isArray(o.literal) && o.literal.includes('anon'))))
  if (role && anon) return a.op === 'eq' ? { not: SIGNED_IN } : undefined
  return { atom: a }
}

function nullTest(f: SqlNode, env: NormalizeEnv): Expr | undefined {
  const o = operand(f.arg, env)
  if (typeof o !== 'string') return undefined
  const isNull = f.nulltesttype === 'IS_NULL'
  if (o === 'actor.uid') return isNull ? { not: SIGNED_IN } : SIGNED_IN
  if (o.startsWith('actor.')) return undefined
  const atom: Expr = { atom: { op: 'isNull', operand: o } }
  return isNull ? atom : { not: atom }
}
```

Note: `SIGNED_IN` is shared; callers never mutate `Expr` values.

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm vitest run packages/analyzer-postgres/test/normalize.test.ts && pnpm typecheck`
Expected: PASS. If an expected opaque text differs only in whitespace or parentheses from what `nodeText` produces, fix `nodeText` rather than the test when the text is wrong; adjust the test only when both are reasonable renderings.

- [ ] **Step 5: Commit**

```bash
git add packages/analyzer-postgres
git commit -m "feat(analyzer-postgres): normalize policy comparisons and boolean structure"
```

---

### Task 6: Subqueries and helper function inlining

**Files:**
- Create: `packages/analyzer-postgres/src/subquery.ts`, `packages/analyzer-postgres/src/inline.ts`
- Modify: `packages/analyzer-postgres/src/normalize.ts` (the two Task 6 placeholders)
- Test: `packages/analyzer-postgres/test/subquery.test.ts`

**Interfaces:**
- Consumes: Task 5's `NormalizeEnv`, `toExpr`, `operand`, scopes, `CatalogIndex`, `SqlFunction`.
- Produces: `existsSubquery(select: SqlNode, env: NormalizeEnv): Expr | undefined`, `inSubquery(sublink: SqlNode, env: NormalizeEnv): Expr | undefined`, `inlineCall(call: SqlNode, env: NormalizeEnv): Expr | undefined` (undefined → the caller emits `opaque`).

Rules:
- `EXISTS (SELECT … FROM t [alias] WHERE <conjuncts>)`: exactly one `FROM` item, a plain table known to the catalog (no joins, `GROUP BY`, `HAVING`, `DISTINCT`, `LIMIT`, `WITH` or set operations); every conjunct is `inner_column = <outer operand>` (either order) where the operand is a string operand (no literals: `exists` placeholders must be operands); at least one conjunct. Result `exists(pg:<schema>.t?<col>={<operand>}&…)` with columns sorted by name (the canonical form). A column bound to two different operands is opaque.
- `<x> IN (SELECT t.a FROM t WHERE …)` (`ANY_SUBLINK`, operator `=`): the same, plus `a={x}`; the subquery has exactly one target, an inner column.
- Unqualified table names in subqueries are `public` (pg_get_expr omits the schema only for tables on the search path).
- A subquery reads `t` as the caller, so under RLS on `t` it may see fewer rows than `exists` assumes. That only makes the `Expr` weaker, which is sound.
- A call `f(args)` is inlined when `f` (unqualified means `public`) is in the catalog with that many arguments, `LANGUAGE sql`, `STABLE` or `IMMUTABLE`, its body is exactly one `SELECT <expr>` (`bareSelectTarget`), every argument maps to an operand, and the depth is below 10. The body is normalized in a `functionScope` (parameters by name and `$n`), and `schema.name` is added to `env.functions`.

- [ ] **Step 1: Write the failing test**

`packages/analyzer-postgres/test/subquery.test.ts`:

```ts
import { beforeAll, describe, expect, it } from 'vitest'
import type { CatalogIndex, SqlFunction } from '../src/catalog.js'
import { normalizeCondition } from '../src/normalize.js'
import { loadSqlParser, type SqlParse } from '../src/pgparse.js'
import type { Side } from '../src/scope.js'

let parse: SqlParse
beforeAll(async () => { parse = await loadSqlParser() })

const fn = (name: string, argNames: string[], body: string, over: Partial<SqlFunction> = {}): [string, SqlFunction] =>
  [`public.${name}/${argNames.length}`, { schema: 'public', name, argNames, language: 'sql', volatility: 's', body, ...over }]

const catalog: CatalogIndex = {
  relations: new Map([
    ['public.projects', new Set(['id', 'org_id', 'owner_id', 'status'])],
    ['public.memberships', new Set(['org_id', 'user_id', 'role'])],
  ]),
  functions: new Map([
    fn('is_member', ['o'], ' select exists (select 1 from public.memberships m where m.org_id = o and m.user_id = (select auth.uid())) '),
    // one unnamed argument, read as $1
    ['public.is_member_pos/1', { schema: 'public', name: 'is_member_pos', argNames: [], language: 'sql', volatility: 's',
      body: ' select exists (select 1 from memberships where org_id = $1 and user_id = auth.uid()) ' }],
    fn('is_owner', ['p'], ' select p = auth.uid() '),
    fn('calls_member', ['o'], ' select public.is_member(o) '),
    fn('volatile_member', ['o'], ' select true ', { volatility: 'v' }),
    fn('plpgsql_member', ['o'], ' begin return true; end ', { language: 'plpgsql' }),
    fn('two_statements', ['o'], ' select 1; select true '),
    fn('loop', ['o'], ' select public.loop(o) '),
  ]),
}

const run = (sql: string, side: Side = 'resource') => normalizeCondition(sql, { table: 'public.projects', side, catalog, parse, supabase: true })
const norm = (sql: string, side: Side = 'resource') => run(sql, side).expr
const exists = (doc: string) => ({ atom: { op: 'exists', doc } })
const MEMBER = exists('pg:public.memberships?org_id={resource.org_id}&user_id={actor.uid}')

describe('EXISTS subqueries', () => {
  it('maps equality conjuncts to a canonical exists doc', () => {
    expect(norm('(EXISTS ( SELECT 1 FROM memberships m WHERE ((m.user_id = auth.uid()) AND (m.org_id = projects.org_id))))')).toEqual(MEMBER)
    expect(norm('(EXISTS ( SELECT 1 FROM memberships WHERE ((projects.org_id = memberships.org_id) AND (memberships.user_id = auth.uid()))))')).toEqual(MEMBER)
    expect(norm('(EXISTS ( SELECT 1 FROM memberships m WHERE ((m.org_id = projects.org_id) AND (m.user_id = auth.uid()))))', 'incoming'))
      .toEqual(exists('pg:public.memberships?org_id={incoming.org_id}&user_id={actor.uid}'))
  })
  it('resolves an unqualified column to the subquery table first, as SQL does', () => {
    // org_id exists in both tables: inside the subquery it is memberships.org_id, so this compares two inner columns.
    expect(norm('(EXISTS ( SELECT 1 FROM memberships WHERE (org_id = owner_id)))')).toEqual(exists('pg:public.memberships?org_id={resource.owner_id}'))
    expect(norm('(EXISTS ( SELECT 1 FROM memberships WHERE (org_id = user_id)))')).toHaveProperty('opaque')
  })
  it('is opaque for anything but equality conjuncts with operands', () => {
    for (const sql of [
      "(EXISTS ( SELECT 1 FROM memberships m WHERE ((m.org_id = projects.org_id) AND (m.role = 'admin'::text))))",
      '(EXISTS ( SELECT 1 FROM memberships m WHERE ((m.org_id = projects.org_id) OR (m.user_id = auth.uid()))))',
      '(EXISTS ( SELECT 1 FROM memberships m))',
      '(EXISTS ( SELECT 1 FROM memberships m, projects p WHERE (m.org_id = p.org_id)))',
      '(EXISTS ( SELECT 1 FROM nosuch n WHERE (n.org_id = projects.org_id)))',
      '(EXISTS ( SELECT 1 FROM memberships m WHERE ((m.org_id = projects.org_id) AND (m.org_id = projects.owner_id))))',
    ]) expect(norm(sql), sql).toHaveProperty('opaque')
  })
  it('keeps NOT EXISTS as not(exists)', () => {
    expect(norm('(NOT (EXISTS ( SELECT 1 FROM memberships m WHERE ((m.org_id = projects.org_id) AND (m.user_id = auth.uid())))))')).toEqual({ not: MEMBER })
  })
})

describe('IN subqueries', () => {
  it('maps x IN (SELECT t.a FROM t WHERE …) to exists with a={x}', () => {
    expect(norm('(org_id IN ( SELECT memberships.org_id FROM memberships WHERE (memberships.user_id = auth.uid())))')).toEqual(MEMBER)
    expect(norm('(org_id IN ( SELECT m.org_id FROM memberships m WHERE (m.user_id = ( SELECT auth.uid() AS uid))))')).toEqual(MEMBER)
  })
  it('is opaque with a non-column target or a filter it cannot express', () => {
    expect(norm('(org_id IN ( SELECT lower(m.role) FROM memberships m WHERE (m.user_id = auth.uid())))')).toHaveProperty('opaque')
    expect(norm("(org_id IN ( SELECT m.org_id FROM memberships m WHERE ((m.user_id = auth.uid()) AND (m.role = ANY (ARRAY['admin'::text])))))")).toHaveProperty('opaque')
  })
})

describe('helper functions', () => {
  it('inlines a stable SQL function by parameter name and records it', () => {
    expect(run('is_member(org_id)')).toEqual({ expr: MEMBER, functions: ['public.is_member'] })
    expect(norm('public.is_member(org_id)', 'incoming')).toEqual(exists('pg:public.memberships?org_id={incoming.org_id}&user_id={actor.uid}'))
  })
  it('inlines by position and through nested calls', () => {
    expect(norm('is_member_pos(org_id)')).toEqual(MEMBER)
    expect(run('calls_member(org_id)')).toEqual({ expr: MEMBER, functions: ['public.calls_member', 'public.is_member'] })
    expect(norm('is_owner(owner_id)')).toEqual({ atom: { op: 'eq', left: 'resource.owner_id', right: 'actor.uid' } })
  })
  it('does not inline volatile, non-SQL, multi-statement, unknown or runaway functions', () => {
    for (const sql of ['volatile_member(org_id)', 'plpgsql_member(org_id)', 'two_statements(org_id)', 'nosuch(org_id)', 'loop(org_id)', 'is_member(lower(status))']) {
      expect(norm(sql), sql).toHaveProperty('opaque')
    }
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/analyzer-postgres/test/subquery.test.ts`
Expected: FAIL (modules not found, then opaque results).

- [ ] **Step 3: Implement**

`packages/analyzer-postgres/src/subquery.ts`:

```ts
import type { Expr } from '@holdline/core'
import type { NormalizeEnv } from './normalize.js'
import { operand } from './operand.js'
import { subqueryScope, type Scope } from './scope.js'
import { kindOf, nameList, type SqlNode } from './sql-ast.js'

interface Query { table: string; scope: Scope; select: SqlNode; conditions: [string, string][] }

// EXISTS (SELECT … FROM t WHERE t.a = <x> AND t.b = <y>) → exists(pg:<schema>.t?a={x}&b={y}).
export function existsSubquery(select: SqlNode, env: NormalizeEnv): Expr | undefined {
  const q = singleTableQuery(select, env)
  return q && existsAtom(q.table, q.conditions)
}

// <x> IN (SELECT t.a FROM t WHERE …) → the same exists with a={x}.
export function inSubquery(sublink: SqlNode, env: NormalizeEnv): Expr | undefined {
  const op = nameList(sublink.operName)
  if (op.length > 1 || (op.length === 1 && op[0] !== '=')) return undefined
  const left = operand(sublink.testexpr, env)
  const q = singleTableQuery(sublink.subselect, env)
  if (typeof left !== 'string' || !q) return undefined
  const targets = (q.select.targetList as SqlNode[] | undefined) ?? []
  const col = targets.length === 1 ? innerColumn(targets[0]!.ResTarget?.val, q.scope) : undefined
  return col === undefined ? undefined : existsAtom(q.table, [...q.conditions, [col, left]])
}

function singleTableQuery(select: SqlNode | undefined, env: NormalizeEnv): Query | undefined {
  const s = select?.SelectStmt as SqlNode | undefined
  if (!s || s.groupClause || s.havingClause || s.withClause || s.distinctClause || s.limitCount || s.limitOffset
    || (s.op && s.op !== 'SETOP_NONE')) return undefined
  const from = s.fromClause as SqlNode[] | undefined
  const rv = from?.length === 1 ? (from[0]!.RangeVar as SqlNode | undefined) : undefined
  if (!rv) return undefined
  const table = `${rv.schemaname ?? 'public'}.${rv.relname}`
  const columns = env.catalog.relations.get(table)
  if (!columns) return undefined
  const scope = subqueryScope(table, rv.alias?.aliasname ?? rv.relname, columns, env.scope)
  const conditions: [string, string][] = []
  for (const c of conjuncts(s.whereClause)) {
    const pair = equality(c, { ...env, scope })
    if (!pair) return undefined
    conditions.push(pair)
  }
  return { table, scope, select: s, conditions }
}

function conjuncts(where: SqlNode | undefined): SqlNode[] {
  if (!where) return []
  const k = kindOf(where)
  return k?.[0] === 'BoolExpr' && k[1].boolop === 'AND_EXPR' ? (k[1].args as SqlNode[]).flatMap(conjuncts) : [where]
}

// `inner_column = outer_operand`, in either order.
function equality(node: SqlNode, env: NormalizeEnv): [string, string] | undefined {
  const k = kindOf(node)
  if (k?.[0] !== 'A_Expr' || k[1].kind !== 'AEXPR_OP' || nameList(k[1].name).join() !== '=') return undefined
  const { lexpr, rexpr } = k[1]
  for (const [a, b] of [[lexpr, rexpr], [rexpr, lexpr]] as const) {
    const col = innerColumn(a, env.scope)
    if (col === undefined) continue
    if (innerColumn(b, env.scope) !== undefined) return undefined
    const o = operand(b, env)
    return typeof o === 'string' ? [col, o] : undefined
  }
  return undefined
}

function innerColumn(node: SqlNode | undefined, scope: Scope): string | undefined {
  const k = kindOf(node)
  if (k?.[0] !== 'ColumnRef') return undefined
  const r = scope.column(nameList(k[1].fields))
  return r && 'inner' in r ? r.inner : undefined
}

// Columns sorted by name: two exists atoms match only when their docs are string-equal.
function existsAtom(table: string, conditions: [string, string][]): Expr | undefined {
  if (conditions.length === 0) return undefined
  const byColumn = new Map<string, string>()
  for (const [col, o] of conditions) {
    if (byColumn.has(col) && byColumn.get(col) !== o) return undefined
    byColumn.set(col, o)
  }
  const query = [...byColumn].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([c, o]) => `${c}={${o}}`).join('&')
  return { atom: { op: 'exists', doc: `pg:${table}?${query}` } }
}
```

`packages/analyzer-postgres/src/inline.ts`:

```ts
import type { Expr, Operand } from '@holdline/core'
import { toExpr, type NormalizeEnv } from './normalize.js'
import { operand } from './operand.js'
import { functionScope } from './scope.js'
import { bareSelectTarget, nameList, type SqlNode } from './sql-ast.js'

const MAX_DEPTH = 10

// A call to a SQL helper (LANGUAGE sql, STABLE or IMMUTABLE, body `SELECT <expr>`) is replaced by its body.
export function inlineCall(call: SqlNode, env: NormalizeEnv): Expr | undefined {
  const names = nameList(call.funcname)
  const key = names.length === 1 ? `public.${names[0]}` : names.length === 2 ? names.join('.') : undefined
  const args = (call.args as SqlNode[] | undefined) ?? []
  const fn = key === undefined ? undefined : env.catalog.functions.get(`${key}/${args.length}`)
  if (!fn || fn.language !== 'sql' || (fn.volatility !== 's' && fn.volatility !== 'i') || env.depth >= MAX_DEPTH) return undefined
  if (call.agg_star || call.agg_distinct || call.over || call.func_variadic || call.agg_filter) return undefined
  const operands = args.map(a => operand(a, env))
  if (operands.some(o => o === undefined)) return undefined
  let stmts
  try { stmts = env.parse(fn.body).stmts } catch { return undefined }
  const body = stmts.length === 1 ? bareSelectTarget(stmts[0]!.stmt) : undefined
  if (!body) return undefined
  env.functions.add(key!)
  return toExpr(body, { ...env, source: fn.body, scope: functionScope(fn.argNames, operands as Operand[]), depth: env.depth + 1 })
}
```

In `normalize.ts` add the imports and replace the placeholders:

```ts
import { inlineCall } from './inline.js'
import { existsSubquery, inSubquery } from './subquery.js'
```

```ts
      if (f.subLinkType === 'EXISTS_SUBLINK') return existsSubquery(f.subselect, env) ?? opaque()
      if (f.subLinkType === 'ANY_SUBLINK') return inSubquery(f, env) ?? opaque()
      return opaque()
    }
    case 'FuncCall': return inlineCall(f, env) ?? opaque()
```

`normalize.ts` ↔ `inline.ts` is an import cycle of functions only, called at run time; it is safe in ESM.

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm vitest run packages/analyzer-postgres/test && pnpm typecheck`
Expected: PASS. Task 5's `is_member(org_id)` test still expects opaque: its catalog has no functions.

- [ ] **Step 5: Commit**

```bash
git add packages/analyzer-postgres
git commit -m "feat(analyzer-postgres): map EXISTS and IN subqueries and inline SQL helpers"
```

---

### Task 7: Policies from the catalog (ops, restrictive, roles, sign-in)

**Files:**
- Create: `packages/analyzer-postgres/src/anon.ts`, `packages/analyzer-postgres/src/policies.ts`
- Modify: `packages/analyzer-postgres/src/catalog.ts` (add `PolicyRow`, `Catalog`, `readCatalog`)
- Test: `packages/analyzer-postgres/test/policies.test.ts`, `packages/analyzer-postgres/test/catalog.test.ts`

**Interfaces:**
- Consumes: `readTables`, `SYSTEM_SCHEMAS_SQL`, `sqlList` (Task 3); `normalizeCondition`, `Normalized`, `Side` (Task 5); `Dialect` (Task 1); core `Expr`, `Policy`, `Diagnostic`, `Location`, `Op`.
- Produces:
  - `catalog.ts`: `interface PolicyRow { schema: string; table: string; name: string; cmd: 'r' | 'a' | 'w' | 'd' | '*'; permissive: boolean; roles: string[]; using: string | null; check: string | null }` (`roles` holds `'public'` for PUBLIC), `interface Catalog extends CatalogIndex { tables: Table[]; policies: PolicyRow[] }`, `SHIM_SCHEMAS = ['auth', 'storage', 'extensions']`, `readCatalog(db: PGlite, dialect: Dialect): Promise<Catalog>` (tables and policies exclude shim schemas for `supabase`; relations and functions include them).
  - `anon.ts`: `forAnonymous(e: Expr): 'T' | 'F' | '?'`, `requireSignIn(e: Expr): Expr`.
  - `policies.ts`: `type ConditionOf = (sql: string, table: string, side: Side) => Normalized`, `buildPolicies(rows: readonly PolicyRow[], dialect: Dialect, condition: ConditionOf, location: (row: PolicyRow) => Location | undefined): { policies: Policy[]; diagnostics: Diagnostic[] }`.

Rules (record the role and sign-in rules in As built, they refine spec 3.3):
- Ops per `polcmd`: `r` → read, list (USING); `a` → create (WITH CHECK); `w` → update (USING AND WITH CHECK, WITH CHECK defaulting to USING); `d` → delete (USING); `*` → all five. A missing USING is `TRUE`; a missing WITH CHECK is the USING expression applied to the incoming row (side `incoming`), or `TRUE` when both are missing. One policy fact per row and op, id `pg:<schema>.<table>#policy:<name>`, target `<schema>.<table>`, store `pg-rls`.
- Roles. Dialect `supabase`: roles containing `public` or `authenticated` apply to every caller; roles containing `anon` (and neither of those) apply only to anonymous callers; anything else (only `service_role` or custom roles) is skipped with a warning diagnostic. Dialect `plain`: `public` applies to everyone; any other role list may be the caller's role.
- Permissive conditions: everyone → as is; anonymous only → `and[not(authenticated), c]`; plain custom role → as is (over-approximation). Restrictive conditions are ANDed into every permissive condition for the same table and op: everyone → `c`; anonymous only → `or[authenticated, c]`; skipped and plain custom roles → not applied (dropping a restriction only weakens).
- Sign-in: after combining, `requireSignIn` prepends `{ atom: { op: authenticated } }` when `forAnonymous(condition) === 'F'`. This replaces the spec's "when it references auth.uid() or auth.jwt()" with a check that is sound for `auth.uid() IS NULL` and `NOT (…)`: the normalized condition is certainly false for an anonymous caller, so the SQL can't allow one either. Claims that Supabase also sets for the anon key (`role`, `iss`, `ref`, `aud`, `iat`, `exp`) are not counted as false for anonymous callers.
- Warning text: `policy "<name>" on <schema>.<table> applies only to roles <r1, r2>; Holdline models the anon and authenticated roles, so it was skipped`, `file` = the policy's location file, or `''`.

- [ ] **Step 1: Write the failing tests**

`packages/analyzer-postgres/test/policies.test.ts`:

```ts
import type { Expr } from '@holdline/core'
import { describe, expect, it } from 'vitest'
import { forAnonymous, requireSignIn } from '../src/anon.js'
import type { PolicyRow } from '../src/catalog.js'
import { buildPolicies, type ConditionOf } from '../src/policies.js'

const AUTH: Expr = { atom: { op: 'authenticated' } }
const eq = (left: string, right: string): Expr => ({ atom: { op: 'eq', left, right } })
const OWNER = eq('resource.owner_id', 'actor.uid')

describe('forAnonymous and requireSignIn', () => {
  it('knows which conditions are false for an anonymous caller', () => {
    expect(forAnonymous(OWNER)).toBe('F')
    expect(forAnonymous({ atom: { op: 'exists', doc: 'pg:public.m?user_id={actor.uid}' } })).toBe('F')
    expect(forAnonymous({ not: OWNER })).toBe('T')
    expect(forAnonymous({ not: AUTH })).toBe('T')
    expect(forAnonymous({ and: [] })).toBe('T')
    expect(forAnonymous({ or: [OWNER, { opaque: 'x' }] })).toBe('?')
    expect(forAnonymous({ and: [OWNER, { opaque: 'x' }] })).toBe('F')
    expect(forAnonymous(eq('actor.claim.role', 'actor.uid'))).toBe('?')
    expect(forAnonymous({ atom: { op: 'isNull', operand: 'resource.deleted_at' } })).toBe('?')
  })
  it('adds authenticated only when the condition is false for anonymous callers', () => {
    expect(requireSignIn(OWNER)).toEqual({ and: [AUTH, OWNER] })
    expect(requireSignIn({ and: [OWNER, { atom: { op: 'isNull', operand: 'resource.d' } }] }))
      .toEqual({ and: [AUTH, OWNER, { atom: { op: 'isNull', operand: 'resource.d' } }] })
    expect(requireSignIn({ not: AUTH })).toEqual({ not: AUTH })
    expect(requireSignIn({ and: [] })).toEqual({ and: [] })
  })
})

// A fake normalizer: the SQL text names the Expr.
const EXPRS: Record<string, Expr> = { owner: OWNER, true: { and: [] }, live: { atom: { op: 'isNull', operand: 'resource.deleted_at' } } }
const condition: ConditionOf = (sql, _table, side) => {
  const e = EXPRS[sql]!
  return { expr: side === 'incoming' ? JSON.parse(JSON.stringify(e).replaceAll('resource.', 'incoming.')) : e, functions: sql === 'owner' ? ['public.f'] : [] }
}
const row = (over: Partial<PolicyRow>): PolicyRow =>
  ({ schema: 'public', table: 'docs', name: 'p', cmd: 'r', permissive: true, roles: ['public'], using: 'owner', check: null, ...over })
const at = () => ({ file: 'm.sql', line: 3 })

describe('buildPolicies', () => {
  it('emits one policy per op with the right clause', () => {
    const { policies } = buildPolicies([row({ cmd: '*', using: 'owner' })], 'supabase', condition, at)
    const byOp = Object.fromEntries(policies.map(p => [p.ops[0], p.condition]))
    expect(Object.keys(byOp)).toEqual(['read', 'list', 'create', 'update', 'delete'])
    expect(byOp.read).toEqual({ and: [AUTH, OWNER] })
    expect(byOp.create).toEqual({ and: [AUTH, eq('incoming.owner_id', 'actor.uid')] })
    expect(byOp.update).toEqual({ and: [AUTH, OWNER, eq('incoming.owner_id', 'actor.uid')] })
    expect(policies[0]).toEqual({
      id: 'pg:public.docs#policy:p', store: 'pg-rls', target: 'public.docs', ops: ['read'],
      condition: { and: [AUTH, OWNER] }, functions: ['public.f'], evidence: { file: 'm.sql', line: 3 },
    })
  })
  it('uses WITH CHECK for insert and both clauses for update', () => {
    const { policies } = buildPolicies([
      row({ name: 'ins', cmd: 'a', using: null, check: 'owner' }),
      row({ name: 'upd', cmd: 'w', using: 'true', check: 'owner' }),
      row({ name: 'del', cmd: 'd', using: null }),
    ], 'supabase', condition, at)
    expect(policies.map(p => [p.id, p.ops, p.condition])).toEqual([
      ['pg:public.docs#policy:ins', ['create'], { and: [AUTH, eq('incoming.owner_id', 'actor.uid')] }],
      ['pg:public.docs#policy:upd', ['update'], { and: [AUTH, { and: [] }, eq('incoming.owner_id', 'actor.uid')] }],
      ['pg:public.docs#policy:del', ['delete'], { and: [] }],
    ])
  })
  it('ANDs restrictive policies into the permissive ones for the same ops', () => {
    const { policies } = buildPolicies([
      row({ name: 'all', using: 'true' }),
      row({ name: 'only live', permissive: false, cmd: '*', using: 'live' }),
    ], 'supabase', condition, at)
    expect(policies).toHaveLength(2)
    expect(policies.map(p => p.condition)).toEqual([
      { and: [{ and: [] }, EXPRS.live] }, { and: [{ and: [] }, EXPRS.live] },
    ])
  })
  it('applies Supabase roles: anon only, skipped roles with a warning', () => {
    const { policies, diagnostics } = buildPolicies([
      row({ name: 'anon read', roles: ['anon'], using: 'true' }),
      row({ name: 'svc', roles: ['service_role'], using: 'true' }),
      row({ name: 'anon restrict', roles: ['anon'], permissive: false, using: 'live' }),
    ], 'supabase', condition, at)
    expect(policies.map(p => p.condition)).toEqual([
      { and: [{ and: [{ not: AUTH }, { and: [] }] }, { or: [AUTH, EXPRS.live] }] },
      { and: [{ and: [{ not: AUTH }, { and: [] }] }, { or: [AUTH, EXPRS.live] }] },
    ])
    expect(diagnostics).toEqual([{
      analyzer: 'postgres', file: 'm.sql', severity: 'warning',
      message: 'policy "svc" on public.docs applies only to roles service_role; Holdline models the anon and authenticated roles, so it was skipped',
    }])
  })
  it('keeps plain-dialect policies for any role and drops their restrictive ones', () => {
    const { policies, diagnostics } = buildPolicies([
      row({ name: 'app', roles: ['app_user'], using: 'true' }),
      row({ name: 'r', roles: ['app_user'], permissive: false, using: 'live' }),
    ], 'plain', condition, at)
    expect(policies.map(p => p.condition)).toEqual([{ and: [] }, { and: [] }])
    expect(diagnostics).toEqual([])
  })
})
```

`packages/analyzer-postgres/test/catalog.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { readCatalog } from '../src/catalog.js'
import { runMigrations, type MigrationRun } from '../src/migrate.js'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

let run: MigrationRun
beforeAll(async () => {
  run = await runMigrations([{ path: 'm.sql', sql: `
    create table public.docs (id uuid primary key, owner_id uuid);
    alter table public.docs enable row level security;
    create function public.mine(o uuid) returns boolean language sql stable as $$ select o = auth.uid() $$;
    create policy "own" on public.docs for update to authenticated using (public.mine(owner_id)) with check (owner_id = auth.uid());
    create policy "anon none" on public.docs as restrictive for select to anon using (false);
    create policy "files" on storage.objects for select using (owner = auth.uid());
  ` }], 'supabase')
})
afterAll(async () => { await run.db.close() })

describe('readCatalog', () => {
  it('reads policy rows, relations and functions, leaving shim tables out of tables and policies', async () => {
    const c = await readCatalog(run.db, 'supabase')
    expect(c.tables.map(t => t.id)).toEqual(['pg:public.docs'])
    expect(c.policies).toEqual([
      { schema: 'public', table: 'docs', name: 'anon none', cmd: 'r', permissive: false, roles: ['anon'], using: 'false', check: null },
      { schema: 'public', table: 'docs', name: 'own', cmd: 'w', permissive: true, roles: ['authenticated'], using: 'mine(owner_id)', check: '(owner_id = auth.uid())' },
    ])
    expect(c.relations.get('public.docs')).toEqual(new Set(['id', 'owner_id']))
    expect(c.relations.get('auth.users')).toEqual(new Set(['id', 'email']))
    expect(c.functions.get('public.mine/1')).toMatchObject({ schema: 'public', name: 'mine', argNames: ['o'], language: 'sql', volatility: 's' })
    expect(c.functions.get('public.mine/1')!.body.trim()).toBe('select o = auth.uid()')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/analyzer-postgres/test/policies.test.ts packages/analyzer-postgres/test/catalog.test.ts`
Expected: FAIL, modules or exports missing.

- [ ] **Step 3: Implement**

`packages/analyzer-postgres/src/anon.ts`:

```ts
import type { Expr, Operand } from '@holdline/core'

export type Tri = 'T' | 'F' | '?'

// Claims Supabase also puts in the anon key's token, so they are not null for anonymous callers.
const ANON_CLAIMS = ['role', 'iss', 'ref', 'aud', 'iat', 'exp'].map(c => `actor.claim.${c}`)

const actorDependent = (o: Operand) => typeof o === 'string'
  && !ANON_CLAIMS.some(c => o === c || o.startsWith(`${c}.`))
  && (o.startsWith('actor.') || (o.startsWith('doc(') && o.includes('{actor.')))

// The condition's value for an anonymous caller: auth.uid() and auth.jwt() are null, and a comparison
// with null is never true, so every atom that reads the actor is false (the facts' anonymous caller convention).
export function forAnonymous(e: Expr): Tri {
  if ('and' in e) { const v = e.and.map(forAnonymous); return v.includes('F') ? 'F' : v.every(x => x === 'T') ? 'T' : '?' }
  if ('or' in e) { const v = e.or.map(forAnonymous); return v.includes('T') ? 'T' : v.every(x => x === 'F') ? 'F' : '?' }
  if ('not' in e) { const v = forAnonymous(e.not); return v === 'T' ? 'F' : v === 'F' ? 'T' : '?' }
  if (!('atom' in e)) return '?'
  const a = e.atom
  if (a.op === 'authenticated') return 'F'
  if (a.op === 'exists') return a.doc.includes('{actor.') ? 'F' : '?'
  if (a.op === 'isNull') return actorDependent(a.operand) ? 'F' : '?'
  return actorDependent(a.left) || actorDependent(a.right) ? 'F' : '?'
}

// Analyzers state sign-in explicitly (facts.md): a policy no anonymous caller can satisfy requires it.
export function requireSignIn(e: Expr): Expr {
  if (forAnonymous(e) !== 'F') return e
  return { and: [{ atom: { op: 'authenticated' } }, ...('and' in e ? e.and : [e])] }
}
```

`packages/analyzer-postgres/src/policies.ts`:

```ts
import type { Diagnostic, Expr, Location, Op, Policy } from '@holdline/core'
import { requireSignIn } from './anon.js'
import type { PolicyRow } from './catalog.js'
import type { Dialect } from './detect.js'
import type { Normalized } from './normalize.js'
import type { Side } from './scope.js'

export type ConditionOf = (sql: string, table: string, side: Side) => Normalized

const OPS: Record<PolicyRow['cmd'], Op[]> = {
  r: ['read', 'list'], a: ['create'], w: ['update'], d: ['delete'], '*': ['read', 'list', 'create', 'update', 'delete'],
}
const SIGNED_IN: Expr = { atom: { op: 'authenticated' } }
const TRUE_ = (): Normalized => ({ expr: { and: [] }, functions: [] })

type Applies = 'everyone' | 'anonymous' | 'skipped' | 'some-role'

function appliesTo(roles: readonly string[], dialect: Dialect): Applies {
  if (roles.includes('public')) return 'everyone'
  if (dialect === 'plain') return 'some-role'
  if (roles.includes('authenticated')) return 'everyone'
  return roles.includes('anon') ? 'anonymous' : 'skipped'
}

// SELECT and DELETE use USING, INSERT uses WITH CHECK, UPDATE both; WITH CHECK defaults to USING.
function opCondition(row: PolicyRow, op: Op, condition: ConditionOf): Normalized {
  const table = `${row.schema}.${row.table}`
  const using = () => (row.using === null ? TRUE_() : condition(row.using, table, 'resource'))
  const check = () => {
    const sql = row.check ?? row.using
    return sql === null ? TRUE_() : condition(sql, table, 'incoming')
  }
  if (op === 'create') return check()
  if (op !== 'update') return using()
  const [u, c] = [using(), check()]
  return { expr: { and: [u.expr, c.expr] }, functions: [...u.functions, ...c.functions] }
}

export function buildPolicies(
  rows: readonly PolicyRow[],
  dialect: Dialect,
  condition: ConditionOf,
  location: (row: PolicyRow) => Location | undefined,
): { policies: Policy[]; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = []
  const applies = (row: PolicyRow): Applies => {
    const a = appliesTo(row.roles, dialect)
    if (a === 'skipped') {
      diagnostics.push({
        analyzer: 'postgres', file: location(row)?.file ?? '', severity: 'warning',
        message: `policy "${row.name}" on ${row.schema}.${row.table} applies only to roles ${row.roles.join(', ')}; Holdline models the anon and authenticated roles, so it was skipped`,
      })
    }
    return a
  }
  const restrictions = new Map<string, Normalized[]>()
  for (const row of rows.filter(r => !r.permissive)) {
    const a = applies(row)
    if (a !== 'everyone' && a !== 'anonymous') continue
    for (const op of OPS[row.cmd]) {
      const c = opCondition(row, op, condition)
      const key = `${row.schema}.${row.table}#${op}`
      restrictions.set(key, [...(restrictions.get(key) ?? []), { ...c, expr: a === 'anonymous' ? { or: [SIGNED_IN, c.expr] } : c.expr }])
    }
  }
  const policies: Policy[] = []
  for (const row of rows.filter(r => r.permissive)) {
    const a = applies(row)
    if (a === 'skipped') continue
    const table = `${row.schema}.${row.table}`
    for (const op of OPS[row.cmd]) {
      const c = opCondition(row, op, condition)
      const base = a === 'anonymous' ? { and: [{ not: SIGNED_IN }, c.expr] } : c.expr
      const extra = restrictions.get(`${table}#${op}`) ?? []
      const evidence = location(row)
      policies.push({
        id: `pg:${table}#policy:${row.name}`,
        store: 'pg-rls',
        target: table,
        ops: [op],
        condition: requireSignIn(extra.length > 0 ? { and: [base, ...extra.map(x => x.expr)] } : base),
        functions: [...new Set([...c.functions, ...extra.flatMap(x => x.functions)])].sort(),
        ...(evidence ? { evidence } : {}),
      })
    }
  }
  return { policies, diagnostics }
}
```

Note the warning for a skipped row is pushed once per row (each row goes through `applies` once).

Append to `packages/analyzer-postgres/src/catalog.ts`:

```ts
import type { PGlite } from '@electric-sql/pglite'
import type { Table } from '@holdline/core'
import type { Dialect } from './detect.js'
import { readTables, sqlList, SYSTEM_SCHEMAS_SQL } from './tables.js'

export const SHIM_SCHEMAS = ['auth', 'storage', 'extensions']

export interface PolicyRow {
  schema: string
  table: string
  name: string
  cmd: 'r' | 'a' | 'w' | 'd' | '*'
  permissive: boolean
  roles: string[] // 'public' for PUBLIC
  using: string | null // pg_get_expr(polqual)
  check: string | null // pg_get_expr(polwithcheck)
}

export interface Catalog extends CatalogIndex { tables: Table[]; policies: PolicyRow[] }

export async function readCatalog(db: PGlite, dialect: Dialect): Promise<Catalog> {
  const excluded = dialect === 'supabase' ? SHIM_SCHEMAS : []
  const tables = await readTables(db, excluded)
  const names = new Set(tables.map(t => t.name))
  const columns = (await db.query<{ tbl: string; col: string }>(`
    select n.nspname || '.' || c.relname as tbl, a.attname as col
    from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
    where a.attnum > 0 and not a.attisdropped and c.relkind in ('r', 'p', 'v', 'm', 'f') and ${SYSTEM_SCHEMAS_SQL}
    order by 1, a.attnum`)).rows
  const relations = new Map<string, Set<string>>()
  for (const r of columns) relations.set(r.tbl, (relations.get(r.tbl) ?? new Set()).add(r.col))
  const fns = (await db.query<SqlFunction & { nargs: number }>(`
    select n.nspname as schema, p.proname as name, p.pronargs as nargs, coalesce(p.proargnames, '{}')::text[] as "argNames",
      l.lanname as language, p.provolatile as volatility, p.prosrc as body
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
    where p.prokind = 'f' and ${SYSTEM_SCHEMAS_SQL}`)).rows
  const functions = new Map(fns.map(({ nargs, ...f }) => [`${f.schema}.${f.name}/${nargs}`, f]))
  const rows = (await db.query<PolicyRow>(`
    select n.nspname as schema, c.relname as "table", p.polname as name, p.polcmd as cmd, p.polpermissive as permissive,
      array(select case when r = 0 then 'public' else pg_get_userbyid(r)::text end from unnest(p.polroles) r) as roles,
      pg_get_expr(p.polqual, p.polrelid) as "using", pg_get_expr(p.polwithcheck, p.polrelid) as "check"
    from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace
    order by 1, 2, 3`)).rows
  return { tables, relations, functions, policies: rows.filter(r => names.has(`${r.schema}.${r.table}`)) }
}
```

Move the imports to the top of the file. `"table"`, `"using"`, `"check"` and `"argNames"` are quoted aliases (reserved words or camelCase).

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm vitest run packages/analyzer-postgres/test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/analyzer-postgres
git commit -m "feat(analyzer-postgres): build RLS policy facts per op with roles and sign-in"
```

---

### Task 8: Analyzer assembly, cache and CLI registration

**Files:**
- Create: `packages/analyzer-postgres/src/facts.ts`, `packages/analyzer-postgres/src/analyzer.ts`
- Modify: `packages/analyzer-postgres/src/index.ts`, `packages/cli/src/analyzers.ts`, `packages/cli/package.json`, `packages/analyzer-postgres/test/golden-ts-postgres.test.ts`
- Test: `packages/analyzer-postgres/test/analyzer.test.ts`

**Interfaces:**
- Consumes: everything above; core `Analyzer`, `AnalyzerOutput`, `AnalyzerContext`, `FileCache`, `listFiles`, `SymbolFact`.
- Produces:
  - `factsFromDatabase(db: PGlite, dialect: Dialect, migrations: readonly Migration[]): Promise<AnalyzerOutput>` (tables with locations, table and policy symbols, policies, warnings)
  - `analyzeMigrations(migrations: readonly Migration[], dialect: Dialect): Promise<AnalyzerOutput>` (runs PGlite, closes it)
  - `postgresAnalyzer: Analyzer` with `name: 'postgres'`, `version: '0.1.0'`
  - `index.ts` exports `postgresAnalyzer`, `applyMigrations`, `runMigrations`, `readMigrations`, `findMigrations`, `detectPostgres`, `analyzeMigrations`, `factsFromDatabase` and their types.

Behavior:
- No migration files: if `postgres.migrations` is configured, one error diagnostic `{ file: '.holdline/config.yaml', message: 'postgres.migrations matches no files' }`; otherwise (a Prisma schema only) one warning `{ file: 'prisma/schema.prisma', message: 'no SQL migrations found; run prisma migrate or point holdline at a schema dump' }`.
- A failing migration: exactly one error diagnostic `{ analyzer: 'postgres', file: <migration>, severity: 'error', message: <Postgres message with (line N)> }` and no other facts.
- Cache: `ctx.cache.get/set('postgres', '0.1.0', key)` with `key = JSON.stringify({ dialect, migrations })` (paths and contents). A hit returns without starting PGlite. Recognizers are not used by this analyzer, so they are not in the key.

- [ ] **Step 1: Write the failing tests**

`packages/analyzer-postgres/test/analyzer.test.ts`:

```ts
import { readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { FileCache, listFiles, type AnalyzerContext, type HoldlineConfig } from '@holdline/core'
import { describe, expect, it, vi } from 'vitest'
import { postgresAnalyzer } from '../src/analyzer.js'
import { makeProject } from './helpers/project.js'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

async function context(root: string, config: HoldlineConfig = {}): Promise<AnalyzerContext> {
  return { root, files: await listFiles(root), cache: new FileCache(root), config, recognizers: [] }
}

const MIGRATION = `-- projects
create table public.projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id)
);
alter table public.projects enable row level security;

create policy "owners update" on public.projects
  for update to authenticated
  using (owner_id = (select auth.uid()));
create policy "service" on public.projects to service_role using (true);
`

describe('postgresAnalyzer', () => {
  it('emits tables, symbols and policies with locations', async () => {
    const root = await makeProject({ 'supabase/migrations/001_init.sql': MIGRATION })
    const out = await postgresAnalyzer.analyze(await context(root))
    expect(out.tables).toHaveLength(1)
    expect(out.tables![0]).toMatchObject({ id: 'pg:public.projects', rlsEnabled: true, location: { file: 'supabase/migrations/001_init.sql', line: 2 } })
    expect(out.symbols).toEqual([
      { id: 'pg:public.projects', kind: 'table', lang: 'sql', location: { file: 'supabase/migrations/001_init.sql', line: 2 } },
      { id: 'pg:public.projects#policy:owners update', kind: 'policy', lang: 'sql', location: { file: 'supabase/migrations/001_init.sql', line: 8 } },
    ])
    const owner = { atom: { op: 'eq', left: 'resource.owner_id', right: 'actor.uid' } }
    expect(out.policies).toEqual([{
      id: 'pg:public.projects#policy:owners update', store: 'pg-rls', target: 'public.projects', ops: ['update'],
      condition: { and: [{ atom: { op: 'authenticated' } }, owner, { atom: { op: 'eq', left: 'incoming.owner_id', right: 'actor.uid' } }] },
      functions: [], evidence: { file: 'supabase/migrations/001_init.sql', line: 8 },
    }])
    expect(out.diagnostics).toEqual([expect.objectContaining({ severity: 'warning', message: expect.stringContaining('"service"') })])
  })

  it('reports a failing migration as one error diagnostic', async () => {
    const root = await makeProject({ 'supabase/migrations/001.sql': 'create table public.a (id int);\ncreate tabel b;' })
    const out = await postgresAnalyzer.analyze(await context(root))
    expect(out).toEqual({ diagnostics: [{ analyzer: 'postgres', file: 'supabase/migrations/001.sql', severity: 'error', message: expect.stringMatching(/syntax error.*\(line 2\)/) }] })
  })

  it('reports configured globs that match nothing, and a Prisma schema without migrations', async () => {
    const empty = await makeProject({ 'src/a.ts': '' })
    expect(await postgresAnalyzer.analyze(await context(empty, { postgres: { migrations: ['db/*.sql'] } }))).toEqual({ diagnostics: [
      { analyzer: 'postgres', file: '.holdline/config.yaml', severity: 'error', message: 'postgres.migrations matches no files' },
    ] })
    const prisma = await makeProject({ 'prisma/schema.prisma': 'model A { id Int @id }' })
    expect(await postgresAnalyzer.detect(prisma, await listFiles(prisma), {})).toBe(true)
    expect(await postgresAnalyzer.analyze(await context(prisma))).toEqual({ diagnostics: [
      { analyzer: 'postgres', file: 'prisma/schema.prisma', severity: 'warning', message: 'no SQL migrations found; run prisma migrate or point holdline at a schema dump' },
    ] })
  })

  it('serves an unchanged migration set from the cache without starting Postgres', async () => {
    const root = await makeProject({ 'supabase/migrations/001_init.sql': MIGRATION })
    await postgresAnalyzer.analyze(await context(root))
    const dir = join(root, '.holdline/cache/files/postgres')
    const [file] = await readdir(dir)
    const sentinel = { diagnostics: [{ analyzer: 'postgres', file: 'x', severity: 'warning', message: 'from cache' }] }
    await writeFile(join(dir, file!), JSON.stringify(sentinel))
    expect(await postgresAnalyzer.analyze(await context(root))).toEqual(sentinel)
    await writeFile(join(root, 'supabase/migrations/001_init.sql'), `${MIGRATION}\n-- changed\n`)
    expect((await postgresAnalyzer.analyze(await context(root))).tables).toHaveLength(1)
  })

  it('scans 50 migrations cold in under 10 seconds (spec 3.5)', async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 50; i++) {
      const n = String(i).padStart(3, '0')
      files[`supabase/migrations/${n}_t.sql`] = `create table public.t${n} (id uuid primary key, owner_id uuid not null);
alter table public.t${n} enable row level security;
create policy "own ${n}" on public.t${n} for all to authenticated using (owner_id = (select auth.uid()));`
    }
    const root = await makeProject(files)
    const started = Date.now()
    const out = await postgresAnalyzer.analyze(await context(root))
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(out.tables).toHaveLength(50)
    expect(out.policies).toHaveLength(250)
  })
})
```

Extend `packages/analyzer-postgres/test/golden-ts-postgres.test.ts` with a second test that goes through the analyzer and compares tables with locations:

```ts
import { FileCache, listFiles } from '@holdline/core'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { postgresAnalyzer } from '../src/analyzer.js'

  it('produces the hand-written tables, locations included, through the analyzer', async () => {
    const expected = parseFacts(JSON.parse(await readFile(`${app}fixtures/facts.json`, 'utf8'))).tables
    const files = await listFiles(app)
    expect(await postgresAnalyzer.detect(app, files, {})).toBe(true)
    const cache = new FileCache(await mkdtemp(join(tmpdir(), 'holdline-cache-'))) // keep the repo clean
    const out = await postgresAnalyzer.analyze({ root: app, files, cache, config: {}, recognizers: [] })
    expect(out.diagnostics ?? []).toEqual([])
    expect(byId(parseFacts({ version: 1, tables: out.tables }).tables)).toEqual(byId(expected))
  })
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/analyzer-postgres/test/analyzer.test.ts packages/analyzer-postgres/test/golden-ts-postgres.test.ts`
Expected: FAIL, `../src/analyzer.js` not found.

- [ ] **Step 3: Implement**

`packages/analyzer-postgres/src/facts.ts`:

```ts
import type { PGlite } from '@electric-sql/pglite'
import type { AnalyzerOutput, SymbolFact } from '@holdline/core'
import { readCatalog } from './catalog.js'
import type { Dialect } from './detect.js'
import { statementLocations } from './locations.js'
import { runMigrations, type Migration } from './migrate.js'
import { normalizeCondition } from './normalize.js'
import { loadSqlParser } from './pgparse.js'
import { buildPolicies } from './policies.js'

// Facts from a database the migrations were applied to. Locations come from the migration texts.
export async function factsFromDatabase(db: PGlite, dialect: Dialect, migrations: readonly Migration[]): Promise<AnalyzerOutput> {
  const catalog = await readCatalog(db, dialect)
  const parse = await loadSqlParser()
  const where = statementLocations(migrations, parse)
  const supabase = dialect === 'supabase'
  const { policies, diagnostics } = buildPolicies(
    catalog.policies, dialect,
    (sql, table, side) => normalizeCondition(sql, { table, side, catalog, parse, supabase }),
    row => where.policies.get(`${row.schema}.${row.table}#${row.name}`),
  )
  const tables = catalog.tables.map(t => {
    const location = where.tables.get(t.name)
    return location ? { ...t, location } : t
  })
  const symbols: SymbolFact[] = tables.map(t => ({ id: t.id, kind: 'table', lang: 'sql', ...(t.location ? { location: t.location } : {}) }))
  const seen = new Set<string>()
  for (const p of policies) {
    if (seen.has(p.id)) continue
    seen.add(p.id)
    symbols.push({ id: p.id, kind: 'policy', lang: 'sql', ...(p.evidence ? { location: p.evidence } : {}) })
  }
  return { tables, symbols, policies, diagnostics }
}

export async function analyzeMigrations(migrations: readonly Migration[], dialect: Dialect): Promise<AnalyzerOutput> {
  const run = await runMigrations(migrations, dialect)
  try {
    if (run.failure) {
      return { diagnostics: [{ analyzer: 'postgres', file: run.failure.file, severity: 'error', message: run.failure.message }] }
    }
    return await factsFromDatabase(run.db, dialect, migrations)
  } finally {
    await run.db.close()
  }
}
```

Policies with no evidence get symbols without a location. Skipped policies (warnings) get no symbol.

`packages/analyzer-postgres/src/analyzer.ts`:

```ts
import type { Analyzer, AnalyzerOutput } from '@holdline/core'
import { detectPostgres, findMigrations } from './detect.js'
import { analyzeMigrations } from './facts.js'
import { readMigrations } from './migrate.js'

const NAME = 'postgres'
const VERSION = '0.1.0' // bump when the output for the same migrations changes

export const postgresAnalyzer: Analyzer = {
  name: NAME,
  version: VERSION,
  detect: (_root, files, config) => detectPostgres(files, config),
  async analyze(ctx): Promise<AnalyzerOutput> {
    const plan = findMigrations(ctx.files, ctx.config)
    if (plan.paths.length === 0) {
      return { diagnostics: [plan.configured
        ? { analyzer: NAME, file: '.holdline/config.yaml', severity: 'error', message: 'postgres.migrations matches no files' }
        : { analyzer: NAME, file: 'prisma/schema.prisma', severity: 'warning', message: 'no SQL migrations found; run prisma migrate or point holdline at a schema dump' }] }
    }
    const migrations = await readMigrations(ctx.root, plan.paths)
    // The whole fact set depends on every migration, so it is cached as one entry.
    const key = JSON.stringify({ dialect: plan.dialect, migrations })
    const cached = await ctx.cache.get<AnalyzerOutput>(NAME, VERSION, key)
    if (cached) return cached
    const out = await analyzeMigrations(migrations, plan.dialect)
    await ctx.cache.set(NAME, VERSION, key, out)
    return out
  },
}
```

`packages/analyzer-postgres/src/index.ts`:

```ts
export { postgresAnalyzer } from './analyzer.js'
export { detectPostgres, findMigrations, type Dialect, type MigrationPlan } from './detect.js'
export { analyzeMigrations, factsFromDatabase } from './facts.js'
export { applyMigrations, readMigrations, runMigrations, type Migration, type MigrationFailure, type MigrationRun } from './migrate.js'
```

`packages/cli/package.json` dependencies gain `"@holdline/analyzer-postgres": "workspace:*"` (then `pnpm install`).

`packages/cli/src/analyzers.ts`:

```ts
import type { Analyzer } from '@holdline/core'
import { postgresAnalyzer } from '@holdline/analyzer-postgres'

// Phase 1 and 2 analyzer packages register here.
export const analyzers: Analyzer[] = [postgresAnalyzer]
```

- [ ] **Step 4: Run all tests and typecheck**

Run: `pnpm typecheck && pnpm test`
Expected: PASS, including every existing CLI test (the golden-firebase skeleton has no SQL, so the analyzer does not run there).

- [ ] **Step 5: Commit**

```bash
git add packages/analyzer-postgres packages/cli/src/analyzers.ts packages/cli/package.json pnpm-lock.yaml
git commit -m "feat(analyzer-postgres): assemble facts, cache them and register the analyzer"
```

---

### Task 9: Soundness tests in PGlite

**Files:**
- Create: `packages/analyzer-postgres/test/helpers/model.ts`, `packages/analyzer-postgres/test/soundness.test.ts`

**Interfaces:**
- Consumes: `runMigrations` (Task 2), `factsFromDatabase` (Task 8), core `Expr`, `Operand`, `Policy`, `Op`.
- Produces: `evaluate(e: Expr, w: World): boolean` and `interface World { actor: { uid: string; claims: Record<string, unknown> } | null; resource?: Row; incoming?: Row; tables: Record<string, Row[]> }`, `type Row = Record<string, string | number | null>`.

The property (spec 9): for every normalization rule, in every sampled world, **if real Postgres allows the request then the normalized condition is true** (the `Expr` is never stronger than the SQL). Each case also asserts the sample contains at least one allowed and one denied world, and that the normalized condition has no `opaque` (an opaque condition would make the property vacuous). The condition checked is the OR of the analyzer's policy facts for that op, so ops, roles, restrictive policies and sign-in are covered too.

Model semantics (facts.md "anonymous caller convention"): an atom that reads the actor is false when `actor` is null; `eq`/`ne`/`lt`/`gt`/`in` are false when either side is null (`ne` is true only for two non-null different values); `exists pg:<schema.table>?c={o}&…` is true when every placeholder is non-null and some row of that table matches all columns; `actor.role` reads the `role` claim; `opaque` and `ref` throw.

- [ ] **Step 1: Write the model**

`packages/analyzer-postgres/test/helpers/model.ts`:

```ts
import type { Atom, Expr, Operand } from '@holdline/core'

export type Row = Record<string, string | number | null>
export interface World {
  actor: { uid: string; claims: Record<string, unknown> } | null
  resource?: Row
  incoming?: Row
  tables: Record<string, Row[]>
}

const ACTOR = Symbol('anonymous actor')

function value(o: Operand, w: World): unknown {
  if (typeof o !== 'string') return o.literal
  if (o.startsWith('actor.')) {
    if (!w.actor) return ACTOR
    if (o === 'actor.uid') return w.actor.uid
    const path = o === 'actor.role' ? ['role'] : o.slice('actor.claim.'.length).split('.')
    return path.reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), w.actor.claims) ?? null
  }
  if (o.startsWith('resource.')) return w.resource?.[o.slice(9)] ?? null
  if (o.startsWith('incoming.')) return w.incoming?.[o.slice(9)] ?? null
  throw new Error(`model cannot read ${o}`)
}

function holds(a: Atom, w: World): boolean {
  if (a.op === 'authenticated') return w.actor !== null
  if (a.op === 'exists') {
    const [table, query = ''] = a.doc.slice(3).split('?')
    const want = query.split('&').map(p => p.split('=') as [string, string]).map(([c, ref]) => [c, value(ref.slice(1, -1), w)] as const)
    if (want.some(([, v]) => v === null || v === ACTOR)) return false
    return (w.tables[table!] ?? []).some(r => want.every(([c, v]) => r[c] === v))
  }
  if (a.op === 'isNull') { const v = value(a.operand, w); return v !== ACTOR && v === null }
  const l = value(a.left, w)
  const r = value(a.right, w)
  if (l === ACTOR || r === ACTOR || l === null || r === null) return false
  switch (a.op) {
    case 'eq': return l === r
    case 'ne': return l !== r
    case 'lt': return (l as number) < (r as number)
    case 'gt': return (l as number) > (r as number)
    case 'in': return Array.isArray(r) && r.includes(l as string | number)
  }
}

export function evaluate(e: Expr, w: World): boolean {
  if ('and' in e) return e.and.every(x => evaluate(x, w))
  if ('or' in e) return e.or.some(x => evaluate(x, w))
  if ('not' in e) return !evaluate(e.not, w)
  if ('atom' in e) return holds(e.atom, w)
  throw new Error(`model cannot evaluate ${JSON.stringify(e)}`)
}
```

- [ ] **Step 2: Write the soundness test**

`packages/analyzer-postgres/test/soundness.test.ts`:

```ts
import type { Expr, Op, Policy } from '@holdline/core'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { factsFromDatabase } from '../src/facts.js'
import { runMigrations, type MigrationRun } from '../src/migrate.js'
import { evaluate, type Row, type World } from './helpers/model.js'

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 })

const U1 = '00000000-0000-0000-0000-0000000000a1'
const U2 = '00000000-0000-0000-0000-0000000000a2'
const O1 = '00000000-0000-0000-0000-0000000000b1'
const O2 = '00000000-0000-0000-0000-0000000000b2'
const DOC = '00000000-0000-0000-0000-0000000000c1'

const SCHEMA = `
create table public.members (org_id uuid not null, user_id uuid not null, role text not null);
create table public.docs (id uuid primary key, org_id uuid, owner_id uuid, status text, n int, deleted_at timestamptz);
alter table public.docs enable row level security;
create function public.is_member(o uuid) returns boolean language sql stable security definer
  as $$ select exists (select 1 from public.members m where m.org_id = o and m.user_id = (select auth.uid())) $$;
`

// A small deterministic generator, so failures reproduce.
function rng(seed: number) {
  let s = seed
  return <T>(xs: readonly T[]): T => { s = (s * 1103515245 + 12345) % 2147483648; return xs[s % xs.length]! }
}

function worlds(count: number, seed: number): World[] {
  const pick = rng(seed)
  const doc = (): Row => ({
    id: DOC, org_id: pick([O1, O2, null]), owner_id: pick([U1, U2, null]),
    status: pick(['a', 'b', null]), n: pick([0, 5, null]), deleted_at: pick([null, '2026-01-01T00:00:00+00:00']),
  })
  const membership = [{ org_id: O1, user_id: U1, role: 'admin' }, { org_id: O2, user_id: U2, role: 'member' }, { org_id: O1, user_id: U2, role: 'member' }]
  return Array.from({ length: count }, () => {
    const uid = pick([null, U1, U2])
    const claims = { role: 'authenticated', ...pick([{}, { user_role: 'admin' }, { app_metadata: { tier: 'gold' } }]) }
    return {
      actor: uid === null ? null : { uid, claims: { sub: uid, ...claims } },
      resource: doc(), incoming: doc(),
      tables: { 'public.members': membership.filter(() => pick([true, false])) },
    }
  })
}

let run: MigrationRun
beforeAll(async () => {
  run = await runMigrations([{ path: 'schema.sql', sql: SCHEMA }], 'supabase')
})
afterAll(async () => { await run.db.close() })

const COLUMNS = ['id', 'org_id', 'owner_id', 'status', 'n', 'deleted_at'] as const
const values = (r: Row) => COLUMNS.map(c => r[c] ?? null)

// What real Postgres does for this world and op, as the anon or authenticated role.
async function sqlAllows(w: World, op: Op): Promise<boolean> {
  const db = run.db
  await db.exec('begin')
  try {
    for (const m of w.tables['public.members'] ?? []) {
      await db.query('insert into public.members values ($1, $2, $3)', [m.org_id, m.user_id, m.role])
    }
    if (op !== 'create') await db.query('insert into public.docs values ($1, $2, $3, $4, $5, $6)', values(w.resource!))
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [w.actor ? JSON.stringify(w.actor.claims) : ''])
    await db.exec(`set local role ${w.actor ? 'authenticated' : 'anon'}`)
    try {
      if (op === 'read') return (await db.query('select 1 from public.docs where id = $1', [DOC])).rows.length === 1
      if (op === 'create') { await db.query('insert into public.docs values ($1, $2, $3, $4, $5, $6)', values(w.incoming!)); return true }
      if (op === 'update') {
        const [, ...rest] = values(w.incoming!)
        const r = await db.query('update public.docs set org_id = $2, owner_id = $3, status = $4, n = $5, deleted_at = $6 where id = $1', [DOC, ...rest])
        return r.affectedRows === 1
      }
      return (await db.query('delete from public.docs where id = $1', [DOC])).affectedRows === 1
    } catch (e) {
      if ((e as { code?: string }).code === '42501') return false
      throw e
    }
  } finally {
    await db.exec('rollback')
  }
}

function hasOpaque(e: Expr): boolean {
  if ('and' in e) return e.and.some(hasOpaque)
  if ('or' in e) return e.or.some(hasOpaque)
  if ('not' in e) return hasOpaque(e.not)
  return 'opaque' in e || 'ref' in e
}

// Creates the policies, reads them back through the analyzer, and checks the property on sampled worlds.
async function checkSound(policiesSql: string, op: Op, seed: number): Promise<Expr> {
  await run.db.exec(policiesSql)
  try {
    const facts = await factsFromDatabase(run.db, 'supabase', [])
    const condition: Expr = { or: (facts.policies as Policy[]).filter(p => p.target === 'public.docs' && p.ops.includes(op)).map(p => p.condition) }
    expect(hasOpaque(condition), JSON.stringify(condition)).toBe(false)
    let allowed = 0
    let denied = 0
    for (const w of worlds(150, seed)) {
      const sql = await sqlAllows(w, op)
      if (sql) allowed++; else denied++
      if (sql) expect(evaluate(condition, w), `SQL allowed but Expr false: ${JSON.stringify({ w, condition })}`).toBe(true)
    }
    expect(allowed, 'no world was allowed').toBeGreaterThan(0)
    expect(denied, 'no world was denied').toBeGreaterThan(0)
    return condition
  } finally {
    const names = (await run.db.query<{ polname: string }>(`select polname from pg_policy where polrelid = 'public.docs'::regclass`)).rows
    for (const { polname } of names) await run.db.exec(`drop policy "${polname}" on public.docs`)
  }
}

const select = (using: string, to = 'anon, authenticated') => `create policy p on public.docs for select to ${to} using (${using});`
// UPDATE and DELETE with a WHERE clause also apply SELECT policies; this one lets every row be seen.
const SEE_ALL = `create policy see on public.docs for select using (true);`

describe('normalization is never stronger than the SQL', () => {
  const cases: [string, string, Op][] = [
    ['auth.uid() = column', select('owner_id = auth.uid()'), 'read'],
    ['(select auth.uid())', select('(select auth.uid()) = owner_id'), 'read'],
    ['auth.uid()::text', select("auth.uid()::text = '00000000-0000-0000-0000-0000000000a1'"), 'read'],
    ['jwt claim', select("(auth.jwt() ->> 'user_role') = 'admin'"), 'read'],
    ['nested jwt claim', select("(auth.jwt() -> 'app_metadata' ->> 'tier') = 'gold'"), 'read'],
    ['auth.role()', select("auth.role() = 'authenticated'"), 'read'],
    ["auth.role() = 'anon'", select("auth.role() = 'anon' or status = 'a'"), 'read'],
    ['<>', select("status <> 'a'"), 'read'],
    ['<', select('n < 3'), 'read'],
    ['>', select('n > 3'), 'read'],
    ['IN list', select("status in ('a', 'b')"), 'read'],
    ['= ANY (ARRAY)', select('n = any (array[0, 5])'), 'read'],
    ['IS NULL', select('deleted_at is null'), 'read'],
    ['IS NOT NULL', select('deleted_at is not null'), 'read'],
    ['auth.uid() IS NOT NULL', select('auth.uid() is not null'), 'read'],
    ['auth.uid() IS NULL', select("auth.uid() is null or status = 'a'"), 'read'],
    ['AND OR NOT', select("not (owner_id = auth.uid()) or (status = 'a' and n > 3)"), 'read'],
    ['true', select('true'), 'read'],
    ['false', select('false') + select("status = 'a'").replace('policy p', 'policy q'), 'read'],
    ['EXISTS', select('exists (select 1 from public.members m where m.org_id = docs.org_id and m.user_id = auth.uid())'), 'read'],
    ['IN (SELECT)', select('org_id in (select org_id from public.members where user_id = auth.uid())'), 'read'],
    ['NOT EXISTS', select('not exists (select 1 from public.members m where m.org_id = docs.org_id and m.user_id = auth.uid())'), 'read'],
    ['helper function', select('public.is_member(org_id)'), 'read'],
    ['WITH CHECK on insert', 'create policy p on public.docs for insert to authenticated with check (owner_id = auth.uid() and public.is_member(org_id));', 'create'],
    ['USING and WITH CHECK on update', `${SEE_ALL} create policy p on public.docs for update to authenticated using (owner_id = auth.uid()) with check (status = 'a');`, 'update'],
    ['USING as WITH CHECK on update', `${SEE_ALL} create policy p on public.docs for update to authenticated using (owner_id = auth.uid());`, 'update'],
    ['delete', `${SEE_ALL} create policy p on public.docs for delete to authenticated using (owner_id = auth.uid());`, 'delete'],
    ['FOR ALL', 'create policy p on public.docs to authenticated using (owner_id = auth.uid());', 'update'],
    ['restrictive', select('true') + ` create policy r on public.docs as restrictive for select using (status = 'a');`, 'read'],
    ['restrictive for anon only', select('true') + ` create policy r on public.docs as restrictive for select to anon using (status = 'a');`, 'read'],
    ['anon-only permissive', select("status = 'a'", 'anon') + select('owner_id = auth.uid()', 'authenticated').replace('policy p', 'policy q'), 'read'],
  ]
  cases.forEach(([name, sql, op], i) => {
    it(name, async () => { await checkSound(sql, op, 1000 + i) })
  })
})
```

`affectedRows` is PGlite's count for `update`/`delete`; if the installed PGlite names it differently, read the type in `node_modules/@electric-sql/pglite/dist/*.d.ts` and use that field.

- [ ] **Step 3: Run the tests**

Run: `pnpm vitest run packages/analyzer-postgres/test/soundness.test.ts`
Expected: PASS. A failing case is a real soundness bug in the normalizer or the policy builder: fix the source (with a unit test in the matching test file first), never the property. If a case fails only on its "allowed"/"denied" sanity count, adjust that case's world sampling seed or SQL, and say so in the commit message.

- [ ] **Step 4: Commit**

```bash
git add packages/analyzer-postgres/test
git commit -m "test(analyzer-postgres): check every normalization against real Postgres"
```

---

### Task 10: `examples/golden-supabase` app and rules

**Files:**
- Create: `examples/golden-supabase/package.json`, `examples/golden-supabase/app/projects/page.tsx`, `examples/golden-supabase/lib/supabase.ts`, `examples/golden-supabase/supabase/migrations/20261001000000_organizations.sql`, `examples/golden-supabase/supabase/migrations/20261002000000_projects.sql`, `examples/golden-supabase/supabase/migrations/20261003000000_rls.sql`
- Modify: `examples/golden-supabase/expected-rules.yaml`, `examples/golden-supabase/README.md`, `packages/cli/test/golden-patch.test.ts` (timeout only)
- Delete: `examples/golden-supabase/supabase/migrations/.gitkeep`
- Test: the existing `packages/cli/test/golden-patch.test.ts` "passes every expected rule on the clean app" (runs once the app has a patch; Task 11), plus a temporary manual run now.

The app is not installed or built; Holdline only reads the migrations in Phase 1. The Next.js files exist so the example looks like the apps it stands for.

- [ ] **Step 1: Write the app**

`examples/golden-supabase/package.json`:

```json
{
  "name": "golden-supabase",
  "private": true,
  "scripts": { "dev": "next dev" },
  "dependencies": {
    "@supabase/ssr": "^0.7.0",
    "@supabase/supabase-js": "^2.58.0",
    "next": "^15.5.0",
    "react": "^19.1.0",
    "react-dom": "^19.1.0"
  }
}
```

`examples/golden-supabase/lib/supabase.ts`:

```ts
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

// Every query runs as the signed-in user, so row level security decides what it sees.
export async function supabase() {
  const store = await cookies()
  return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: { getAll: () => store.getAll(), setAll: () => {} },
  })
}
```

`examples/golden-supabase/app/projects/page.tsx`:

```tsx
import { supabase } from '../../lib/supabase'

export default async function ProjectsPage() {
  const db = await supabase()
  const { data: projects } = await db.from('projects').select('id, name, status').order('name')
  return (
    <ul>
      {(projects ?? []).map(p => <li key={p.id}>{p.name} ({p.status})</li>)}
    </ul>
  )
}
```

`examples/golden-supabase/supabase/migrations/20261001000000_organizations.sql`:

```sql
-- Organizations and who belongs to them.
create type public.membership_role as enum ('owner', 'admin', 'member');

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table public.memberships (
  org_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.membership_role not null default 'member',
  constraint memberships_org_user_key unique (org_id, user_id)
);

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text
);

-- Membership check used by policies. Security definer so it can read memberships under RLS.
create function public.is_org_member(target_org uuid) returns boolean
  language sql stable security definer set search_path = ''
  as $$ select exists (select 1 from public.memberships m where m.org_id = target_org and m.user_id = (select auth.uid())) $$;
```

`examples/golden-supabase/supabase/migrations/20261002000000_projects.sql`:

```sql
create table public.projects (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id),
  owner_id uuid not null references auth.users (id),
  name text not null,
  status text not null default 'active',
  deleted_at timestamptz
);

-- Amounts are in cents.
create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id),
  amount integer not null,
  constraint invoices_amount_positive check (amount > 0)
);
```

`examples/golden-supabase/supabase/migrations/20261003000000_rls.sql`:

```sql
alter table public.organizations enable row level security;
alter table public.memberships enable row level security;
alter table public.profiles enable row level security;
alter table public.projects enable row level security;
alter table public.invoices enable row level security;

create policy "members read their organizations" on public.organizations
  for select to authenticated
  using (exists (select 1 from public.memberships m where m.org_id = organizations.id and m.user_id = (select auth.uid())));

create policy "users read their memberships" on public.memberships
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy "signed-in users read profiles" on public.profiles
  for select to authenticated
  using (true);

create policy "users update their own profile" on public.profiles
  for update to authenticated
  using (id = (select auth.uid()));

create policy "members read live projects" on public.projects
  for select to authenticated
  using (
    deleted_at is null
    and org_id in (select m.org_id from public.memberships m where m.user_id = (select auth.uid()))
  );

create policy "members create projects" on public.projects
  for insert to authenticated
  with check (owner_id = (select auth.uid()) and public.is_org_member(org_id));

create policy "owners update projects" on public.projects
  for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

create policy "admins read invoices" on public.invoices
  for select to authenticated
  using ((auth.jwt() ->> 'user_role') = 'admin' and public.is_org_member(org_id));
```

- [ ] **Step 2: Write the rules**

`examples/golden-supabase/expected-rules.yaml` (hashes are placeholders the script in Step 3 replaces):

```yaml
version: 1
vocabulary: []
rules:
  - id: R-001
    text: Users read only the projects of organizations they belong to
    type: data-access
    target: { store: postgres, table: projects }
    ops: [read, list]
    requires:
      atom: { op: exists, doc: "pg:public.memberships?org_id={resource.org_id}&user_id={actor.uid}" }
    evidence: [pg:public.projects]
    status: approved
    approved: { by: golden, at: 2026-10-21, hash: "000000000000" }
  - id: R-002
    text: Only a project's owner can update it
    type: data-access
    target: { store: postgres, table: projects }
    ops: [update]
    requires:
      atom: { op: eq, left: resource.owner_id, right: actor.uid }
    evidence: [pg:public.projects]
    status: approved
    approved: { by: golden, at: 2026-10-21, hash: "000000000000" }
  - id: R-003
    text: Projects are created only by members of the project's organization
    type: data-access
    target: { store: postgres, table: projects }
    ops: [create]
    requires:
      atom: { op: exists, doc: "pg:public.memberships?org_id={incoming.org_id}&user_id={actor.uid}" }
    evidence: [pg:public.projects]
    status: approved
    approved: { by: golden, at: 2026-10-21, hash: "000000000000" }
  - id: R-004
    text: Only admins read invoices
    type: data-access
    target: { store: postgres, table: invoices }
    ops: [read, list]
    requires:
      atom: { op: eq, left: actor.claim.user_role, right: { literal: admin } }
    evidence: [pg:public.invoices]
    status: approved
    approved: { by: golden, at: 2026-10-21, hash: "000000000000" }
  - id: R-005
    text: Users read only organizations they belong to
    type: data-access
    target: { store: postgres, table: organizations }
    ops: [read, list]
    requires:
      atom: { op: exists, doc: "pg:public.memberships?org_id={resource.id}&user_id={actor.uid}" }
    evidence: [pg:public.organizations]
    status: approved
    approved: { by: golden, at: 2026-10-21, hash: "000000000000" }
  - id: R-006
    text: Deleted projects are never readable
    type: data-access
    target: { store: postgres, table: projects }
    ops: [read, list]
    requires:
      atom: { op: isNull, operand: resource.deleted_at }
    evidence: [pg:public.projects]
    status: approved
    approved: { by: golden, at: 2026-10-21, hash: "000000000000" }
  - id: R-007
    text: Users update only their own profile
    type: data-access
    target: { store: postgres, table: profiles }
    ops: [update]
    requires:
      atom: { op: eq, left: resource.id, right: actor.uid }
    evidence: [pg:public.profiles]
    status: approved
    approved: { by: golden, at: 2026-10-21, hash: "000000000000" }
  - id: R-008
    text: Every project belongs to an organization
    type: invariant
    target: { store: postgres, table: projects }
    kind: not-null
    columns: [org_id]
    evidence: [pg:public.projects]
    status: approved
    approved: { by: golden, at: 2026-10-21, hash: "000000000000" }
  - id: R-009
    text: A project's organization must exist
    type: invariant
    target: { store: postgres, table: projects }
    kind: fk
    columns: [org_id]
    references: { table: public.organizations, columns: [id] }
    evidence: [pg:public.projects]
    status: approved
    approved: { by: golden, at: 2026-10-21, hash: "000000000000" }
  - id: R-010
    text: A membership role is owner, admin or member
    type: invariant
    target: { store: postgres, table: memberships }
    kind: enum
    columns: [role]
    values: [owner, admin, member]
    evidence: [pg:public.memberships]
    status: approved
    approved: { by: golden, at: 2026-10-21, hash: "000000000000" }
  - id: R-011
    text: A user is a member of an organization at most once
    type: invariant
    target: { store: postgres, table: memberships }
    kind: unique
    columns: [org_id, user_id]
    evidence: [pg:public.memberships]
    status: approved
    approved: { by: golden, at: 2026-10-21, hash: "000000000000" }
  - id: R-012
    text: Invoice amounts are positive
    type: invariant
    target: { store: postgres, table: invoices }
    kind: check
    columns: [amount]
    expr: amount > 0
    evidence: [pg:public.invoices]
    status: approved
    approved: { by: golden, at: 2026-10-21, hash: "000000000000" }
lastRuleId: 12
```

- [ ] **Step 3: Stamp the hashes**

Run: `pnpm tsx scripts/approve-fixture.ts examples/golden-supabase/expected-rules.yaml`
Expected: `stamped 12 rules and 0 vocabulary entries in examples/golden-supabase/expected-rules.yaml`. The file is rewritten in block YAML; keep that output.

- [ ] **Step 4: Run scan and check on the clean app**

```bash
REPO=$PWD; D=$(mktemp -d); cp -R examples/golden-supabase/. "$D"; cp examples/golden-supabase/expected-rules.yaml "$D/holdline.rules"
(cd "$D" && "$REPO/node_modules/.bin/tsx" "$REPO/packages/cli/src/bin.ts" scan && "$REPO/node_modules/.bin/tsx" "$REPO/packages/cli/src/bin.ts" check --strict)
```

Expected: scan prints `Scanned with postgres: 0 routes, 0 data operations, 5 tables, N policies.` and exits 0; check reports 12 passing rules and exits 0. If a rule fails, read its message: fix the analyzer (with a unit test first) when the facts are wrong, or the rule when the rule is wrong; never weaken a rule just to pass.

- [ ] **Step 5: Give the golden apps time to start Postgres**

In `packages/cli/test/golden-patch.test.ts`, inside `describe.skipIf(apps.length === 0)(...)`, pass a timeout as the third argument of the two `it` calls (each run starts PGlite once; `check` reuses the scan's cache):

```ts
      it('passes every expected rule on the clean app', async () => {
        expectClean(await runPatchedApp(app.dir))
      }, 120_000)
```

```ts
        it(`catches ${rule}`, async () => {
          expectCaught(await runPatchedApp(app.dir, patch), rule)
        }, 120_000)
```

- [ ] **Step 6: Update the README and commit**

Replace the last paragraph of `examples/golden-supabase/README.md` (from "The acceptance test") with a rules table:

```markdown
The acceptance test (`packages/cli/test/golden-patch.test.ts`) copies this folder, applies each
patch, runs `holdline scan` and `holdline check`, and expects exactly that rule to fail.
After editing `expected-rules.yaml`, run
`pnpm tsx scripts/approve-fixture.ts examples/golden-supabase/expected-rules.yaml`.

| Rule | Type | What it shows | Breakage |
|---|---|---|---|
| R-001 | data-access | `IN (SELECT …)` membership as `exists` | membership check replaced by `auth.uid() IS NOT NULL` |
| R-002 | data-access | `USING` on update | owner check replaced by a membership check |
| R-003 | data-access | `WITH CHECK` with an inlined helper function | helper call dropped |
| R-004 | data-access | a custom JWT claim | claim check dropped |
| R-005 | data-access | `EXISTS` membership; RLS on | `ENABLE ROW LEVEL SECURITY` dropped |
| R-006 | data-access | `IS NULL` | `deleted_at is null` dropped |
| R-007 | data-access | `USING` reused as `WITH CHECK` | policy loosened to `true` |
| R-008 | invariant | not-null | `not null` dropped |
| R-009 | invariant | foreign key | `references` dropped |
| R-010 | invariant | enum | enum widened with `alter type … add value` |
| R-011 | invariant | unique | unique constraint dropped |
| R-012 | invariant | check | check relaxed to `amount >= 0` |
```

```bash
git rm examples/golden-supabase/supabase/migrations/.gitkeep
git add examples/golden-supabase packages/cli/test/golden-patch.test.ts
git commit -m "feat(golden-supabase): add the Supabase app, migrations and twelve rules"
```

---

### Task 11: One breakage per rule

**Files:**
- Create: `examples/golden-supabase/breakages/R-001.patch` … `R-012.patch`
- Delete: `examples/golden-supabase/breakages/.gitkeep` (once patches exist)
- Test: `packages/cli/test/golden-patch.test.ts` (per-app loop; every patch must be caught with exactly its own rule failing and `holdline scan` exiting 0)

Make each patch from the committed clean app (Task 10 must be committed first):

```bash
cd examples/golden-supabase
# edit the file(s) for one breakage, then:
git diff --relative > breakages/R-00N.patch
git checkout -- .            # restore the clean app (untracked new files: rm them)
cd ../..
```

For a breakage that adds a new migration file, add it with `git add -N <file>` before `git diff --relative`, then `git rm --cached -f <file>` and delete it afterwards. Patches must contain only paths relative to the app folder (`a/supabase/migrations/...`).

| Patch | Edit |
|---|---|
| R-001 | In `20261003000000_rls.sql`, "members read live projects": replace `and org_id in (select m.org_id from public.memberships m where m.user_id = (select auth.uid()))` with `and auth.uid() is not null` |
| R-002 | "owners update projects": replace `using (owner_id = (select auth.uid()))` with `using (public.is_org_member(org_id))` |
| R-003 | "members create projects": replace `with check (owner_id = (select auth.uid()) and public.is_org_member(org_id));` with `with check (owner_id = (select auth.uid()));` |
| R-004 | "admins read invoices": replace `using ((auth.jwt() ->> 'user_role') = 'admin' and public.is_org_member(org_id));` with `using (public.is_org_member(org_id));` |
| R-005 | delete the line `alter table public.organizations enable row level security;` |
| R-006 | "members read live projects": delete the line `deleted_at is null` and the `and ` before `org_id in (…)` |
| R-007 | "users update their own profile": replace `using (id = (select auth.uid()));` with `using (true);` |
| R-008 | In `20261002000000_projects.sql`: `org_id uuid not null references public.organizations (id),` → `org_id uuid references public.organizations (id),` |
| R-009 | In `20261002000000_projects.sql`: `org_id uuid not null references public.organizations (id),` → `org_id uuid not null,` |
| R-010 | New file `supabase/migrations/20261004000000_guest_role.sql` containing `alter type public.membership_role add value 'guest';` |
| R-011 | In `20261001000000_organizations.sql`: delete `,` after `default 'member'` and the line `constraint memberships_org_user_key unique (org_id, user_id)` |
| R-012 | In `20261002000000_projects.sql`: `check (amount > 0)` → `check (amount >= 0)` |

- [ ] **Step 1: Write the R-001 patch, run the harness, see it caught**

Run: `pnpm vitest run packages/cli/test/golden-patch.test.ts`
Expected: `golden-supabase > passes every expected rule on the clean app` and `catches R-001` PASS.

- [ ] **Step 2: Write R-002 … R-012 the same way**

After each patch run the harness. A breakage that also fails another rule, or that is reported `unknown` or `stale`, means the breakage or a rule is wrong (or the analyzer is): find which, fix it, and rerun. A patch that `git apply` rejects must be regenerated, never hand-edited.

- [ ] **Step 3: Run everything**

Run: `pnpm typecheck && pnpm test`
Expected: PASS; the golden-supabase suite lists 13 tests (clean + 12 breakages).

- [ ] **Step 4: Commit**

```bash
git rm -q examples/golden-supabase/breakages/.gitkeep
git add examples/golden-supabase/breakages
git commit -m "test(golden-supabase): add one file-patch breakage per rule"
```

---

### Task 12: Reference docs, spec As built, hand-over

**Files:**
- Modify: `docs/reference/facts.md` (Postgres rows), `docs/superpowers/specs/2026-10-21-data-layers-design.md` (status line, As built (Track A)), `CLAUDE.md` only if a convention changed (none is expected)
- Create: hand-over note `/Users/Almog/Library/Application Support/Claude/side-session-notes/local_029db5ef-25b9-4405-adb5-c835188bec27/track-a-postgres.md` (outside the repo, not committed)

- [ ] **Step 1: facts.md**

Add a section "Postgres analyzer (`packages/analyzer-postgres`)" after "Analyzer contract", describing the code as built: detection and default globs and dialect choice; the Supabase shim (schemas, roles, default privileges, `auth.uid()/jwt()/role()` with `nullif`, `auth.users`, `storage.buckets/objects`, `uuid-ossp` and `pgcrypto`); one transaction per migration and the failure diagnostic; table facts (formatting rules, ordering, unique indexes, `rlsEnabled`, locations at the latest `CREATE TABLE`); the normalization table from Tasks 5 and 6; the policy rules from Task 7 (ops, roles, restrictive, sign-in via the anonymous evaluation); diagnostics (failing migration, unmatched config, Prisma schema only, skipped roles); cache key; `applyMigrations` signature. Also update the `exists` doc row for Postgres: columns are sorted by name.

- [ ] **Step 2: Spec As built (Track A)**

Change the status line to `**Status:** Step 0 and Track A implemented (<date>). Tracks B and C are not built yet; see [As built (step 0)](#as-built-step-0) and [As built (Track A)](#as-built-track-a).` Add `## As built (Track A)` after "As built (step 0)" with a table of every difference from sections 3 and 6.1, at least:

| Section | As built |
|---|---|
| 3.2 Shim | `nullif(…, '')` around the claims setting (a rolled-back local setting reads as ''), default privileges for `anon`/`authenticated`/`service_role`, `storage.buckets` and `storage.objects`, `uuid-ossp` and `pgcrypto` preloaded |
| 3.2 Failure | A failing migration yields only its error diagnostic, no partial facts |
| 3.2 Facts | Type and default formatting rules; FK/unique/check order; unique indexes that back no constraint and are not partial or expression indexes count as uniques |
| 3.3 Roles | `anon`-only policies are kept as `and[not(authenticated), c]` (sound) instead of skipped; restrictive anon-only as `or[authenticated, c]`; plain dialect keeps custom-role permissive policies and drops their restrictive ones |
| 3.3 Sign-in | `authenticated` is added when the condition is certainly false for an anonymous caller, not whenever it mentions `auth.uid()`/`auth.jwt()`; `auth.uid() IS [NOT] NULL` maps to `[not] authenticated`; comparisons of the role with `'anon'` |
| 3.3 Mapping | casts on constants applied; `::text` on `auth.uid()`; `IN` lists; exists docs sorted by column; plain dialect does not map `auth.*` |
| 3.4 Locations | Tables at the latest `CREATE TABLE`, policies at the latest `CREATE POLICY`; `ALTER TABLE` statements are not used |
| 6.1 | The twelve rules and breakages (link the README table); "only admins read invoices" uses a custom JWT claim `user_role` (the exists doc format can't hold a literal) |
| Shared files | Root `package.json` typecheck, `packages/cli/package.json`, `golden-patch.test.ts` timeouts |

Add any further difference found during implementation.

- [ ] **Step 3: Verify and commit**

Run: `pnpm typecheck && pnpm test`
Expected: PASS.

```bash
git add docs
git commit -m "docs: record the Postgres analyzer in the reference and the spec"
```

- [ ] **Step 4: Hand-over note for Track C (not committed)**

Write `track-a-postgres.md` in the shared notes folder: the `applyMigrations(root, config, files?)` signature and `MigrationRun` type, that the caller closes `db`, that the shim grants table privileges to `anon`/`authenticated` through default privileges in `public`, that claims are read with `nullif(current_setting('request.jwt.claims', true), '')`, and the branch name.
