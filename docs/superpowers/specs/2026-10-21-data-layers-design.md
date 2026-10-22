# Holdline Phase 1: Data Layers

**Status:** Step 0 and Tracks A, B and C implemented (2026-10-21). Section 1 item 2 on the golden apps is still open; see [As built (step 0)](#as-built-step-0), [As built (Track A)](#as-built-track-a), [As built (Track B)](#as-built-track-b) and [As built (Track C)](#as-built-track-c).

**Feature:** [Holdline feature and core design](2026-10-21-holdline-design.md) in this repo. This spec covers Phase 1 (spec 2 in the feature spec's table): the Postgres and Firestore/Storage analyzers and the database test runner.

**Contracts this builds on:** [fact graph](../../reference/facts.md) and [rules file](../../reference/rules-file.md). Where this spec changes a contract, section 2 says so and the reference docs change in the same branch.

## 1. Goal

Phase 0 checks rules against hand-written facts. Phase 1 makes Holdline read the two places where access control actually lives for most apps, and prove the rules at runtime:

- **Postgres:** tables, constraints and row level security policies, from the project's own SQL migrations (Supabase, Prisma, Drizzle, plain SQL).
- **Firestore and Cloud Storage:** `firestore.rules` and `storage.rules`.
- **Database tests:** the generated `.holdline/tests/*.yaml` cases run against a real Postgres (PGlite, in process) and the Firebase emulator.

**Done when:**

1. Every breakage of the two new golden apps (`golden-supabase`, `golden-firebase`) is caught through `holdline scan` + `holdline check`, from real file patches, not fact patches.
2. `holdline test` runs every generated case green on the clean golden apps, and at least one case per data-access rule red on the matching breakage.
3. The private DogBase gate passes (section 7). Nothing from DogBase is committed.
4. `golden-ts-postgres` facts for tables (section 3) are produced by `analyzer-postgres` from its migration and match the hand-written tables in `fixtures/facts.json`.

## 2. Step 0: shared changes before the tracks split

Small, sequential, done in this session before the three tracks start. Each is a contract change, so the reference docs change with it.

### 2.1 Lookup operand

Firestore rules authorize through other documents:

```
resource.data.orgId in get(/databases/$(database)/documents/users/$(request.auth.uid)).data.orgIds
```

Phase 0 operands can't say "field of another document", so this would become `opaque` and every such rule would fail. Add one operand form:

| Operand | Meaning |
|---|---|
| `doc(<path>).<field>` | Field `<field>` of the document at `<path>`. `<path>` uses the same placeholders as `exists` docs: `/users/{actor.uid}`, `/orgs/{param.orgId}/members/{actor.uid}`, `/orgs/{resource.orgId}` |

- `OPERAND_PATTERN` accepts `doc\((/[^()]*)\)\.[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*`.
- Implication needs no change: two lookup operands are equal when their strings are equal.
- An atom with a lookup whose path contains `{actor.` implies `authenticated` under the same literal rule as actor operands (`eq`/`in` against a non-null literal), and so does `exists` today.
- `renameParams` renames `{param.x}` inside lookup paths.
- `mentionsOperand` matches lookup operands by string.
- Test generation: satisfying `eq(doc(P).f, v)` or `in(x, doc(P).f)` seeds the document at the resolved `P` with field `f` (for `in`, an array containing the value). Breaking it changes the field. A lookup whose path cannot be resolved is skipped like other unset placeholders.
- Postgres does not need it: `IN (SELECT …)` and `EXISTS (…)` map to the existing `pg:` exists form.

### 2.2 Project config

A small optional file, `.holdline/config.yaml`:

```yaml
postgres:
  migrations: ["supabase/migrations/*.sql"]   # globs, applied in sorted path order
  dialect: supabase                            # supabase | plain
firestore:
  rules: ["firestore.rules"]
storage:
  rules: ["storage.rules"]
```

- Core adds `loadConfig(root): HoldlineConfig`, validated with zod, every section optional. Unknown sections are kept for later analyzers.
- `AnalyzerContext` gains `config: HoldlineConfig`. This is additive.
- With no config, each analyzer uses the defaults in its section below.

### 2.3 Analyzer registration

`packages/cli/src/analyzers.ts` imports each analyzer package and lists it. Each track adds exactly one import and one array entry, so merges are trivial. Among workspace packages, analyzer packages depend only on `@holdline/core`; they bring their own third-party libraries (PGlite, libpg-query). `packages/testkit` may also depend on `packages/analyzer-postgres` for `applyMigrations`.

### 2.4 Golden app layout for real breakages

From Phase 1, a golden app's breakages are file patches:

```
examples/golden-<name>/
  expected-rules.yaml
  breakages/R-001.patch     # unified diff against the app, breaks exactly R-001
```

The acceptance test copies the app to a temp folder, applies the patch (`git apply`), runs `holdline scan` and `holdline check --format json`, and asserts that exactly that rule fails. Step 0 adds this harness to `packages/cli/test/` next to the Phase 0 JSON-patch harness, which stays for `golden-ts-postgres` until Phase 2.

## 3. Track A: `packages/analyzer-postgres`

### 3.1 Detect

The analyzer runs when `config.postgres.migrations` is set, or when any default location has `.sql` files:

- `supabase/migrations/*.sql` (dialect `supabase`)
- `prisma/migrations/*/migration.sql`
- `drizzle/*.sql`
- `migrations/*.sql`, `db/migrations/*.sql`

Files are applied in sorted path order (all of these tools name migrations so that sorted order is apply order).

### 3.2 Read the schema by running the migrations

1. Start a fresh PGlite (`@electric-sql/pglite`).
2. For dialect `supabase`, first create the shim: schemas `auth`, `storage` and `extensions`; roles `anon`, `authenticated`, `service_role`; `auth.uid()` returning `(current_setting('request.jwt.claims', true)::json ->> 'sub')::uuid`; `auth.jwt()` returning the claims JSON; `auth.role()` returning the claims `role`; an `auth.users (id uuid primary key, email text)` table.
3. Apply each migration in one transaction. On failure, emit an error diagnostic for that file (`file` = the migration path, message = the Postgres error with its position) and stop: later migrations would run against the wrong schema.
4. Read the catalog (`pg_class`, `pg_attribute`, `pg_constraint`, `pg_enum`, `pg_policy`, `pg_get_expr`) for every table in non-system schemas, excluding the shim's schemas.

Facts:

| Fact | From |
|---|---|
| `tables[]` | One per table: `id` `pg:<schema>.<table>`, `name` `<schema>.<table>`, columns (name, formatted type, nullable, default), primary key, foreign keys, unique constraints and unique indexes, CHECK constraints (`pg_get_constraintdef`, outer `CHECK (...)` removed), enum columns with their labels in order, `rlsEnabled` (`relrowsecurity`) |
| `symbols[]` | One `table` symbol per table, one `policy` symbol per policy, located at the migration file and line of the statement that created them (section 3.4) |
| `policies[]` | One per RLS policy and per command it covers (section 3.3) |

Table and column names are emitted exactly as Postgres stores them (unquoted identifiers are lowercase).

### 3.3 Normalize RLS policies

Each `pg_policy` row becomes one policy fact per op:

| `polcmd` | `ops` | Condition used |
|---|---|---|
| `r` SELECT | `read`, `list` | `USING` |
| `a` INSERT | `create` | `WITH CHECK` |
| `w` UPDATE | `update` | `USING` AND `WITH CHECK` (`WITH CHECK` defaults to `USING`) |
| `d` DELETE | `delete` | `USING` |
| `*` ALL | all five | as above, per op |

- Permissive policies on the same table and op are ORed by the checker already. A **restrictive** policy is ANDed into every permissive policy's condition for the same ops.
- `polroles`: a policy that applies only to `anon`, or only to roles other than `authenticated`/`public`, is skipped for the actor model (recorded as a warning diagnostic). Policies for `authenticated` or `public` are used.
- Every condition is ANDed with `{ atom: { op: authenticated } }` when it references `auth.uid()` or `auth.jwt()`, because those are null for anonymous callers and the comparison fails (the Phase 0 rule that analyzers emit `authenticated` explicitly).

Expressions come from `pg_get_expr(polqual|polwithcheck, polrelid)` and are parsed with `libpg-query` (`SELECT <expr>`). Mapping:

| SQL | Expr |
|---|---|
| `auth.uid()`, `(select auth.uid())` | `actor.uid` |
| `auth.jwt() ->> 'k'`, `(auth.jwt() -> 'app_metadata') ->> 'k'` | `actor.claim.k`, `actor.claim.app_metadata.k` |
| `auth.role()` | `actor.role` |
| column `c` of the policy's table | `resource.c` (in `WITH CHECK`: `incoming.c`) |
| `a = b`, `a <> b`, `a < b`, `a > b` | `eq`, `ne`, `lt`, `gt` |
| `a IN (1, 2)`, `a = ANY (ARRAY[...])` | `in` with an array literal |
| `c IS NULL` | `isNull` |
| `c IS NOT NULL` | `not(isNull)` |
| `AND`, `OR`, `NOT` | `and`, `or`, `not` |
| `true`, `false` | `{ and: [] }`, `{ or: [] }` |
| `EXISTS (SELECT 1 FROM t WHERE t.a = <x> AND t.b = <y>)` with only `=` conjuncts | `exists(pg:<schema>.t?a={x}&b={y})` |
| `<x> IN (SELECT t.a FROM t WHERE t.b = <y> …)` | `exists(pg:<schema>.t?a={x}&b={y}…)` |
| a call to a SQL function | inlined when it is `LANGUAGE sql`, `STABLE`/`IMMUTABLE`, one `SELECT <expr>` body; otherwise `opaque` |
| anything else | `opaque` with the SQL text |

Each `{x}` inside an exists doc is an operand such as `{resource.account_id}` or `{actor.uid}`. Postgres conditions never produce `param.*` operands, because tables have no path parameters.

### 3.4 Locations

Statement locations come from parsing each migration file with `libpg-query` (`parse` gives statement offsets). The analyzer records, per migration, the line of each `CREATE TABLE`, `ALTER TABLE … ADD CONSTRAINT`, `CREATE POLICY` and `ALTER TABLE … ENABLE ROW LEVEL SECURITY`, and attaches the latest one to the table or policy symbol. Statement parsing is only for locations. The schema itself always comes from the catalog.

### 3.5 Cache and performance

The whole Postgres fact set is cached by a hash of all migration contents, the dialect and the analyzer version (`FileCache`). A warm `check --changed` that touched no migration does not start PGlite. Budget: a cold scan of 50 migrations under 10 s.

### 3.6 Out of scope

Django and Alembic migrations (Python) belong to the Python analyzer (Phase 2). `schema.prisma` without a migrations folder (`db push` projects) is reported as an info diagnostic: "no SQL migrations found; run prisma migrate or point holdline at a schema dump". Views, triggers and functions other than policy helpers are not facts in Phase 1.

## 4. Track B: `packages/analyzer-firestore`

### 4.1 Detect

The analyzer runs when `config.firestore.rules` or `config.storage.rules` is set, or `firestore.rules` / `storage.rules` exists at the root or where `firebase.json` points (`firestore.rules`, `storage.rules` or `storage[].rules`).

### 4.2 Parse

A hand-written recursive-descent parser (no generator, no build step), producing an AST with line and column on every node. It supports what both rules languages use:

- `rules_version = '2';`, `service cloud.firestore { … }`, `service firebase.storage { … }`
- `match <path> { … }` nested, with literal segments, `{name}` and `{name=**}` wildcards, `$(expr)` interpolation in paths
- `function name(params) { let x = e; return e; }`, at any scope
- `allow <ops>: if <expr>;` and `allow <ops>;` (unconditional), ops `read`, `write`, `get`, `list`, `create`, `update`, `delete`
- Expressions: literals (string, int, float, bool, null, list, map, path `/a/$(b)/c`), identifiers, member access, indexing, calls, method calls, unary `!` `-`, binary `* / % + - < <= > >= == != in is && ||`, ternary `? :`
- Comments `//` and `/* */`

A parse error becomes one error diagnostic with the file, line and message, and the file yields no policies.

### 4.3 Expand

- **Ops:** `read` → `read`, `list`; `get` → `read`; `write` → `create`, `update`, `delete`. (Holdline's `read` is a single-document get.)
- **Paths:** nested match paths are concatenated, the Firestore prefix `/databases/{database}/documents` and the Storage prefix `/b/{bucket}/o` are removed, and `{x=**}` stays as is. The result is the policy `target`, for example `/orgs/{orgId}/projects/{projectId}`.
- **Policy ids:** `firestore:<target>#<op>@<line>` (`storage:` for Storage), one per allow statement and op. The `allow` line is the policy's evidence.
- **Match blocks** become `match` symbols with id `firestore:<target>`, located at the `match` line.

### 4.4 Normalize conditions

Functions are inlined: a call to a user-defined function is replaced by its body with arguments substituted, after its `let` bindings are substituted. Recursion deeper than 20 calls becomes `opaque` (the rules language allows no real recursion).

| Rules expression | Expr |
|---|---|
| `request.auth != null` | `authenticated` |
| `request.auth == null` | `not(authenticated)` |
| `request.auth.uid` | `actor.uid` |
| `request.auth.token.k` | `actor.claim.k` |
| `resource.data.f` (Storage: `resource.metadata.f`) | `resource.f` |
| `request.resource.data.f` | `incoming.f` |
| a path wildcard variable `x` | `param.x` |
| `get(P).data.f` (Storage: `firestore.get(P).data.f`) | `doc(P').f` |
| `exists(P)` (Storage: `firestore.exists(P)`) | `exists(P')` |
| `x.get('f', d)` on a map | `x.f`, only if `d` cannot satisfy the comparison it appears in; otherwise `opaque` |
| `==`, `!=`, `<`, `>`, `in` (list on the right) | `eq`, `ne`, `lt`, `gt`, `in` |
| `&&`, `\|\|`, `!` | `and`, `or`, `not` |
| `true`, `false` | `{ and: [] }`, `{ or: [] }` |
| `a ? b : c` | `or[and[a, b], and[not a, c]]` |
| `getAfter(P)`, `existsAfter(P)` | `opaque`: never the same lookup as `get(P)`, because they read the document after the write and treating both as one value would be unsound |
| anything else (`hasAny`, `size()`, string building, `request.time`, `matches`, …) | `opaque` with the source text |

`P'` is the document path with the Firestore prefix removed and `$(…)` replaced by `{operand}` (`$(request.auth.uid)` → `{actor.uid}`, `$(orgId)` → `{param.orgId}`, `$(resource.data.orgId)` → `{resource.orgId}`). A path segment that can't be turned into an operand makes the whole lookup `opaque`.

Every condition that uses `request.auth` anywhere is ANDed with `authenticated`, because Firestore denies a request whose condition dereferences a null `request.auth`.

`allow …: if false;` and unconditional `allow …;` become conditions `{ or: [] }` and `{ and: [] }`.

**Vocabulary:** if an approved vocabulary entry recognizes a zero-parameter function by name (`firestore-function: signedIn`), calls to it become `{ ref: <id> }` instead of being inlined. Functions with parameters are always inlined in Phase 1.

### 4.5 Out of scope

Collections and fields inferred from client SDK calls (`collection()`, `doc()`, converters) move to `analyzer-ts` in Phase 2. That analyzer needs TypeScript parsing, and the rules files already give every target the checkers need. `collections[]` stays empty in Phase 1.

## 5. Track C: `packages/testkit` and `holdline test`

### 5.1 Command

```
holdline test [--rule <ids...>] [--store postgres|firestore|storage] [--format human|json]
```

- Reads `.holdline/tests/*.yaml` (Phase 0 test-case format), runs each case, reports per rule: cases passed, cases failed (with the case name, what was expected, what happened).
- Exit 0 when every case passes, 1 when any fails, 2 on usage or config errors, 3 when a runner cannot start (no Java, no `firebase-tools`, PGlite failure). Infrastructure failures are reported separately from rule failures.
- A test file whose `generatedFrom` hash doesn't match the rule's current hash is regenerated first (deterministic, so this is safe), and the report says so.

### 5.2 Postgres runner

Per test file: a fresh PGlite with the project's migrations applied the same way as section 3.2 (the runner reuses the analyzer's migration code through a small shared module in `analyzer-postgres`, exported as `applyMigrations`).

Per case, inside a transaction that is rolled back after the case:

1. **Seed as superuser** with `SET LOCAL session_replication_role = replica` (foreign keys and triggers off, so seeds can be partial). Each seed row is completed with filler values for its other `NOT NULL` columns without defaults, chosen from the column type (`uuid` → a fixed UUID, `text` → `'x'`, numbers → `0`, `bool` → `false`, timestamps → epoch, enums → the first label).
   **Values:** generated test values are strings (`user-1`, `value-1`, `orgId-1`). The runner maps each generated string deterministically to a value of the column's type: for `uuid` columns a UUID v5 of the string (fixed namespace), for numbers a stable small integer, otherwise the string itself. The same mapping applies to `as.uid` and to the `sub` claim, so `auth.uid()` and the seeded rows agree. Each seed row gets its own primary key: the mapped value of its `id` field when the case sets one, otherwise a UUID v5 of the table name and the seed's position.
2. **Act as the case's actor:** `SET LOCAL ROLE authenticated` (dialect `supabase`; for `plain`, a role `holdline_actor` created with the table privileges), and `set_config('request.jwt.claims', <json>, true)` with `sub` = `as.uid`, `role` = `as.role ?? 'authenticated'` and the case's claims. `as: null` runs as `anon` (supabase) or as the actor role with no claims.
3. **Do the operation** on the seeded row, found by its primary key:

| `do.op` | allow means | deny means |
|---|---|---|
| `read` | the row is returned | no row returned |
| `list` | at least one seeded row returned | none returned |
| `create` | `INSERT` succeeds | `INSERT` fails with an RLS violation (`42501`) |
| `update` | `UPDATE` changes 1 row | 0 rows changed or an RLS violation |
| `delete` | `DELETE` removes 1 row | 0 rows removed |

`expect: reject` (invariants) means the write fails with a constraint error (`23502` not null, `23503` foreign key, `23505` unique, `23514` check, `22P02` invalid enum value). Reject cases run as superuser with foreign keys on.

### 5.3 Firestore and Storage runner

Uses `@firebase/rules-unit-testing` (v6) with `initializeTestEnvironment({ projectId: 'holdline-test', firestore: { rules }, storage: { rules } })`.

- **Emulator:** when `FIRESTORE_EMULATOR_HOST` (and for Storage `FIREBASE_STORAGE_EMULATOR_HOST`) is set, the runner uses it. Otherwise `holdline test` re-runs itself inside `firebase emulators:exec --only firestore,storage --project holdline-test "<same command>"`. When `firebase` or Java is missing, exit 3 with the install hint.
- **Per case:** `clearFirestore()`, seed with `withSecurityRulesDisabled`, then act with `authenticatedContext(uid, claims)` or `unauthenticatedContext()`:

| `do.op` | Call |
|---|---|
| `read` | `getDoc(doc(path))` |
| `list` | `getDocs(collection(path))` |
| `create` | `setDoc(doc(path), data)` on a path with no document |
| `update` | `updateDoc(doc(path), data)` |
| `delete` | `deleteDoc(doc(path))` |

  `assertSucceeds` for `allow`, `assertFails` for `deny` and `reject`.
- **Storage cases** use the storage context: `uploadString` for create and update, `getMetadata` for read, `deleteObject` for delete. Seeds are uploaded with rules disabled, and seed `data` becomes custom metadata.

### 5.4 Invariant test generation

`generateTests(rule, vocab, facts?)` gains an optional third parameter. For `invariant` rules on Postgres tables, with the table's facts:

| `kind` | Case (`expect: reject`) |
|---|---|
| `not-null` | insert a complete row with the column set to `NULL` |
| `fk` | insert a complete row whose column references a value that doesn't exist |
| `unique` | insert two complete rows with the same values in the columns |
| `enum` | insert a complete row with the value `'__holdline_invalid__'` |
| `check` | skipped with the reason "check expressions are tested statically only" |

Each also gets one `allow` case: a complete valid row inserts. Firestore invariants (`not-null`, `enum`) get `create` cases against the write rules: `deny` with the field missing or invalid, `allow` with it valid. "Complete row" uses the same filler rules as section 5.2.

## 6. Golden apps

Both follow the Phase 0 golden layout plus file-patch breakages (section 2.4). Each has about ten rules covering every rule type its store supports, and one breakage per rule.

### 6.1 `examples/golden-supabase`

A Next.js app with Supabase migrations. Tables: `organizations`, `memberships (org_id, user_id, role)`, `projects (org_id, owner_id, deleted_at, status)`, `invoices (org_id, amount)`, `profiles (id = auth.users.id)`. Rules include:

- data-access: members read their organization's projects (`exists(pg:public.memberships?org_id={resource.org_id}&user_id={actor.uid})`); only the owner updates a project; only admins read invoices; users update only their own profile; RLS is enabled on every table (implied by each data-access rule)
- invariants: `projects.org_id` not null and references `organizations`; `memberships.role` in (`owner`, `admin`, `member`); unique `(org_id, user_id)`; `invoices.amount > 0`

Breakages include a policy loosened to `true`, a dropped `ENABLE ROW LEVEL SECURITY`, a membership check replaced by `auth.uid() IS NOT NULL`, a dropped constraint and a widened enum.

### 6.2 `examples/golden-firebase`

A Firebase app with `firestore.rules`, `storage.rules` and `firebase.json`. Collections: `/users/{uid}` (with `orgIds`), `/orgs/{orgId}/members/{uid}` (with `role`), `/projects/{projectId}` (flat, with `orgId` and `status`), `/projects/{projectId}/notes/{noteId}`. Storage: `/orgs/{orgId}/files/{path=**}`. Rules include:

- data-access: projects are read only within the caller's organizations (`in(resource.orgId, doc(/users/{actor.uid}).orgIds)`); projects are created only into the caller's organizations; only organization admins update projects (`eq(doc(/orgs/{resource.orgId}/members/{actor.uid}).role, 'admin')`); projects are never deleted by clients (no policy allows it); organization files are read only by members (`exists(/orgs/{param.orgId}/members/{actor.uid})`)
- invariants: `projects.orgId` must be present on create; `projects.status` in (`active`, `archived`)

Breakages include an `allow read: if request.auth != null` added under `/{document=**}`, a helper function whose membership check is removed, an `allow delete` added, a storage rule that drops the membership `exists`, and an `orgIds` check replaced by a `hasAny`.

The app is rules only in Phase 1. Cloud Functions and an Expo client join it in Phase 2.

## 7. DogBase gate (local and private)

Run `holdline scan` in the DogBase checkout. Done when its Firestore and Storage rules produce zero error diagnostics. The opaque-condition summary is reviewed privately. Common opaque patterns found there are normalized in this phase or listed in As built without quoting DogBase source.

The Firestore track adds the summary line to `holdline scan`: per rules file, the number of policies and of opaque sub-conditions with their source text.

Nothing from DogBase is committed to this repo; its reference rule set and adoption spec stay in the dogbase repo (feature spec section 11).

## 8. Tracks

| Track | Owns | Depends on | Done when |
|---|---|---|---|
| Step 0 (this session) | `packages/core` (lookup operand, config, context), `packages/cli` (registration, file-patch golden harness), reference docs, skeletons of the two golden apps | Phase 0 | Core tests pass with the new operand; the harness runs a no-op patch on a skeleton app |
| A: Postgres | `packages/analyzer-postgres`, `examples/golden-supabase` (rules, migrations, breakages) | Step 0 | Section 1 items 1 and 4 for Postgres; `applyMigrations` exported |
| B: Firestore | `packages/analyzer-firestore`, `examples/golden-firebase`, the scan summary line | Step 0 | Section 1 items 1 and 3 for Firestore and Storage |
| C: Test runner | `packages/testkit`, `holdline test`, `generateTests` invariant extension in core | Step 0; uses Track A's `applyMigrations` once merged (until then it applies migrations with its own copy behind the same signature) | Section 1 item 2 on both golden apps |

Each track runs as its own session in its own worktree, with its own plan written from this spec. Files are disjoint except `packages/cli/src/analyzers.ts` (one line each) and `packages/cli/src/main.ts` (Track C adds `test`). Tracks merge in the order A, B, C; C rebases on A to drop its migration copy.

## 9. Testing

- **Unit:** each normalization table row (sections 3.3 and 4.4) has a test from SQL or rules source to `Expr`. The Firestore parser has tests for every construct in 4.2 plus error positions.
- **Soundness:** a normalization never produces an Expr that is stronger than the source condition. For each normalization rule, a test evaluates source and Expr on a small model (the same approach as the Phase 0 prover soundness test). For Postgres, the evaluation runs real SQL in PGlite. For Firestore, it runs the rules in the emulator, tagged `@emulator` and run in CI.
- **Golden:** section 1 items 1, 2 and 4.
- **CI:** the emulator tests need Java and `firebase-tools`. The workflow installs both. Locally they are skipped with a message when either is missing.

## 10. Risks

| Risk | Mitigation |
|---|---|
| A project's migrations use an extension PGlite doesn't ship | Error diagnostic naming the extension; rules on that schema report `unknown`; the As built section lists extensions found in real projects |
| Normalization maps a condition too generously, letting a rule pass | Soundness tests per normalization rule (section 9); anything not in the tables becomes `opaque` |
| Emulator startup is slow or flaky in CI | One emulator per `holdline test` run, cases cleared between runs, retries only for startup |
| Real rules files use patterns this spec turns into `opaque`, so their rules can't be verified | The private gate measures them (section 7); the most common ones get normalized in this phase |
| `libpg-query` WASM size slows the CLI | Loaded lazily, only when the Postgres analyzer runs |

## Decisions

Made while brainstorming on 2026-10-21:

| Decision | Why |
|---|---|
| Read Postgres by running migrations in PGlite and reading the catalog, not by parsing DDL | Postgres resolves order, ALTERs, DROPs and renames itself; no DDL semantics to re-implement |
| Add a lookup operand `doc(P).f` | Most Firestore apps authorize through other documents; without it every such rule is `opaque` |
| Hand-written Firestore parser | No build step, precise error positions, the language is small |
| Inline rules functions; vocabulary refs only for zero-parameter functions | Deterministic, and handles parameterized helper functions, which real rules files use heavily |
| SDK-call collection inference moves to Phase 2 | It needs TypeScript parsing; the rules files give every target Phase 1 needs |
| Breakages become real file patches | The analyzers now read files, so the acceptance test can cover the whole path from source to result |
| Three parallel tracks after a short shared step | Disjoint files; contract changes land once, first |

## As built (step 0)

Step 0 (section 2) is built. The reference docs ([facts](../../reference/facts.md), [rules file](../../reference/rules-file.md)) describe the code; this list records where it differs from sections 2 and 5.

| Section | As built |
|---|---|
| 2.1 Lookup operand | Placeholders inside a lookup path must be valid operands (`{actor.uid}`, `{actor.role}`, `{actor.claim.*}`, `{resource.f}`, `{incoming.f}`, `{param.x}`). A `resource.*` or `incoming.*` field that only a lookup or `exists` path needs gets a fresh test value instead of skipping the rule; placeholders the generator can't make a value for (claims, roles) still skip. |
| 2.1 / 5 Test generation | Deny cases are built by re-solving every other condition around one pinned value, and a deny case is kept only when exactly its condition is false; otherwise it is skipped with "cannot deny only …". `read`, `list` and `delete` are skipped when a condition reads the incoming write. An `exists` or lookup on the record's own path merges into the record seed, so each path is seeded once. Storage test files mark each seed with `store: storage` or `store: firestore`. The generator is split into `testgen.ts`, `testgen-world.ts`, `testgen-satisfy.ts`, `testgen-deny.ts` and `testgen-eval.ts`. |
| 2.2 Config | Globs are root-relative, matched against the scanned file list with `matchFiles` (`*`, `**`, `?`); absolute globs and `..` segments are config errors. An empty section (`postgres:` with no body) counts as empty. |
| 2.2 / 2.3 Analyzer contract | `detect(root, files, config)` receives the config. `AnalyzerContext` also carries `recognizers`: the approved vocabulary entries' recognizers, which analyzers using them must include in their cache key. `holdline scan` and `check` pass the same recognizers. |
| 2.4 Golden harness | `expectClean` and `expectCaught` hold the gate's assertions, and both require `holdline scan` to exit 0. An app's `breakages/` may contain only `*.patch` files (and `.gitkeep`). The per-app suite is skipped until an app has patches. |

**Known gap, fixed by Track C:** in Storage test files, a Firestore document (`exists` or lookup) whose path equals the Storage object's path was merged into the object seed, which made that allow case wrong. The record merge now applies only to Firestore targets; such a document is its own `store: firestore` seed (see As built (Track C)).


## As built (Track A)

Track A (section 3, the Postgres part of sections 1 and 6.1) is built in `packages/analyzer-postgres` and
`examples/golden-supabase`. The [fact graph reference](../../reference/facts.md#postgres-analyzer-packagesanalyzer-postgres)
describes the code; this list records where it differs from sections 3, 6.1 and 8.

| Section | As built |
|---|---|
| 3.1 Detect | `prisma/schema.prisma` alone also runs the analyzer, so it can report why there are no tables. All matched paths are sorted together. The dialect is `supabase` only when `postgres.dialect` says so or a matched path matches `supabase/migrations/*.sql`; a custom glob over Supabase migrations in another folder gives `plain`. |
| 3.2 PGlite | PGlite 0.5.11 (Postgres 18) starts with the contrib extensions `uuid_ossp` and `pgcrypto`. Any other extension fails its migration with Postgres' own error (`extension "postgis" is not available`). The dialect's `search_path` (`"$user", public, extensions` for Supabase, PGlite's startup `public` for plain) is restored after each migration, because `pg_get_expr` prints names relative to it and a migration may `SET` it; the catalog is read in a transaction with that `search_path` set locally. An error outside a migration closes the database and is thrown. |
| 3.2 Shim | The claims setting is read as `nullif(current_setting('request.jwt.claims', true), '')`, because a rolled-back local setting reads as `''`. `uuid-ossp` and `pgcrypto` are created in schema `extensions`, and the session `search_path` is `"$user", public, extensions`, as in Supabase. `service_role` has `bypassrls`. `usage` on the four schemas and default privileges in `public` (all on tables, sequences and functions) go to `anon`, `authenticated` and `service_role`. `storage.buckets` and `storage.objects` exist. `auth.users` and `storage.*` get no table grants. |
| 3.2 Failure | A failing migration yields only its error diagnostic, with ` (line N)` when Postgres gives a position. The output has no partial tables or policies. |
| 3.2 Facts | Types are shortened (`timestamptz`, `varchar`, `char`, `timetz`, precision kept). A quoted literal default loses its cast. Foreign keys, unique constraints and checks are ordered by first key column, then name. Unique indexes count as uniques when they back no constraint and are neither partial nor on expressions (key columns only), listed after the constraints. A check's `expr` keeps Postgres' inner parentheses (`(amount > 0)`) and drops ` NOT VALID`. Partitioned tables are included. Postgres 18's NOT NULL constraints are ignored. |
| 3.3 Ops | An UPDATE fact is its own `USING` AND the OR of the `WITH CHECK` of every permissive UPDATE policy on the table, not its own `USING` AND its own `WITH CHECK`: Postgres combines the two kinds of clause separately. |
| 3.3 Roles | Coverage follows Postgres: a policy covers signed-in (anonymous) callers when its roles include `PUBLIC` or a role `authenticated` (`anon`) has the privileges of (`pg_has_role … 'USAGE'`), so a custom role granted to `authenticated` `WITH INHERIT TRUE` counts (the shim's roles are `NOINHERIT`, as in Supabase). Not skipped: policies covering only anonymous callers become `and[not(authenticated), c]`, and those covering only signed-in callers `and[authenticated, c]`. A restrictive policy binds only the callers it covers: `or[not(authenticated), c]` for signed-in, `or[authenticated, c]` for anonymous. Policies covering neither are still skipped with a warning. The plain dialect keeps permissive policies for any role and drops restrictive ones not for `public`. |
| 3.3 Sign-in | `authenticated` is added when the condition is certainly false for an anonymous caller (a three-valued evaluation), not whenever it mentions `auth.uid()` or `auth.jwt()`. `auth.uid() IS NULL` and `IS NOT NULL` map to `not(authenticated)` and `authenticated`; other `actor.*` null tests are opaque. |
| 3.3 Caller values | An anonymous Supabase caller carries the anon key's claims (`role`, `iss`, `ref`, `aud`, `iat`, `exp`), while the facts model it as no actor. So: comparisons on those claims are opaque; the role (`auth.role()` or the `role` claim) maps only for `=` a string or `IN` strings without `'anon'`, and `= 'anon'` gives `not(authenticated)`; other claims map only against plain string literals (not `'true'`, `'false'`, `'null'`, number-like text, or text starting with `{`, `[` or `"`, which `->>` returns for JSON objects, arrays and nested strings), and never with `<` or `>`. |
| 3.3 Constants | Casts on constants are applied by type: numeric types give numbers (integer types only for integer values), numbers and booleans to text give their text, `uuid` lowercases, `bool` keeps booleans only. `citext`, type modifiers and array casts make the constant opaque. `lt` and `gt` map only against a number literal. `::text` on `auth.uid()` or a claim keeps the operand; other casts on non-constants are opaque. |
| 3.3 Subqueries | `EXISTS` and `IN (SELECT …)` map only in positive position (under RLS on the inner table `exists` is too weak to negate). They are opaque with aggregate or computed targets, column alias lists, `ONLY`, joins, `ORDER BY`, `LIMIT` and similar clauses, a literal or an `actor.*` value other than `actor.uid` as an operand (the doc format can't hold a literal; the role and anon-key claims are set for anonymous callers; a claim's text is compared with the column while its JSON value may be a number or boolean), or a schema, table or column name outside `[A-Za-z0-9_]+`. Doc columns are sorted by name. A policy-table column outside `[A-Za-z0-9_]+` is opaque too, since core's operand pattern can't hold it. |
| 3.3 Helpers and names | Unqualified tables and functions resolve through the search path (`public`, `extensions` for Supabase; `public` for plain), and inside a helper through its own `SET search_path`. Names that exist in `pg_catalog` are never inlined. Overloaded helpers (same name and arity) are not inlined. Nesting stops at 10. The plain dialect does not map `auth.*`. |
| 3.4 Locations | Tables at the latest `CREATE TABLE`, policies at the latest `CREATE POLICY`. `ALTER TABLE` statements are not used. |
| 3.5 Cache | The key is the dialect plus every migration's path and content, so a renamed migration misses. A cached failure stays until a migration changes. Measured: 50 migrations cold in about 2.5 s. |
| 3.6 Prisma | The `schema.prisma` diagnostic is a warning: diagnostics have no info severity. |
| 6.1 Golden app | Twelve rules and breakages, see the [README](../../../examples/golden-supabase/README.md). Beyond the listed rules: projects are created only by members (R-003), organizations are read only by members (R-005), deleted projects are never readable (R-006). "Only admins read invoices" (R-004) uses a custom JWT claim `user_role`, because the `exists` doc format can't hold a literal such as `role = 'admin'`. It covers only the admin claim, not the policy's organization membership half. In a real app the claim would come from a custom access-token hook. The Next.js files are never built (no `tsconfig`). |
| 8 Tracks | `applyMigrations(root, config, files?)` returns `MigrationRun { db, dialect, migrations, failure? }`; the caller closes `db`. `files` defaults to `listFiles(root)`. |
| 9 Testing | Soundness runs each normalization against real Postgres in `test/soundness.test.ts`. `golden-ts-postgres` tables, locations included, come from its migration and match `fixtures/facts.json`. |
| Shared files | Outside this track's folders: the root `package.json` `typecheck` script also checks `packages/analyzer-postgres`; `packages/cli/package.json` depends on `@holdline/analyzer-postgres`; `packages/cli/test/golden-patch.test.ts` gives each golden-app test 120 s; the root `vitest.config.ts` has two projects, core's tests first (`sequence.groupOrder` 0) and every other package's after (1). Plus the one import and array entry in `packages/cli/src/analyzers.ts`. |

**Known limits:** each partition is also emitted as a table; a generated column's expression appears as its default;
unique constraints and indexes are not merged by column position; `NO INHERIT` stays in a check's `expr`; integers
above 2^53 lose precision and `float4` rounding is not modelled; a signed-in wrap plus a restriction can repeat
`authenticated` in nested `and`s; comparisons between two columns assume plain equality (`citext`, `bpchar` padding and
nondeterministic collations are not modelled); nested `/* */` comments can shift a reported line; opaque text is cut
best effort (parentheses in strings, `E''` and dollar quotes); a real Supabase `db pull` migration that references
`pg_graphql`, `supabase_vault`, `pg_stat_statements`, the `graphql` or `vault` schemas, or roles such as
`supabase_admin` fails with an error diagnostic, so its rules become unknown.

**Test order:** core's property tests (`packages/core/test/logic.test.ts`) have 5 s timeouts that the CPU load
of the PGlite suites could push past when everything ran at once. The root `vitest.config.ts` therefore runs core's
tests as their own project before the other packages' (`sequence.groupOrder`). Every test file still runs exactly once,
and the total time is unchanged.

## As built (Track B)

Track B (section 4, and 6.2 for the golden app) is built. The [facts reference](../../reference/facts.md) ("Firestore and Storage analyzer") describes the code; this list records where it differs from sections 4, 6.2, 7 and 9.

| Section | As built |
|---|---|
| 4.1 Detect | `firebase.json` is read at any depth, not only the root. Each pointer is relative to its own directory. The `firestore` and `storage` keys may be objects or arrays (several databases or buckets). A pointer outside the repo or at a missing file, an invalid or unreadable `firebase.json`, and config globs matching no file are errors: each leaves a store's rules incomplete, so checks must not treat the found policies as the whole set. Config globs for a store replace the defaults for that store only. `detect` is also true when discovery only has errors. |
| 4.2 Parse errors | The message is `line L, column C: <message>`. A rules file that cannot be read is an error diagnostic too, and so is an exception while analyzing one file (`analysis failed: <message>`, e.g. a stack overflow on deep nesting; not cached). Each yields no policies for that file only. |
| 4.3 Policy ids | A second `allow` that gives the same `<store>:<target>#<op>@<line>` id gets `:<col>` added. |
| 4.3 Paths | A `$(expr)` segment in a match path renders as a rest wildcard `{_interpN=**}`, because the value may span segments (it overlaps more, never less). The prefix is stripped when its first segment is `databases` (Storage: `b`), its second any single segment (a wildcard, `(default)` or a literal bucket) and its third `documents` (Storage: `o`); a single-segment wildcard also matches the first or third. A rest wildcard (or `$(...)`) within the first three segments gives the target `/{<name>=**}`, covering every document. Any other `match` path is kept in full with a warning; a prefix split across nested matches is recognized. An `allow` directly in the service or the prefix match has target `/`. A function declared twice in one block is a warning and the last one is used. One `match` symbol per distinct (store, target), at its first line. |
| 4.4 `authenticated` | ANDed per atom that reads `request.auth` (an actor operand, an `exists` or lookup whose path holds `{actor.`), not onto the whole condition. The whole-condition form is unsound for `resource.data.public == true \|\| request.auth.uid == resource.data.owner`: Firestore allows an anonymous read of a public document. The soundness property test catches the whole-condition form. |
| 4.4 `x.get('f', d)` | Maps to `x.f` when `d` is `null` (the model's absent value), or when neither `d` nor `null` satisfies the comparison against a literal; otherwise `opaque`. `<` and `>` with a fallback map only when both values are numbers. A non-null fallback on both sides, or on the right of `in`, is `opaque` (a `null` default is no fallback). |
| 4.4 Bare boolean | A boolean value in condition position (`resource.data.published`) is `eq(<operand>, true)`. |
| 4.4 Storage metadata | `request.resource.metadata.f` maps to `incoming.f`, next to `resource.metadata.f` to `resource.f`. `.data` in Storage files and `.metadata` in Firestore files are `opaque`. |
| 4.4 More conservative than the table | `opaque`: rest wildcards (`{x=**}`, a path) used as operands or path segments; dotted keys (`data['a.b']`, `get('a.b', d)`, which name one top-level field); integers past 2^53; non-finite float literals (`1.0e999`); floats interpolated into lookup paths; a user function named like a built-in (`get`, `exists`, `getAfter`, `existsAfter`, `debug`, `bool`, `bytes`, `float`, `int`, `string`, `path`); `<=`, `>=`, `is`; `request.auth` compared with anything but `null`. |
| 4.4 Comparisons | `lt`, `gt` and `in` with an operand (not a literal list) on the right keep Firestore's meaning (ordering of same-type values; list or map-key membership). The prover matches these atoms by identity only, so this is consistent with it. |
| 4.4 Inlining | Lexical scope: parameters bind to the call's arguments in the caller's scope, `let`s in order. A recursive call is `opaque`. Depth limit 20. A budget of 1000 inlinings per condition, after which calls are `opaque` (stops exponential growth when functions call each other several times), and of 10000 parameter or `let` resolutions, after which a reference is `opaque` (stops `let a1 = a0 && a0; let a2 = a1 && a1; ...`). |
| 4.4 Vocabulary | A zero-parameter function becomes `{ ref }` only when the file declares that name exactly once, so a shadowing declaration is not replaced by the approved meaning. In value position the function is inlined. Limit of any name-based recognizer: editing the body of the one recognized function keeps emitting the ref; re-approving the vocabulary entry is the guard. |
| 4.4 Lookups | The database segment (`$(database)`, `(default)`) is accepted unresolved and removed: rules read only their own database, and Storage's `firestore.*` reads `(default)`. A path segment must be one literal or one interpolation of `actor.uid`, `actor.claim.*`, `resource.<f>` or `incoming.<f>` (one field deep), `param.<x>`, or a string or integer literal; anything else makes the lookup `opaque`. |
| 4.4 Opaque text | The source of the smallest sub-expression that could not be mapped, whitespace collapsed, wrapping parentheses removed. |
| 4.4 Cache | Key is the file path, the approved recognizers and the content, under the analyzer version. |
| 6.2 Golden app | Eleven rules (R-001 to R-011) and eleven breakages, one vocabulary entry (`signed-in`, recognizing `signedIn`). R-009's catch-all read is `match /{document=**}` nested under `/orgs/{orgId}`, so it overlaps only the member list among the rule targets. Storage writes have their own rule (R-011). |
| 6.2 / 2.4 Golden harness | The "unpatched skeleton" test in `packages/cli/test/golden-patch.test.ts` builds its own temporary skeleton, because `golden-firebase` is no longer empty. |
| 7 Scan summary | `holdline scan` prints, per rules file, `<file>: <n> policies, <k> opaque sub-conditions`, then `  opaque: <text> (line L)` for each distinct text (`packages/cli/src/format/policy-summary.ts`). Text is cut at 120 characters. |
| 7 Private gate | Zero error diagnostics. The opaque patterns found in a real rules set are listed below; none was both common and exactly mappable, so none was normalized. |
| 9 Testing | Soundness is checked against a model: a reference interpreter of the rules subset with Firestore's error semantics, and an `Expr` evaluator with absent = `null`. 37 normalization rows, 200 random worlds each, plus a check that each row is exactly true somewhere Firestore allows. The emulator suite (`test/emulator/`) compares the emulator with the interpreter and the `Expr`. It needs `firebase-tools` and Java 21 or newer (firebase-tools 15 refuses older Java) and is skipped, with the reason in its title, otherwise. It has not been run in this branch's development environment (Java 19). Storage rows are checked against the model only. |

Opaque patterns from the private gate, described generically:

- A lookup whose path is keyed by a field of another looked-up document (`exists(/a/$(get(/b/$(request.auth.uid)).data.x)/...)`). Most common. It needs a nested-lookup placeholder, which is a core contract change.
- List and set methods: `hasAny`, `hasAll`, `hasOnly`.
- Key presence in a map: `'f' in request.resource.data`.
- Type checks: `x is string`.
- `size()` checks, and Storage `request.resource.size` and `contentType`.
- A `.get('f', d)` whose default satisfies the comparison (correctly opaque).
- Helper functions that return a computed value (string building) used in a comparison.
- `resource == null`.

The emulator soundness suite has not been run yet (no Java 21 where it was built); until it runs, the reference interpreter is unverified against Firestore.

**Known gaps, owned elsewhere:**

- `data-access` renames a policy's params before expanding vocabulary refs, so a ref whose expression mentions `param.*` is not aligned to the rule's names (usually a false violation). The Firestore analyzer is the first to emit refs. Owner: core.

- Core's test generator evaluates atoms with absent = undefined, `in` list-only and no `lt`/`gt` (`testgen-eval.ts`). Generated cases for atoms such as `eq(x, null)` from `get('f', null) == null`, or `in` over a map field, may expect a deny where Firestore allows. The result is a red test, not a silent pass. Owner: core and Track C.
- The generator fills placeholders with `String(v)`. Firestore's own formatting of non-string values, or of values containing `/`, in `$(...)` may differ. Owner: core and Track C.
- The step 0 gap above (a Storage object path equal to a Firestore lookup path merges seeds) is reachable with `firestore.get` in Storage rules. Owner: Track C.

## As built (Track C)

Track C (section 5) is built: `packages/testkit`, `holdline test` and the invariant extension of `generateTests`. The
[test runner reference](../../reference/test-runner.md) describes the code; the
[rules file reference](../../reference/rules-file.md#test-cases-holdlineteststrule-idyaml) describes generation. This
list records where the code differs from section 5 and the decisions made while building it.

**Not done: section 1 item 2 on the golden apps.** Tracks A and B have not merged to `main`, so `golden-supabase` and
`golden-firebase` have no migrations, rules or breakages to run. That is the remaining step of Track C: rebase on
`main`, replace `packages/testkit/src/migrations.ts` (a temporary copy of Track A's `applyMigrations` behind the same
signature) with the import from `analyzer-postgres`, and add a golden test that runs `holdline test` green on each
clean app and red for each data-access rule's breakage. Item 2 is exercised today only on the hand-built fixtures
`packages/cli/test/fixtures/test-pg` and `test-fb`.

| Section | As built |
|---|---|
| 5.1 Options | `holdline test` also takes `--facts <file>` (like `check`), used only when a test file is (re)generated: invariant cases need table facts, and tests pass a facts file. Without it, generating a file scans the project. It also takes `--regenerate`, which regenerates every selected file from the current facts: `generatedFrom` hashes only the rule and vocabulary, so a hash match does not mean the file matches the current policies. |
| 5.1 Regeneration | An approved rule enforced by `test` with no test file gets one generated, reported as `generated: no test file`; a hash mismatch is reported as `regenerated: the rule changed`, and a `--regenerate` rebuild of a file whose hash is current (the facts changed) as `regenerated: --regenerate (the facts changed)` (`generated: refreshed` in JSON). A regeneration with identical text is not written or reported. `--store` filters before any generation. |
| 5.1 Approve | `holdline approve` passes the cached facts (`.holdline/cache/facts.json`, when readable) to `generateTests`, so invariant files are written at approval when a scan has run. It never scans by itself. |
| 5.1 Report | Selected rules that cannot run are visible notes (`not tested: rule is muted`, `... is not enforced by test`, `no cases can be generated for <type> rules`), and test files with no approved rule are `orphan test file` notes. When an `allow` case got `deny`, the human report adds a hint to run `holdline test --regenerate`. JSON output is `{ files, infrastructure, summary }`; the summary counts the reported rules that ran no case (`noCases`, and `(N rules have no runnable cases)` in the human line). A store that could not run is left out of `files`; exit 3 wins over failed cases. A missing worker result, a PGlite construction error and a failing migration are infrastructure failures. |
| 5.2 Migrations | The runner uses `applyMigrations` from `@holdline/analyzer-postgres` (built against a temporary copy until Track A merged). No migration files is an infrastructure failure (`no SQL migrations found ...`). |
| 5.2 Seeding | CHECK constraints stay on in replica mode, so the filler for numbers is `1` (not `0`) and a column with a CHECK `col = ANY (ARRAY['a', ...])` or `col IN ('a', ...)` gets its first literal (matched on the exact column name). `uuid` filler is `'filler'` (mapped to a UUID), arrays get `[]`, `json` gets `{}`, dates and timestamps the epoch. The filler lives in core (`testgen-filler.ts`) and is shared by the runner and the invariant generator. Seed rows are inserted with `returning` their primary key, so database-generated keys are known; identity `always` and generated columns are left out. |
| 5.2 Keys | Not "the mapped `id` field, else a UUID v5 of the table and position": every primary-key column the case does not set gets the runner's key, `uuid` → UUID v5 of `<schema>.<table>#<position>` (`#do` for the operation's row), numeric → `1000 + position` (`999`), text → `<schema>.<table>-<position>` (`-do`). Generated invariant rows leave primary-key columns out unless the rule names them or they are foreign keys. The two rows of a `unique` case share the rule's columns, and the seeded duplicate differs in every other column of the primary key and of the other unique sets in the facts (a foreign-key column `<col>-2` with its own parent row, a runner-keyed column by its key, any other column a second filler); when some other key cannot differ the reject case is skipped (`create: cannot isolate unique ...`). Without this, a primary key that is also a foreign key (the Supabase profile shape) got `<col>-1` in both rows and the primary key refused the insert, so the case passed with no unique constraint. |
| 5.2 Values | The stable integer for a numeric column is in 1..30000 (fits `smallint`). `json`/`jsonb` values are sent as JSON text; `<type>[]` maps each element. A claim whose string value was mapped to a UUID elsewhere in the case gets the same UUID, so `auth.jwt() ->> 'org_id' = org_id::text` agrees with the seeded `uuid` column. The shim reads `request.jwt.claims` (not `request.jwt.claim.*`). |
| 5.2 Operations | `update` and `delete` run with no `WHERE` clause, so Postgres applies only that op's policies and not the `SELECT` policies a `WHERE` would bring in; the record is checked afterwards as superuser (`reset role`): a new `ctid` means updated, a missing row means deleted. When the case seeds several rows of the table, a refused `update` or `delete` is `error` (the runner cannot tell which row was refused). Record keys come from `insert … returning`, and a record its key cannot find is `error`. `list` with no seed row of the table is `error`; a table without a primary key is `error`. `read`/`list` refused with `42501` is `deny`. |
| 5.2 Reject | `reject` passes on any of the five constraint SQLSTATEs (`23502`, `23503`, `23505`, `23514`, `22P02`) on `create` and `update`: the case format has no code field, and the allow case proves the complete row is valid. A reject case changes only the broken column for `not-null`, `fk` and `enum`; a `unique` case's seeded duplicate also differs in the other keys (5.2 Keys) so no other constraint can refuse it, and an `fk` case another foreign key covers is skipped (`create: cannot isolate fk ...`). Invariant cases run as superuser with `session_replication_role = origin` and keep a `WHERE` on the key for `update` and `delete`. |
| 5.3 Emulator | When the emulator variables are not set, `holdline test` does not re-run itself: it starts a worker process inside `firebase emulators:exec` (`node --import tsx firebase-worker.ts in.json out.json`), in a temp directory with a generated `firebase.json` (free ports including the Firestore websocket, UI off, deny-all rules for a store with no rules) and a private `TMPDIR`, so runs side by side do not share Storage blobs, and reads the results from a file. `emulators:exec` runs that command through a shell, so each word is single-quoted (`'` written as `'\''`). The CLI is also called in process by tests, and the worker gets exactly the Firebase files. The run times out after 180 s; on a timeout and whenever the run ends, the members of the CLI's process group and any process naming the run directory (the detached Firestore JVM) are stopped, plus the CLI's descendants on a timeout while it still runs. A process outside the group that does not name the run directory is missed. firebase-tools 15 needs Java 21 or later: with an older JDK the emulator does not start and `holdline test` exits 3 with the install hint. |
| 5.3 Rules files | One rules file per store: the config's `rules` globs (more than one match is a config error), else `firebase.json`'s `rules` path, else `<store>.rules` at the root. Firestore files never run without Firestore rules and Storage files never without Storage rules (an infrastructure failure: a running emulator would keep its old rules). Storage runs also load the Firestore rules, which Storage rules read. |
| 5.3 Per case | `clearStorage()` too when Storage files run. Deny means the error code `permission-denied` or `storage/unauthorized`; any other failure is `error`, which fails the case. `deny` and `reject` cases both pass on deny. `as.role` is not sent. Storage `list` is `listAll`; create and update upload an empty object with `data` as custom metadata. |
| 5.3 Storage metadata | Seed and request `data` becomes custom metadata: strings as is, numbers and booleans as strings, `null` dropped, other values as JSON (custom metadata values are strings). In Storage files only `store: storage` seeds are uploaded; `store: firestore` seeds are documents. |
| 5.4 Generation | `generateTests(rule, vocab, facts?)`. Postgres invariant cases are `create` cases with `as: null`; every foreign key the valid row sets gets a seeded parent row; `unique` seeds a duplicate that shares the rule's columns, then inserts the valid row; `fk` uses `missing-1`, ...; a table missing from the facts is skipped with a reason pointing to `holdline scan` and `--regenerate`. `unique` and `fk` reject cases are isolated from the table's other keys and foreign keys, or skipped (5.2 Keys, 5.2 Reject). Firestore invariant cases satisfy the first usable `create` policy in the facts, with its path params renamed to the target's (`FactIndex.alignedPolicies`) and passing over a policy that reads a param the target lacks; a deny case is skipped when another create policy allows the denied write or cannot be evaluated. Storage invariants are skipped ("storage invariants are not generated; check them statically"): the section lists Firestore invariants only. |
| 5.4 Data-access with facts (added during implementation) | Allow cases failed on the emulator when the store's policy needed more than the rule names (a create rule that also checks `status`). With facts, each op's allowed world also satisfies the first of the target's policies for that op that is only an `and` of atoms, uses no path param the target lacks, can be satisfied with the rule and adds no per-op skip. Policy path params are renamed to the target's (`FactIndex.alignedPolicies`), and an atom equivalent to a rule atom (`a == b`, `b == a`) is the rule atom. Deny cases stay one per rule atom with the same names. Code: `packages/core/src/testgen-policy.ts`. |
| As built (step 0) known gap | Fixed first, as planned: the record merge (an `exists` or lookup on the record's own path) applies only to Firestore targets. |
| 9 Testing | As planned, the CI workflow installs Temurin Java 21 (`actions/setup-java@v4`) and firebase-tools 15 (`npm install -g firebase-tools@15`), so the `@emulator` suites run there. They skip only when the tools are missing (`toolsMissing` in `packages/testkit/src/emulator.ts`: no firebase-tools, no Java, or an emulator refusing the Java version), each test with the reason, printed once on stderr; any other infrastructure failure fails the suite. Locally they were run on Java 19 with firebase-tools 13 on `PATH`. `@firebase/rules-unit-testing` 6 and the `@firebase/*` packages of `firebase` 13 declare Node 24.12 or later; the repo runs and tests on Node 22. The model-based prover test in `logic.test.ts` got a longer timeout, as the PGlite suites slow the parallel run. |

Known limits left by Track C:

- Column types the filler does not know (`time`, `interval`, `bytea`, `inet`, ...) get `'x'`, which fails at run time
  as `error`, not as a skip.
- An in-process emulator run has no timeout, and Ctrl-C does not stop an emulator group started by `emulators:exec`.
- `list` on Postgres is allowed when any seeded row of the table is visible; `update` that changes a primary-key
  column is checked by the old key.
- Postgres access cases run in `session_replication_role = replica` through the operation, so triggers are off and a
  trigger that would refuse a write is bypassed.
