# Fact graph reference

The fact graph is what every analyzer emits and every checker reads. This page describes the code as built.
Sources: `packages/core/src/facts.ts`, `expr.ts`, `paths.ts`, `logic.ts`, `fact-index.ts`, `analyzer.ts`, `config.ts`, `files.ts`, `scan.ts`.
The Firestore and Storage analyzer is `packages/analyzer-firestore`; see "Firestore and Storage analyzer" below.
Worked example: `examples/golden-ts-postgres/fixtures/facts.json`.

All schemas are zod `strictObject`s: an unknown key is an error. `parseFacts(json, source)` throws `FactsError`
on any violation. Fields marked "default" may be omitted by an analyzer.

## Top level (`Facts`)

| Field | Type | Default | Notes |
|---|---|---|---|
| `version` | `1` | required | |
| `analyzers` | `{ name, version }[]` | `[]` | Filled in by `scan`, not by the analyzer |
| `symbols` | `SymbolFact[]` | `[]` | |
| `routes` | `Route[]` | `[]` | |
| `guards` | `Guard[]` | `[]` | |
| `dataOps` | `DataOp[]` | `[]` | |
| `calls` | `[from, to][]` | `[]` | Symbol id pairs |
| `tables` | `Table[]` | `[]` | Postgres |
| `collections` | `Collection[]` | `[]` | Firestore and Storage |
| `policies` | `Policy[]` | `[]` | RLS, Firestore rules, Storage rules |
| `diagnostics` | `Diagnostic[]` | `[]` | What an analyzer could not read |

`mergeFacts(parts)` concatenates every list. It does not dedupe.

## Fact types

### Location

| Field | Type |
|---|---|
| `file` | string, repo-relative |
| `line` | positive int |
| `endLine` | positive int, optional |

### SymbolFact

| Field | Type | Notes |
|---|---|---|
| `id` | string | See "Symbol ids" |
| `kind` | `function` `method` `class` `route` `middleware` `table` `column` `policy` `match` `collection` | |
| `lang` | `ts` `go` `py` `sql` `firestore` `storage` | |
| `location` | Location, optional | |
| `hash` | string, optional | Content hash, for caching |

### Route

| Field | Type | Default | Notes |
|---|---|---|---|
| `id` | string | | `route:<METHOD> <path>` |
| `method` | string | | |
| `path` | string starting with `/` | | Express style `:name` params |
| `handler` | symbol id | | |
| `middleware` | symbol id[] | `[]` | In execution order |
| `framework` | string | | e.g. `express` |
| `kind` | `http` `callable` `trigger` | `http` | |

### Guard

A condition that must hold for code at `at` to run.

| Field | Type | Notes |
|---|---|---|
| `at` | symbol or route id | |
| `requires` | Expr | |
| `evidence` | Location, optional | |

### DataOp

| Field | Type | Notes |
|---|---|---|
| `in` | symbol id | The function or method that performs the op |
| `store` | `postgres` `firestore` `storage` | |
| `target` | string | Postgres: table name (`public.dogs`; `dogs` is treated as `public.dogs`). Firestore and Storage: path pattern |
| `op` | `read` `list` `create` `update` `delete` | |
| `filters` | Expr, optional | Conditions the query applies to the stored record (`resource.*`) |
| `evidence` | Location, optional | |

### Table

| Field | Type | Default |
|---|---|---|
| `id` | string (`pg:public.dogs`) | |
| `name` | string (`public.dogs`) | |
| `columns` | `{ name, type, nullable, default? }[]` | |
| `primaryKey` | string[] | `[]` |
| `foreignKeys` | `{ columns[], references: { table, columns[] } }[]` | `[]` |
| `uniques` | string[][] | `[]` |
| `checks` | `{ name?, expr }[]` (`expr` is the SQL text) | `[]` |
| `enums` | `{ column, values[] }[]` | `[]` |
| `rlsEnabled` | boolean | `false` |
| `location` | Location, optional | |

### Collection

| Field | Type | Default |
|---|---|---|
| `path` | string starting with `/` | |
| `fields` | string[] | `[]` |
| `source` | `converter` `inferred` | |

### Policy

| Field | Type | Default | Notes |
|---|---|---|---|
| `id` | string | | |
| `store` | `pg-rls` `firestore` `storage` | | Note `pg-rls`, not `postgres` |
| `target` | string | | Postgres table or path pattern |
| `ops` | Op[] (at least 1) | | Firestore `write` is expanded to `create`, `update`, `delete`; `read` to `read` and `list`; `get` to `read` |
| `condition` | Expr | | The condition under which the policy allows the op |
| `functions` | string[] | `[]` | Helper functions the condition used |
| `evidence` | Location, optional | | |

### Diagnostic

| Field | Type | Notes |
|---|---|---|
| `analyzer` | string | |
| `file` | string | `''` means the whole analyzer failed (see "Analyzer contract"); `holdline check` then prints its results and exits 3 |
| `message` | string | |
| `severity` | `error` `warning` | Only `error` makes rules `unknown` |

## Symbol ids

Ids use names, never line numbers, so they survive refactors. Locations are evidence; ids are identity.

| Kind | Id | Example |
|---|---|---|
| Route | `route:<METHOD> <path>` | `route:POST /dogs/:id/transfer` |
| TS function | `ts:<file without extension>#<name>` | `ts:src/routes/dogs#transferDog` |
| TS class | `ts:<file>#<Class>` | `ts:src/repositories/dogs#DogRepository` |
| TS method | `ts:<file>#<Class>.<method>` | `ts:src/repositories/dogs#DogRepository.update` |
| Go function | `go:<package path>.<Name>` | `go:example.com/api/handlers.TransferDog` |
| Postgres table | `pg:<schema>.<table>` | `pg:public.dogs` |
| Postgres column | `pg:<schema>.<table>.<column>` | `pg:public.dogs.team_id` |
| Postgres policy | `pg:<schema>.<table>#policy:<name>` | `pg:public.dogs#policy:dogs_select_member` |
| Firestore policy | `firestore:<path pattern>#<op>@<line>` | `firestore:/accounts/{accountId}/things/{thingId}#read@12` |
| Firestore match | `firestore:<path pattern>` | `firestore:/accounts/{accountId}/dogs/{dogId}` |
| Storage match | `storage:<path pattern>` | `storage:/accounts/{accountId}/files/{path=**}` |
| Storage policy | `storage:<path pattern>#<op>@<line>` | `storage:/accounts/{accountId}/files/{path=**}#create@8` |

Rules:

- Every id that a rule's `evidence` or `symbol` target names **must** be emitted as a symbol (or route, table,
  policy): `FactIndex.hasId` knows symbols, routes, tables and policies, a missing `symbol` target makes the rule
  `stale`, and missing evidence rejects a proposal (and, while errors exist, makes the rule `unknown`).
