# Fact graph reference

The fact graph is what every analyzer emits and every checker reads. This page describes the code as built.
Sources: `packages/core/src/facts.ts`, `expr.ts`, `paths.ts`, `logic.ts`, `fact-index.ts`, `analyzer.ts`, `scan.ts`.
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
| `ops` | Op[] (at least 1) | | Firestore `write` is expanded to `create`, `update`, `delete`; `read` to `read` and `list` |
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
| Firestore match | `firestore:<path pattern>` | `firestore:/accounts/{accountId}/dogs/{dogId}` |
| Storage match | `storage:<path pattern>` | `storage:/accounts/{accountId}/files/{path=**}` |

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
treated as a set.

### `exists` doc formats

| Store | Format | Example |
|---|---|---|
| Firestore, Storage | Path pattern with operand placeholders | `/accounts/{param.accountId}/members/{actor.uid}` |
| Postgres | `pg:<table>?<column>={<operand>}&<column>={<operand>}...` | `pg:public.team_members?team_id={resource.team_id}&user_id={actor.uid}` |

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
  detect(root: string, files: readonly string[]): boolean | Promise<boolean>
  analyze(ctx: AnalyzerContext): Promise<AnalyzerOutput>
}
interface AnalyzerContext { root: string; files: readonly string[]; cache: FileCache }
type AnalyzerOutput = Omit<FactsInput, 'version' | 'analyzers'>
```

| Item | Detail |
|---|---|
| `files` | Repo-relative paths from `listFiles(root)`: `git ls-files --cached --others --exclude-standard` minus deleted files, minus any path with a segment in `node_modules .git .holdline dist build .venv vendor .next .svelte-kit`. Without git, a directory walk with the same skips. Sorted |
| `cache` | `FileCache`, see below. Bump `version` when output changes |
| Output | An object of the list fields only. `scan` adds `version: 1` and `analyzers: [{ name, version }]` and validates with `parseFacts` |
| Core imports no language tooling | Go and Python helpers run as child processes and print facts JSON on stdout |

### FileCache (`cache.ts`)

| Member | Behavior |
|---|---|
| `get<T>(analyzer, version, content)` | `Promise<T \| undefined>`: the cached value, or `undefined` when there is none or it cannot be read |
| `set(analyzer, version, content, value)` | `Promise<void>`: writes `value` as JSON |
| Path | `.holdline/cache/files/<analyzer>/<sha256(version + "\0" + content)>.json` under the repo root |

The key is the file content, not its path, so a renamed file with the same content hits the cache.

`scan(root, analyzers)` returns `{ facts, ran }` and never throws for analyzer problems. Each failure becomes a facts
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