- Ids named by `via` entries, `calls` edge endpoints, a guard's `at` or a dataOp's `in` **should** be emitted as
  symbols, so results can point at a location. Nothing fails without them: `via` matches by id and `<via>.` prefix.
- `location.line` is the declaration line of the symbol (the `CREATE TABLE` line for a table).
- A route with no location of its own reports its handler's location.

## Expressions (`Expr`)

```ts
type Expr =
  | { and: Expr[] } | { or: Expr[] } | { not: Expr }
  | { atom: Atom }
  | { ref: string }       // a named predicate from the rules file vocabulary
  | { opaque: string }    // a condition the analyzer could not normalize
```

`{ and: [] }` is true (`TRUE`), `{ or: [] }` is false (`FALSE`).

### Atoms

| Atom | Shape | Meaning |
|---|---|---|
| `authenticated` | `{ op: 'authenticated' }` | The caller is signed in |
| comparison | `{ op: 'eq' \| 'ne' \| 'in' \| 'lt' \| 'gt', left: Operand, right: Operand }` | |
| `exists` | `{ op: 'exists', doc: string }` | A document or row exists (Firestore `get()`/`exists()`, SQL `EXISTS`) |
| `isNull` | `{ op: 'isNull', operand: Operand }` | |

### Operands

A string matching `OPERAND_PATTERN`, or `{ literal }`.

| Operand | Meaning |
|---|---|
| `actor.uid` | The caller's id |
| `actor.role` | The caller's role |
| `actor.claim.<name>` | A token claim (dots allowed in `<name>`) |
| `resource.<field>` | The stored record |
| `incoming.<field>` | The data being written |
| `param.<name>` | A route or path parameter (no dots) |
| `doc(<path>).<field>` | A field of another document (lookup). `<path>` starts with `/`, has no parentheses and may hold `{<operand>}` placeholders, valid operands only and `resource.*`/`incoming.*` one field deep (`doc(/users/{actor.uid}).accountIds`); other braces are rejected; `<field>` is one or more `[A-Za-z0-9_]+` segments joined by dots. The Firestore analyzer maps `get(P).data.f` to it. Two lookups are equal only when their strings are equal |
| `{ literal: string \| number \| boolean \| null \| (string \| number)[] }` | Constant |

`in` takes an **array literal** on the right (`{ literal: ['admin', 'trainer'] }`). Any other right side is never
treated as a set by the prover: it matches an `in` atom whose right side is not a literal (such as a lookup,
`x in doc(/users/{actor.uid}).accountIds`) only against an identical atom. The test generator treats a lookup on the
right of `in` as a one-element array that it seeds (see rules-file.md "Generation").

### `exists` doc formats

| Store | Format | Example |
|---|---|---|
| Firestore, Storage | Path pattern with operand placeholders | `/accounts/{param.accountId}/members/{actor.uid}` |
| Postgres | `pg:<table>?<column>={<operand>}&<column>={<operand>}...`, columns sorted by name | `pg:public.team_members?team_id={resource.team_id}&user_id={actor.uid}` |

Placeholders are `{<operand>}` and must be a valid operand. Two `exists` atoms are the same only when `doc` is
string-equal, so analyzers must emit a canonical form (same column order, same operand spelling).

## Implication rules

Checkers ask "does condition C imply requirement R", via `implies(C, R, vocab)` in `logic.ts`. Both sides are first
expanded through the vocabulary (an unknown or circular `ref` becomes `opaque`). The prover is deliberately
incomplete and conservative: if it cannot prove R, the rule fails.

How `prove(c, r)` proceeds, in order: split R's `and` (all parts must hold); split C's `or` (every branch must prove R);
try each part of C's `and`; try each part of R's `or`; compare two atoms; compare two `not`s.

| Rule | Detail |
|---|---|
| Equal atoms imply each other | After normalization. `eq` and `ne` are symmetric (`a == b` equals `b == a`); a literal on the left is swapped to the right |
| `in` | `x in S` implies `x in T` when S is an array literal subset of T. `x == v` (string or number literal) implies `x in T` when v is in T. Same left operand required |
| `lt`, `gt` | Only identical atoms imply each other |
| `exists` | Only an identical `doc` implies it |
| `isNull` | Only an identical operand implies it |
| `not` | Two `not`s match only when the inner expressions are deep-equal and contain no `opaque` |
| `opaque` | Never satisfies anything, including another identical `opaque` |
| `or: []` as the condition | Vacuously implies everything. For policies this is "no policy allows it", which means denied |

### What implies `authenticated`

Only atoms that are false for an anonymous caller imply `authenticated`. An operand is **actor-dependent** when it is an `actor.*` operand or a lookup whose path contains `{actor.`:

| Atom | Implies `authenticated` |
|---|---|
| `authenticated` | yes |
| `exists` whose `doc` contains an actor placeholder (`{actor.`) | yes |
| `eq` between an actor-dependent operand and a non-null **string or number** literal | yes |
| `in` between an actor-dependent operand and a **non-empty array** literal | yes |
| `eq`/`in` where the non-actor side is not such a literal (for example `x in doc(/users/{actor.uid}).accountIds`, or a lookup without `{actor.` in its path) | no |
| `eq` to a boolean or null literal, `ne`, `lt`, `gt`, `isNull`, anything else | no |

**Anonymous caller convention.** An anonymous caller is `actor = null` (`as: null` in test cases). Every atom with
an actor operand (`actor.uid`, `actor.role`, `actor.claim.*`, an `exists` doc with an `{actor.` placeholder, or an `eq`/`in` lookup whose path has an `{actor.` placeholder) is
false for it, including `ne` and `isNull` on an actor operand. The prover is sound against this model; the
model-based property test in `packages/core/test/logic.test.ts` checks it. The table above is deliberately narrower
than the model allows (it does not count `ne` or `isNull` on an actor operand), which only makes it more conservative.

Store semantics that deny anonymous callers are NOT inferred. Analyzers for Firestore rules and Postgres RLS
(where `auth.uid()` is null for anonymous callers) must emit an explicit `{ atom: { op: 'authenticated' } }` in the
conditions of every policy that requires a signed-in caller. Without it, a rule requiring `authenticated` reports a violation.

## Path patterns

Used by Firestore and Storage targets, policy targets, `collections[].path`, and `exists` docs.

| Segment | Meaning |
|---|---|
| `literal` | Matches itself |
| `{name}` | One segment; a parameter. `name` is `[A-Za-z0-9_.]+` |
| `{name=**}` | The rest of the path, including zero segments |
| a segment containing `{` or `}` that is not one of the two forms above | Malformed. Treated as a wildcard parameter (conservative: it overlaps more) |

Functions in `paths.ts`:

| Function | Behavior |
|---|---|
| `patternsOverlap(a, b)` | True if some concrete path matches both. A rest segment on either side overlaps everything that remains |
| `alignParams(from, to)` | Maps parameter names position by position until a rest segment (`from` `{accountId}` to `to` `{id}` gives `accountId` to `id`). Used to rename `param.*` in a policy's condition into the rule target's names (`data-access` renames the params it does not align to fresh `__p<n>` names) |
| `concretize(path, value)` | Fills parameters (rest segments too) with `value(name)` |
| `normalizeTable(name)` | Adds `public.` when the name has no dot |

### Route paths and selectors

Route paths use `:name` params. For matching, `{x}`, `<x>`, `<type:x>` and `:x` are all normalized to a param, and
`{x=**}` to the `**` glob.

A rule selector (`access` target `routes:`) is one of:

| Selector | Matches |
|---|---|
| `METHOD /path` | That method (case-insensitive) and path; `*` as the method matches any method |
| `*` in a path segment | Exactly one segment (any value, including a param) |
| `**` in a path segment | Zero or more segments |
| `route:<id>` | Exactly the route with that id (`route:POST /dogs`) |

A param segment in the selector (`:id`) matches only a param segment in the route, not a literal. A selector that is
not `METHOD /path` or `route:<id>` throws.

## Call graph and `coveredBy`

`calls` holds `[caller, callee]` symbol ids. `FactIndex.coveredBy(symbol, via)` answers "does every call path into
`symbol` pass through a `via` symbol":

- A `via` entry covers itself and its members: `ts:x#Repo` covers `ts:x#Repo.update`. Matching is purely by id:
  equal, or starting with the `<via>.` prefix. Where a member boundary falls in each language's ids (a method, a
  nested function, a Go package path segment) is decided by each analyzer track, which must emit member ids as
  `<owner>.<member>` for `via` to cover them.
- Walks callers upward; a via caller stops that branch. A node with no callers (an entry point, such as a route
  handler) that has not passed a via node makes the answer false.
- A pure cycle that contains no via node is uncovered (false). A cycle that contains one is covered.
- A symbol with no callers and not in `via` is uncovered.

`visibility` and `flow` rules use it with the `in` symbol of each data op.

## Diagnostics and `unknown`

A diagnostic with severity `error` means facts may be missing. `checkRule` then reports `unknown` (instead of
pass, violation or stale). Which rules it touches depends on the target (Phase 0 rule, conservative; to be refined
per store later):

| Rule | Becomes `unknown` when | Message |
|---|---|---|
| `access` with a `{ symbol }` target | An error with `file: ''` (the analyzer crashed or returned invalid facts) | The `<analyzer>` analyzer failed |
| | The rule's `evidence` includes an id that is not in the facts, while errors exist | Evidence ... not found |
| | An error in the symbol's file or in the file of one of its `evidence` ids | `<file>` could not be read |
| Every other rule: `access` with a `routes` selector, `data-access`, `visibility`, `flow`, `invariant` | Any error diagnostic at all, in any file | `analyzer errors make this result unreliable: <file, or the analyzer name when file is ''>: <message> (+N more)` (the `(+N more)` part only when there are more errors) |

The second row is deliberately broad: these rules quantify over sets (matching routes, policies, data ops, tables),
and a file that failed to parse removes facts from that set, so the rule could pass on facts that are missing.

`unapproved-edit` takes precedence over `unknown`. Warnings never change a result.

## Analyzer contract (`analyzer.ts`)

```ts
interface Analyzer {
  name: string
  version: string
  detect(root: string, files: readonly string[], config: HoldlineConfig): boolean | Promise<boolean>
  analyze(ctx: AnalyzerContext): Promise<AnalyzerOutput>
}
interface AnalyzerContext {
  root: string; files: readonly string[]; cache: FileCache; config: HoldlineConfig
  recognizers: { id: string; recognize: VocabularyEntry['recognize'] }[]
}
type AnalyzerOutput = Omit<FactsInput, 'version' | 'analyzers'>
```

| Item | Detail |
|---|---|
| `files` | Repo-relative paths from `listFiles(root)`: `git ls-files --cached --others --exclude-standard` minus deleted files, minus any path with a segment in `node_modules .git .holdline dist build .venv vendor .next .svelte-kit`. Without git, a directory walk with the same skips. Sorted |
| `cache` | `FileCache`, see below. Bump `version` when output changes |
| `config` | `HoldlineConfig` from `.holdline/config.yaml`, loaded once per scan by `scan` (see "Project config" below) and passed to both `detect` and `analyze`. Each analyzer reads only its own section and applies its own defaults when the section is absent |
| `recognizers` | The `recognize` lists of the approved vocabulary entries (`approvedRecognizers(file)`: entries whose `approved.hash` equals `hashVocabulary(entry)` and whose `recognize` is not empty), as `{ id, recognize }`. `scan(root, analyzers, { recognizers })` passes them (default `[]`); the CLI reads them from `holdline.rules` when it scans (`holdline scan` and every command that scans), and passes none when the file is missing or invalid. An analyzer that uses them must include them in its cache key, for example by hashing the recognizers JSON together with the file content, since the same file gives different facts under different recognizers |
| Output | An object of the list fields only. `scan` adds `version: 1` and `analyzers: [{ name, version }]` and validates with `parseFacts` |
| Core imports no language tooling | Go and Python helpers run as child processes and print facts JSON on stdout |

### Project config (`.holdline/config.yaml`)

Optional. `loadConfig(root)` in `config.ts` reads `<root>/.holdline/config.yaml`; a missing file means `{}`. Sections:

| Section | Keys | Notes |
|---|---|---|
| `postgres` | `migrations` (glob list), `dialect` (`supabase` or `plain`) | |
| `firestore` | `rules` (glob list) | |
| `storage` | `rules` (glob list) | |

A glob list is a non-empty array of non-empty strings. A glob is a root-relative POSIX pattern: an absolute glob (leading `/` or `\`, or a drive letter) or one with a `..` segment is a `ConfigError`. A section with no body (`postgres:` alone, YAML null) is an empty section (`{}`). Unknown keys inside a known section are an error. Unknown top-level
sections are kept (so a later analyzer can read its own section). Bad YAML or bad values throw `ConfigError`, whose
message names `.holdline/config.yaml`; `holdline` exits 2 on it. `scan` loads the config before it runs any analyzer and
does not catch a `ConfigError`: it is a config error, not an analyzer failure, so it never becomes a diagnostic.

### Matching globs (`files.ts`)

`matchFiles(files, globs)` returns the files that match any glob, sorted and without duplicates. Analyzers match
their config globs against `ctx.files` (the git-aware list), never the disk, so ignored and skipped files never match.

| Glob syntax | Matches |
|---|---|
| `*` | Any characters within one path segment (`*.sql` matches `schema.sql`, not `db/a.sql`) |
| `**` as a whole segment | Any number of segments, including zero (`**/firestore.rules` matches `firestore.rules` and `packages/app/firestore.rules`; `db/**/*.sql` matches `db/a.sql` and `db/x/y/b.sql`) |
| `?` | One character other than `/` |
| anything else | Itself |

### FileCache (`cache.ts`)

| Member | Behavior |
|---|---|
| `get<T>(analyzer, version, content)` | `Promise<T \| undefined>`: the cached value, or `undefined` when there is none or it cannot be read |
| `set(analyzer, version, content, value)` | `Promise<void>`: writes `value` as JSON |
| Path | `.holdline/cache/files/<analyzer>/<sha256(version + "\0" + content)>.json` under the repo root |

The key is the file content, not its path, so a renamed file with the same content hits the cache.

`scan(root, analyzers, opts?)` returns `{ facts, ran }` and never throws for analyzer problems (it throws `ConfigError` for a bad
config file, see "Project config"). Each analyzer failure becomes a facts
part with one diagnostic `{ analyzer, file: '', severity: 'error', message }`:

| Failure | Message prefix |
|---|---|
| `detect` throws | `analyzer failed during detect:` |
| `analyze` throws | `analyzer failed:` |
| `analyze` returns facts that fail the schema | `invalid facts:` followed by the zod error |

Analyzers whose `detect` returns false are skipped and not listed in `ran`. For problems with a single file, an
analyzer should emit a diagnostic with that file's path and keep going. Today any error diagnostic makes every
set-quantified rule `unknown`, and a `symbol`-target access rule only when the error is in its own file or its
evidence's files (see "Diagnostics and `unknown`"). An analyzer crash (`file: ''`) also makes `holdline check` exit 3
after printing its results (see rules-file.md "`holdline check` and exit codes").

## Postgres analyzer (`packages/analyzer-postgres`)

Name `postgres`, version `0.1.0`. Sources: `packages/analyzer-postgres/src/*.ts`. Worked examples:
`examples/golden-supabase` (Supabase dialect, tables and policies) and `examples/golden-ts-postgres` (plain dialect,
tables only).

The analyzer applies the project's migrations to an in-memory Postgres (PGlite 0.5.11, Postgres 18) and reads the
catalog. It parses SQL with `libpg-query` 18 only for statement locations and policy expressions. Both libraries
load lazily (dynamic `import()`) when `analyze` or `applyMigrations` runs; importing the package loads neither.

### Detection and dialect (`detect.ts`)

| Item | Behavior |
|---|---|
| Migrations | The `postgres.migrations` globs when set, otherwise the default globs, matched against `ctx.files` with `matchFiles` |
| Default globs | `supabase/migrations/*.sql`, `prisma/migrations/*/migration.sql`, `drizzle/*.sql`, `migrations/*.sql`, `db/migrations/*.sql` |
| Apply order | All matched paths sorted together. Every supported tool names migrations so that sorted order is apply order |
| `detect` | True when `postgres.migrations` is set, a file matches, or `prisma/schema.prisma` exists (so the analyzer can say why there are no tables) |
| Dialect | `postgres.dialect` when set. Otherwise `supabase` when a matched path matches `supabase/migrations/*.sql`, else `plain`. A custom glob over Supabase migrations in another folder gives `plain` unless `dialect: supabase` is set |

### Applying migrations (`migrate.ts`, `shim.ts`)

1. Start a fresh PGlite with the contrib extensions `uuid_ossp` and `pgcrypto` loaded. Any other extension fails
   its migration (`extension "postgis" is not available`).
2. For dialect `supabase`, run the shim below.
3. Run each migration in its own transaction. Stop at the first failure: later migrations would run against the wrong schema.
4. After each migration, restore the dialect's `search_path`: `"$user", public, extensions` for `supabase`, PGlite's
   startup value (`public`) for `plain`. A session-level `SET search_path` or pg_dump's
   `set_config('search_path', '', false)` would otherwise change how later migrations resolve names and how the
   catalog prints them.

An error outside a migration (the shim, reading the `search_path`) closes the database and is thrown.

The Supabase shim:

| Object | Definition |
|---|---|
| Schemas | `auth`, `storage`, `extensions` |
| Extensions | `uuid-ossp` and `pgcrypto`, created in schema `extensions` |
| Roles | `anon` and `authenticated` (`nologin noinherit`), `service_role` (also `bypassrls`) |
| Privileges | `usage` on `public`, `auth`, `storage` and `extensions` to all three roles. Default privileges in `public` grant all on tables, sequences and functions to all three. The shim's own tables get no grants |
| Claims | `nullif(current_setting('request.jwt.claims', true), '')`: a rolled-back local setting reads as `''` |
| `auth.jwt()` | The claims as `jsonb` |
| `auth.uid()` | `(<claims>::json ->> 'sub')::uuid` |
| `auth.role()` | `<claims>::json ->> 'role'` |
| Tables | `auth.users (id uuid primary key, email text)`; `storage.buckets (id text primary key, name text not null, public boolean not null default false)`; `storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets, name text, owner uuid, metadata jsonb)` |
| `search_path` | `"$user", public, extensions` for the session, restored after each migration |

The plain dialect runs no shim and keeps PGlite's default `search_path` (restored after each migration).

`applyMigrations` applies a project's migrations exactly as the analyzer does, for the database test runner:

```ts
function applyMigrations(root: string, config: HoldlineConfig, files?: readonly string[]): Promise<MigrationRun>
interface MigrationRun {
  db: PGlite                                    // the caller closes it, after a failure too
  dialect: 'supabase' | 'plain'
  migrations: { path: string; sql: string }[]   // in apply order
  failure?: { file: string; line?: number; message: string } // the first failing migration; later ones were not applied
}
```

`files` defaults to `listFiles(root)`. A failing migration is returned as `failure`, never thrown. The package also
exports `detectPostgres`, `findMigrations`, `readMigrations`, `runMigrations`, `analyzeMigrations` and `factsFromDatabase`.

### Tables (`tables.ts`)

One table per ordinary or partitioned table (`relkind` `r` or `p`) outside `information_schema` and `pg_*`, and for
dialect `supabase` outside `auth`, `storage` and `extensions`. Sorted by schema, then name.

| Field | As built |
|---|---|
| `id`, `name` | `pg:<schema>.<table>`, `<schema>.<table>`, exactly as Postgres stores the names |
| `columns` | In column order. `nullable` is `not attnotnull` |
| `columns[].type` | `format_type`, shortened: `timestamp(p) with time zone` → `timestamptz(p)`, `timestamp(p) without time zone` → `timestamp(p)`, the same for `time` and `timetz`, `character varying` → `varchar`, `character` → `char`. Everything else as Postgres prints it (`integer`, `numeric(10,2)`, `text[]`, an enum's type name) |
| `columns[].default` | `pg_get_expr` of the default. A quoted literal loses its cast (`'member'::member_role` → `'member'`); anything else stays verbatim (`gen_random_uuid()`, `now()`, `0`) |
| `primaryKey` | In key order |
| `foreignKeys` | Columns in key order; `references.table` is `<schema>.<table>` |
| `uniques` | Unique constraints, then unique indexes that back no constraint and are neither partial nor on expressions (key columns only, not `INCLUDE`) |
| `checks` | `{ name, expr }`: `pg_get_constraintdef` without the outer `CHECK (…)` and without a trailing ` NOT VALID`, in Postgres' own spelling (`(amount > 0)`) |
| `enums` | One per column whose type is an enum, labels in sort order |
| `rlsEnabled` | `relrowsecurity`. `FORCE ROW LEVEL SECURITY` is not read |
| `location` | The latest `CREATE TABLE` (see "Locations") |

Foreign keys, unique constraints and checks are each ordered by first key column, then constraint name; extra unique
indexes by first key column, then index name. Postgres 18's NOT NULL constraints are ignored: nullability comes from the column.

### Policy conditions (`normalize.ts`, `operand.ts`, `atoms.ts`, `subquery.ts`, `inline.ts`)

Each condition is `pg_get_expr(polqual | polwithcheck, polrelid)`, parsed as `SELECT <expr>`. The catalog is read in
one transaction with a local `search_path` of `"$user", public, extensions` (`supabase`) or `public` (`plain`),
whatever the session has, so names print relative to the schemas the normalizer resolves through. The tables below are the
whole mapping. Anything else becomes `{ opaque: <SQL text> }` for the smallest part that could not be mapped. A
mapping may allow more than the SQL, never less; `packages/analyzer-postgres/test/soundness.test.ts` checks this
against real Postgres.

**Operands**

| SQL | Operand |
|---|---|
| `auth.uid()` | `actor.uid` (Supabase only) |
| `auth.role()` | `actor.role` (Supabase only) |
| `auth.jwt() ->> 'k'`, `(auth.jwt() -> 'a') ->> 'k'` | `actor.claim.k`, `actor.claim.a.k` (Supabase only; keys `[A-Za-z0-9_]+`) |
| `(SELECT <x>)` with no `FROM` or anything else | The operand of `<x>` |
| `auth.uid()::text`, `<claim>::text` | Unchanged. Any other cast on a non-constant is not an operand |
| A column of the policy's table, bare or qualified by table or schema and table | `resource.<c>` in `USING`, `incoming.<c>` in `WITH CHECK`. Only for names matching `[A-Za-z0-9_]+`: any other (`"owner-id"`, `créé`) is not an operand, since core's operand pattern can't hold it |
| A helper function's parameter, by name or `$n` | The operand the caller passed |
| A constant (string, integer, decimal, `true`, `false`, `NULL`) | `{ literal }`, with a cast applied as below |

**Casts on constants**

| Cast | Result |
|---|---|
| To `int2`, `int4`, `int8`, `integer`, `smallint`, `bigint` | A number, when the value (or numeric string) is an integer. Otherwise not a constant |
| To `numeric`, `decimal`, `float4`, `float8`, `real` | A number, from a number or a numeric string |
| A number or boolean to `text`, `varchar`, `bpchar`, `char`, `character`, `name` | Its text (`1.50` as written, `'true'`) |
| To `bool` or `boolean` | Only from a boolean |
| A string to `uuid` | The string, lowercased |
| To `citext`, any cast with a type modifier (`::varchar(3)`), any array cast (`'{a,b}'::text[]`) | Not a constant |
| A string to any other type (an enum, `date`) | The string unchanged |
| A number or boolean to any other type | Not a constant |
| `NULL` to any type | `null` |

**Conditions**

| SQL | Expr |
|---|---|
| `AND`, `OR`, `NOT` | `and`, `or`, `not` |
| `true`, `false` | `{ and: [] }`, `{ or: [] }` |
| `a = b`, `a <> b` | `eq`, `ne` (see "Comparisons with the caller") |
| `a < b`, `a > b` | `lt`, `gt`, only when exactly one side is a number literal |
| `a IN (v, …)`, `a = ANY (ARRAY[v, …])` | `in` with an array literal. Every `v` is a string or number constant; a cast around the whole array is opaque |
| `auth.uid() IS NULL`, `auth.uid() IS NOT NULL` | `not(authenticated)`, `authenticated` |
| `x IS NULL`, `x IS NOT NULL` for any other operand | `isNull`, `not(isNull)`. Opaque when `x` is another `actor.*` operand |
| `(SELECT <expr>)` | `<expr>` |
| `EXISTS (…)`, `x IN (SELECT …)` | `exists`, see "Subqueries" |
| A call to a function | Its inlined body, see "Helper functions" |

**Comparisons with the caller.** A Supabase anonymous caller still carries the anon key's claims (`role` = `anon`,
`iss`, `ref`, `aud`, `iat`, `exp`), while the facts model it as "no actor", for which every actor atom is false.
So comparisons on those values are mapped only where both agree:

| Comparison | Expr |
|---|---|
| `actor.role` or `actor.claim.role` `=` a string literal | `eq`; `= 'anon'` gives `not(authenticated)` |
| `actor.role` or `actor.claim.role` `IN` a list of strings without `'anon'` | `in` |
| Any other comparison on the role (`<>`, `<`, a list with `'anon'`, a non-string, a column) | opaque |
| Any comparison on `actor.claim.iss`, `.ref`, `.aud`, `.iat`, `.exp` (and their sub-keys) | opaque |
| Another claim `=` or `<>` a plain string literal; `IN` a list of plain strings | `eq`, `ne`, `in` |
| Another claim with `<` or `>`, or against a column, a number, or a string that reads as `true`, `false`, `null` or a number, or that starts (after spaces) with `{`, `[` or `"` | opaque: `->>` yields text, but the claim's JSON value may be a boolean, number or null, and an object, array or nested string comes back as its JSON text (`{}`) |

**Subqueries.** `EXISTS (SELECT … FROM t WHERE t.a = <x> AND t.b = <y>)` becomes `exists(pg:<schema>.t?a={x}&b={y})`.
`<x> IN (SELECT t.c FROM t WHERE …)` becomes the same with `c={x}` added. All of these must hold, otherwise the subquery is opaque:

| Requirement | Why |
|---|---|
| Positive position: an even number of `NOT`s above it, counting through inlined helpers | Under RLS on `t` the subquery may see fewer rows, so `exists` is too weak to negate |
| One table in `FROM`: no join, no `ONLY`, no column alias list (`t m(a, b)`) | |
| No `GROUP BY`, `HAVING`, `WITH`, `DISTINCT`, `LIMIT`, `OFFSET`, `ORDER BY`, `FOR UPDATE`, `WINDOW` or set operation | |
| `EXISTS` selects only constants, `*` or plain columns | `SELECT count(*)` returns a row even with no match |
| `IN` uses `=`, selects one column of `t`, and its left side is an outer operand as below | |
| `WHERE` is an `AND` of `<column of t> = <outer operand>` (either order), and no column equals two different operands. At least one condition in total: an `IN` supplies its own `c={x}`, so `x IN (SELECT t.c FROM t)` needs no `WHERE` | The doc format holds only operand placeholders, so a literal (`m.role = 'admin'`) makes it opaque |
| No outer operand is a literal or an `actor.*` operand other than `actor.uid` | An `exists` with `{actor.…}` is false for an anonymous caller, but the role and the anon-key claims are set for one; and SQL compares a claim's text (`->>`) with the column, while its JSON value may be a number or a boolean |
| The table resolves: schema-qualified, or the first schema on the search path that has it | `public`, `extensions` for Supabase; `public` for plain; a helper's own `SET search_path` inside its body |
| Every schema, table and column name in the doc matches `[A-Za-z0-9_]+` | Others (`&`, `=`, `?`, `{`, `}`) could make the doc ambiguous |

Inside a subquery, its table's columns win over the policy table's, as in SQL. A column of an enclosing subquery's
table makes the condition opaque. Doc columns are sorted by name.

**Helper functions.** A call is replaced by the function's body when all of these hold:

| Requirement | Detail |
|---|---|
| `LANGUAGE sql`, `STABLE` or `IMMUTABLE`, and the body is one `SELECT <expr>` with nothing else | |
| The name resolves | Schema-qualified, or the first schema on the search path with that name and arity. A name that exists in `pg_catalog` is never inlined: Postgres searches `pg_catalog` first |
| One function has that name and arity | Overloads with the same arity are not inlined |
| Every argument is an operand, and the call has no `*`, `DISTINCT`, `OVER`, `VARIADIC`, `FILTER` or `ORDER BY` | |
| At most 10 levels of nesting | |

Inside the body, parameters (by name or `$n`) are the caller's operands, the policy's table is not in scope, and the
function's own `SET search_path` (without `$user`, `pg_temp` and `pg_catalog`) replaces the search path. Each inlined
helper is listed as `schema.name` in the policy's `functions`, also when its body ended opaque.

In the plain dialect `auth.uid()`, `auth.jwt()` and `auth.role()` are not mapped. If the migrations define them, they
are inlined like any other helper.

### Policies (`policies.ts`, `anon.ts`)

One policy fact per `pg_policy` row on an emitted table and per op: `id` `pg:<schema>.<table>#policy:<name>` (the
same id for each op of a row), `store` `pg-rls`, `target` `<schema>.<table>`, `ops` one op, `functions` sorted,
`evidence` the latest `CREATE POLICY`.

| `polcmd` | Ops | Condition |
|---|---|---|
| `r` SELECT | `read`, `list` | `USING` (on `resource.*`) |
| `a` INSERT | `create` | `WITH CHECK` (on `incoming.*`) |
| `w` UPDATE | `update` | Its own `USING`, AND the OR of the `WITH CHECK` of every permissive UPDATE policy on the table. Postgres ORs the two kinds of clause separately |
| `d` DELETE | `delete` | `USING` |
| `*` ALL | all five | As above, per op |

A missing clause is `TRUE`. `WITH CHECK` defaults to `USING`.

**Roles.** Each condition `c` is wrapped for the callers its roles cover. A signed-in Supabase caller has the role
`authenticated`, an anonymous one `anon`. A policy covers a caller when `polroles` holds `PUBLIC` or a role whose
privileges the caller's role has, `pg_has_role(<caller role>, <policy role>, 'USAGE')`, which is how Postgres decides
whether a policy applies. So a custom role granted to `authenticated` `WITH INHERIT TRUE` covers signed-in callers. The
shim's `anon` and `authenticated` are `NOINHERIT`, as in Supabase, so a plain `GRANT editors TO authenticated` does not
(nor does it in Postgres). `readCatalog` returns this as `coversSignedIn` and `coversAnon` on each policy row.

| Dialect and coverage | Permissive | Restrictive |
|---|---|---|
| Supabase: covers both callers (`public`, both roles, or roles they inherit) | `c` | `c` |
| Supabase: covers signed-in callers only | `and[authenticated, c]` | `or[not(authenticated), c]` |
| Supabase: covers anonymous callers only | `and[not(authenticated), c]` | `or[authenticated, c]` |
| Supabase: covers neither (`service_role`, a custom role neither inherits) | Skipped, with a warning | Skipped, with a warning |
| Plain: includes `public` | `c` | `c` |
| Plain: only other roles | `c` (the caller may have that role) | Dropped (the caller may not have it) |

Every restrictive condition for a table and op is ANDed into each permissive policy's condition for the same table
and op. Dropping a restrictive policy only allows more. With no permissive policy there is no fact, which means denied.

**Sign-in.** The final condition is evaluated for an anonymous caller, three-valued: `authenticated` is false; a
comparison or `isNull` with an actor operand is false, except the role and the anon-key claims; an `exists` whose doc
has `{actor.` is false; `opaque` is unknown. When the condition is certainly false, `authenticated` is added as its
first conjunct (unless its top-level `and` already has one). A condition such as `owner_id = auth.uid()` therefore
gets `authenticated`; `auth.role() = 'admin'` does not.

### Locations and symbols (`locations.ts`, `facts.ts`)

Each migration is parsed with `libpg-query`. A statement's line is the line of its first token after whitespace and
comments. A table is located at its latest `CREATE TABLE` and a policy at its latest `CREATE POLICY`, across all
migrations in apply order. Unqualified names count as `public`. Other statements (`ALTER TABLE`, `CREATE TABLE AS`)
give no location. A migration the parser rejects gives none. The schema itself always comes from the catalog.

Symbols: one `table` symbol per table and one `policy` symbol per policy id, `lang` `sql`, with the location when
there is one. No column symbols.

### Diagnostics

| When | Severity | `file` | Message |
|---|---|---|---|
| A migration fails | error | The migration | The Postgres error, plus ` (line N)` when Postgres gives a position. The output holds only this diagnostic: no tables, symbols or policies |
| `postgres.migrations` is set and matches nothing | error | `.holdline/config.yaml` | `postgres.migrations matches no files` |
| Only `prisma/schema.prisma`, no migrations and no config | warning | `prisma/schema.prisma` | `no SQL migrations found; run prisma migrate or point holdline at a schema dump` |
| A Supabase policy covers neither `anon` nor `authenticated` callers | warning | The policy's migration (`''` without a location) | `policy "<name>" on <schema>.<table> applies only to roles <roles>; Holdline models the anon and authenticated roles, so it was skipped` |

### Cache

The whole output is one `FileCache` entry: analyzer `postgres`, version `0.1.0`, content
`JSON.stringify({ dialect, migrations: [{ path, sql }] })`. A scan whose migrations, paths and dialect are unchanged
starts neither PGlite nor the parser. A cached migration failure stays until a migration changes. The analyzer does
not use `recognizers`.

### Known limits

| Limit | Effect |
|---|---|
| Partitions | Each partition is also emitted as its own table |
| Generated columns | The generation expression appears as the column's `default` |
| `uniques` | Constraints come before indexes; they are not merged by column position |
| `CHECK … NO INHERIT` | The trailing `NO INHERIT` stays in `expr` |
| Numbers | Integers above 2^53 lose precision; `float4` rounding is not modelled |
| Search path | Relation names don't resolve through `pg_temp` or an implicit `pg_catalog`; an explicit `pg_catalog` position in a helper's `SET search_path` is dropped |
| Conditions | A signed-in wrap plus a restriction can repeat `authenticated` in nested `and`s (harmless) |
| Typed comparisons | Comparing two columns (an `exists` doc's `c={resource.x}`, `a = b`) assumes plain equality. `citext`, `bpchar` padding and nondeterministic collations are not modelled |
| Locations | Nested `/* /* */ */` comments before a statement can shift its reported line |
| Opaque text | `{ opaque }` text is cut from the expression by token positions, best effort: parentheses inside strings and `E''` or dollar-quoted strings can widen or cut it. It is shown to people, never compared |
| Supabase `db pull` | A migration that references objects the shim lacks (`pg_graphql`, `supabase_vault`, `pg_stat_statements`, the `graphql` or `vault` schemas, roles such as `supabase_admin`) fails with an error diagnostic, so its rules become unknown |

## Firestore and Storage analyzer (`packages/analyzer-firestore`)

Reads Firestore and Storage security rules and emits `policies`, `symbols` (kind `match`) and `diagnostics`. It emits no
`collections`. Sources: `discover.ts` (finding rules files), `lexer.ts`, `parser.ts`, `parse-expr.ts`, `parse-path.ts`, `ast.ts`
(parsing), `expand.ts` (targets, ops, ids), `scope.ts` (scopes, envs, budgets), `inline.ts`, `condition.ts`, `value.ts`, `compare.ts`,
`lookup-path.ts` (normalization), `simplify.ts`, `analyze-file.ts` (one file's facts), `analyzer.ts`, `index.ts`. No model, no network.
Name `firestore`, version `0.1.0`.

### Discovery

| Item | Detail |
|---|---|
| `detect` | True when `firestore.rules` or `storage.rules` config globs are set, or discovery finds a rules file or an error |
| Config globs | `firestore.rules` / `storage.rules` globs in `.holdline/config.yaml` replace the defaults for that store only. A glob list that matches no file gives an `error` on `.holdline/config.yaml` |
| Defaults | For a store with no globs: `firestore.rules` / `storage.rules` at the root, and the `rules` path of every `firebase.json` at any depth. Each path is relative to its own `firebase.json`. The `firestore` and `storage` keys may be an object or an array of objects (several databases or buckets) |
| `firebase.json` errors | `invalid JSON: <reason>`; `could not read: <reason>`; `points at <path>, which is not in the repository` (outside the repo, `..` or `../...`, or a file not in the repo). Each leaves a store's rules incomplete, so it is an `error`. Other valid JSON shapes are ignored |
| Files | Sorted and deduplicated. Each is analyzed on its own and cached |

### Parse errors and diagnostics

| Case | Diagnostic |
|---|---|
| Parse error | `error`, message `line L, column C: <message>`. The file yields no policies, so the rules that depend on them become `unknown` |
| File cannot be read | `error`, `could not read: <reason>` |
| `service` other than `cloud.firestore` and `firebase.storage` | `warning`, skipped |
| No `service` block | `warning`, `no service block` |
| A `match` holding allows, or a leaf `match`, whose path cannot match `/databases/{database}/documents` (Storage: `/b/{bucket}/o`) | `warning`, the path is kept in full. A prefix split across nested matches is recognized (see Target) |
| A function declared twice in one block | `warning`, the last one is used |
| Discovery problems | `error`, see Discovery |
| Analysis of one file throws (e.g. a stack overflow on thousands of nested parentheses) | `error`, `analysis failed: <message>`. That file yields no policies; other files are kept. Not cached |

Only `error` makes rules `unknown` (see "Diagnostics and `unknown`").

### Policies and symbols

| Item | Detail |
|---|---|
| Policy | One per `allow` statement and op. `ops` has that one op. `evidence` is the `allow` line. `functions` lists the user functions the condition inlined or referenced, sorted |
| Ops | `read` gives `read` and `list`; `get` gives `read`; `list` gives `list`; `write` gives `create`, `update`, `delete`; `create`, `update`, `delete` give themselves |
| Target | The concatenated `match` paths with the prefix removed. The prefix is the first three segments when the first is `databases` (Storage: `b`) or a `{x}` wildcard, the second is any single segment (`{database}`, `(default)`, `my-app.appspot.com`), and the third is `documents` (Storage: `o`) or a `{x}` wildcard. A rest wildcard (or a `$(...)` segment) within the first three segments, after segments that match, can reach every document: the target is `/{<name>=**}` (`/databases/{db}/{rest=**}` and `/{path=**}` give `/{rest=**}` and `/{path=**}`). Any other path is kept in full, with a warning. `{x=**}` stays. A `$(expr)` segment in a match path becomes a rest wildcard `{_interpN=**}` (it may span segments, so it overlaps more, never less). An allow directly in the service or prefix match has target `/` |
| Policy id | `<store>:<target>#<op>@<line>`. A second allow with the same id gets `:<col>` added (`...@12:9`) |
| Symbol | One `match` symbol per distinct (store, target), id `<store>:<target>`, at the first `match` line that gives it. `lang` is `firestore` or `storage` |
| Condition | `allow ...;` (no `if`) is `{ and: [] }`; `if false` is `{ or: [] }`; otherwise the normalization below, then a cleanup that flattens nested `and`/`or`, drops duplicate members that hold no `opaque`, and turns `not(not x)` into `x` |

### Normalization

Soundness invariant: if Firestore evaluates the source condition to true, the emitted `Expr` is not false in the
model (an absent field is `null`; an atom that reads the actor is false for an anonymous caller). Every mapping is exact on
non-error values and logic maps structurally. A condition that cannot be mapped exactly becomes `{ opaque }`, never a guess.

Functions are inlined with lexical scope: parameters are bound to the call's arguments in the caller's scope, `let`s in order.
A recursive call is `opaque`; so is a call past depth 20, or past 1000 inlinings in one condition (this stops exponential growth
when functions call each other several times). Each parameter or `let` reference re-reads its bound expression; past 10000 such
resolutions in one condition a reference is `opaque` (`let a1 = a0 && a0; let a2 = a1 && a1; ...` would otherwise double per `let`). A user function named like a built-in (`get`, `exists`, `getAfter`, `existsAfter`,
`debug`, `bool`, `bytes`, `float`, `int`, `string`, `path`) is never inlined, and its calls are `opaque`.

| Rules expression | Expr |
|---|---|
| `request.auth != null` / `== null` | `authenticated` / `not(authenticated)` |
| `request.auth.uid` | `actor.uid` |
| `request.auth.token.k` | `actor.claim.k` |
| `resource.data.f` (Storage: `resource.metadata.f`) | `resource.f` |
| `request.resource.data.f` (Storage: `request.resource.metadata.f`) | `incoming.f` |
| `.data` in a Storage file, `.metadata` in a Firestore file | `opaque` |
| Wildcard variable `x` | `param.x` |
| Rest wildcard `{x=**}` used as an operand or path segment | `opaque` (it holds a path, not a string) |
| `get(P).data.f` (Storage: `firestore.get(P).data.f`) | `doc(P').f` |
| `exists(P)` (Storage: `firestore.exists(P)`) | `exists(P')` |
| `==` `!=` `<` `>` | `eq` `ne` `lt` `gt` |
| `x in [literals]` | `in` with an array literal |
| `x in y` where `y` is an operand | `in` with the operand on the right; the prover matches it by identity only |
| `&&` `\|\|` `!` | `and` `or` `not` |
| `true` / `false` | `{ and: [] }` / `{ or: [] }` |
| `a ? b : c` | `or[and[a, b], and[not a, c]]` |
| A bare boolean value (`resource.data.published`) | `eq(<operand>, true)`; exact, since a rules condition must be a boolean |
| `x.get('f', d)` on a map | `x.f` when `d` is `null` (the model's absent value), or when neither `d` nor `null` satisfies the comparison against a literal. Otherwise `opaque`. `<` and `>` with a fallback map only when both values are numbers. A non-null fallback on both sides, or on the right of `in`, is `opaque` (a `null` default is no fallback) |
| Integer literal | A literal; past 2^53 it is `opaque` |
| Float literal | A literal; a non-finite one (`1.0e999`) is `opaque` |
| Anything else | `opaque` with the source text |

Always `opaque`: `<=`, `>=`, `is`; `request.auth` compared with anything but `null`; `getAfter(P)` and `existsAfter(P)` (they read
the document after the write, so they must never equal `get(P)`); dotted keys (`data['a.b']`, `get('a.b', d)`, which name one
top-level field where `resource.a.b` would read a nested one); methods and functions with no atom (`hasAny`, `hasAll`, `hasOnly`,
`size()`, `matches`, `request.time`, string building).

**`authenticated` is per atom.** An atom that reads `request.auth` is `and[authenticated, atom]`. That covers an actor operand, an
`exists` whose path holds `{actor.`, and a lookup (as an operand) whose path does. It is not added to the whole condition: for
`resource.data.public == true || request.auth.uid == resource.data.owner` Firestore allows an anonymous read of a public document,
and a whole-condition `authenticated` would deny it in the model. `request.auth.token.k` counts as reading `request.auth`.

**Lookup paths (`P'`).** `P'` is the document path with the prefix removed and each `$(...)` replaced by `{operand}`. The database
segment (`$(database)`, `(default)`) is not read and is removed: rules read only their own database, and Storage's `firestore.*`
reads `(default)`. Each segment must be one literal or one interpolation of `actor.uid`, `actor.claim.*`, `resource.<f>`,
`incoming.<f>` (one field deep), `param.<x>`, or a string or integer literal. Anything else (a float, a rest wildcard, a computed
string, a nested lookup such as `$(get(...).data.x)`) makes the lookup `opaque`.

**Vocabulary.** A call to a zero-parameter function that an approved `firestore-function` recognizer names becomes `{ ref: <id> }`
in condition position, only when the file declares that name exactly once (a second declaration may have a different body than the
one approved). In value position the function is inlined. Functions with parameters are always inlined. Recognition is by
name: editing the body of the one recognized function keeps emitting the ref, and re-approving the vocabulary entry is the guard.

**Opaque text** is the source of the smallest sub-expression that could not be mapped, whitespace collapsed, wrapping parentheses
removed.

### Cache

Key: the file path, the approved recognizers and the file content, under the analyzer version (`FileCache`, see above).

### Scan summary

After `Scanned with ...`, `holdline scan` prints one block per rules file (`packages/cli/src/format/policy-summary.ts`), files sorted,
nothing when there are no Firestore or Storage policies:

```
firestore.rules: 9 policies, 1 opaque sub-condition
  opaque: <text> (line 12)
```

The count is distinct (opaque text, line) pairs. One `opaque:` line per distinct text, lines sorted, text cut at 120 characters.

### Tests

`packages/analyzer-firestore/test/soundness.test.ts` holds a reference interpreter of the rules subset (Firestore's error
semantics) and an `Expr` evaluator with absent = `null`. For each of 37 normalization rows it runs 200 random worlds and checks the
invariant, and that the row is exactly true somewhere Firestore allows. `test/emulator/` compares the Firestore emulator with the
interpreter and the `Expr`; it is skipped, with the reason in the test title, when `firebase-tools` or Java 21 or newer is missing.
Storage rows are checked against the model only.

## Conventions for fixtures and analyzers

From `examples/golden-ts-postgres/README.md`. Analyzers must produce facts equivalent to `fixtures/facts.json`.

1. Filters reference the function's own parameters (`param.teamId`), not values from callers. Resolving a
   parameter back to the actor across calls is a later analyzer decision.
2. A `where` clause is a filter for every op, writes included (for example `update` filtered by
   `resource.id = param.id`).
3. Every class or function referenced by a rule or a call edge is a symbol (including the class `DogRepository`,
   which a `flow` rule can name in `via`).
4. `location.line` is the declaration line of the symbol.

## Worked example

From `fixtures/facts.json`. Express route with middleware, a guard on the route, a repository method and its call edge:

```json
{ "id": "route:POST /dogs", "method": "POST", "path": "/dogs",
  "handler": "ts:src/routes/dogs#createDog",
  "middleware": ["ts:src/middleware/auth#requireAuth", "ts:src/middleware/auth#requireRole"],
  "framework": "express" }

{ "at": "ts:src/middleware/auth#requireAuth", "requires": { "atom": { "op": "authenticated" } } }
{ "at": "route:POST /dogs",
  "requires": { "atom": { "op": "in", "left": "actor.role", "right": { "literal": ["trainer", "admin"] } } } }

{ "in": "ts:src/repositories/dogs#DogRepository.findById", "store": "postgres", "target": "public.dogs", "op": "read",
  "filters": { "and": [
    { "atom": { "op": "eq", "left": "resource.id", "right": "param.id" } },
    { "atom": { "op": "isNull", "operand": "resource.deleted_at" } } ] } }

["ts:src/routes/dogs#getDog", "ts:src/repositories/dogs#DogRepository.findById"]
```

`POST /dogs` is checked against its guard chain: the route's own guard, then each middleware's, then the handler's.
Here that chain proves `authenticated` (from `requireAuth`, and also from the `in actor.role` atom) and
`actor.role in [trainer, admin]`.
