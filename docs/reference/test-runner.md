# Test runner reference (`holdline test`)

`holdline test` runs the generated database test cases in `.holdline/tests/<rule id>.yaml` (format and generation:
[rules file reference, Test cases](rules-file.md#test-cases-holdlineteststrule-idyaml)) against a real database:
Postgres cases on PGlite in process, Firestore and Storage cases on the Firebase emulator. No model decides a result:
each case's outcome is what the database or the emulator did.

The command lives in `packages/cli/src/commands/test.ts` (selection in `packages/cli/src/test-files.ts`, output in
`packages/cli/src/format/test-report.ts`). The runners are `@holdline/testkit` (`packages/testkit`), which only
`holdline test` loads.

## Command

```
holdline test [--rule <ids...>] [--store postgres|firestore|storage] [--format human|json] [--facts <file>] [--regenerate]
```

| Option | Effect |
|---|---|
| `--rule <ids...>` | Only these rules. An id not in `holdline.rules` is a usage error (`no rule <id>`) |
| `--store <store>` | Only rules whose target is in this store (`postgres`, `firestore` or `storage`). Applied before any file is generated |
| `--format <format>` | `human` (default) or `json` |
| `--facts <file>` | The facts used when a test file is generated. Without it, generating a file scans the project (as `holdline scan` does, which also updates `.holdline/cache/facts.json`). Facts are loaded at most once per run, and only when a file is generated: a missing or malformed facts file is detected only then, and a run whose files are all current never reads it |
| `--regenerate` | Regenerate every selected test file from the current facts, even when its `generatedFrom` hash is current |

## Which rules run

| Rule | What happens |
|---|---|
| Without `--rule`: every rule whose effective `enforce` includes `test` (by default `data-access` and `invariant`) | Its test file runs |
| With `--rule`: each named rule | Its test file runs |
| A selected rule that is not `approved` | Note: `not tested: rule is muted` |
| A rule named with `--rule` whose `enforce` leaves out `test` | Note: `not tested: rule is not enforced by test` |
| A selected rule of a type that generates no cases (`access`, `visibility`, `flow`) | Note: `not tested: no cases can be generated for <type> rules` |
| Without `--rule`: a test file whose id has no approved rule (and no note above) | Note: `orphan test file: no approved rule <id>; delete .holdline/tests/<id>.yaml`. With `--store`, only files of that store |

A note is reported like a file with no cases and the note as its skip reason. It does not change the exit code.

A file in `.holdline/tests/` that does not parse is a usage error naming the file.

## Generation before running

A selected rule's file is (re)generated, deterministically, before it runs when:

| Condition | Report label |
|---|---|
| The file does not exist | `generated: no test file` |
| Its `rule` is another id, or its `generatedFrom` differs from the rule's current `hashRule` | `regenerated: the rule changed` |
| `--regenerate` is given and the hash is current | `regenerated: --regenerate (the facts changed)` when the new text differs; no label when it is the same |

A regeneration whose text equals the existing file does not write it and is not labeled. `invariant` and
`data-access` rules are generated with facts (`generateTests(rule, vocab, facts)`): invariant cases need the table or
the create policy, and data-access allow cases also satisfy the op's real policy. `generatedFrom` hashes only the rule
and the vocabulary, so a file reflects the facts it was generated with: after changing policies or migrations, run
`holdline test --regenerate`. `holdline approve` also writes test files, with the cached facts of the last scan when
`.holdline/cache/facts.json` is readable; it never scans by itself.

## Exit codes

| Exit | When |
|---|---|
| 0 | Every case passed (notes and skip reasons allowed) |
| 1 | A case failed |
| 2 | Usage or config error: unknown option value (`--format`, `--store`), unknown `--rule` id, a test file that does not parse, a missing or malformed `--facts` file (when a file must be generated), a malformed `holdline.rules` or `.holdline/config.yaml`, more than one file matching the `rules` globs of the config's `firestore` or `storage` section |
| 3 | A runner could not run (see Infrastructure failures), or an internal error. Exit 3 wins over failed cases |

## Report

Files are listed in `holdline.rules` order; orphan notes come last.

Human format:

```
R-001 postgres: 3 passed
R-002 firestore: 2 passed, 1 failed (regenerated: --regenerate (the facts changed))
  ✗ create: allowed when every condition holds: expected allow, got deny: Property status is undefined on object
  - skipped: list: needs query filters to test; read cases cover the condition
R-007: no cases
  - skipped: not tested: no cases can be generated for access rules

allow cases are built from the facts when the file was generated; after changing policies run holdline test --regenerate

Could not run:
  storage: Java is not installed: install firebase-tools ...

5 passed, 1 failed in 3 rules (1 rule has no runnable cases)
```

| Line | Shown when |
|---|---|
| `<rule> <store>: <counts>` | Every file and note. Counts are `N passed`, `N passed, M failed` or `no cases`, followed by the generation label |
| `✗ <case>: <detail>` | Each failed case. Multi-line database or emulator messages are indented under it |
| `- skipped: <reason>` | Each of the file's `skipped` reasons, and each note |
| The `--regenerate` hint | Some `allow` case got `deny` (often a file generated against older policies) |
| `Could not run:` | Infrastructure failures, one line per failure (a store can have more than one) |
| Summary | Always: passed and failed cases, and the number of reported rules (notes included). When some reported rules ran no case (notes, or files whose cases were all skipped), `(N rule(s) has/have no runnable cases)` follows |

JSON format (`--format json`):

```json
{
  "files": [
    { "rule": "R-002", "store": "firestore", "generated": "refreshed",
      "cases": [{ "name": "...", "expect": "allow", "actual": "deny", "passed": false, "detail": "expected allow, got deny: ..." }],
      "skipped": ["..."] }
  ],
  "infrastructure": [{ "store": "storage", "message": "..." }],
  "summary": { "passed": 5, "failed": 1, "rules": 3, "noCases": 1 }
}
```

| Field | Notes |
|---|---|
| `files[].store` | Left out only for a note on a rule without a data target (an `access` rule named with `--rule`) |
| `files[].generated` | `missing`, `changed` (the rule's hash differed) or `refreshed` (`--regenerate` with a current hash), only when the file was written in this run |
| `cases[].actual` | `allow`, `deny`, `reject` or `error`. `error` always fails the case: the database or emulator did something other than allow or refuse (a seed failed, an unknown column, an ambiguous refusal) |
| `cases[].detail` | Only on failed cases |
| `infrastructure` | Stores that could not run. Their files are left out of `files`: their cases did not pass or fail |
| `summary.noCases` | Reported rules with no case that ran (notes and files whose cases were all skipped); counted in `summary.rules` |

## Infrastructure failures

A runner that cannot start is reported under `infrastructure`, separately from case results, and the exit is 3.

| Store | Message starts |
|---|---|
| postgres | `no SQL migrations found (set postgres.migrations in .holdline/config.yaml)` |
| postgres | `migration <file> failed: <message>` (with ` at position N` when Postgres gives one) |
| postgres | `the Postgres runner could not start: ...` (PGlite could not be created) or `the Postgres runner failed: ...` |
| firestore, storage | `no firestore rules file found`, `no storage rules file found` |
| firestore, storage | `firebase-tools is not installed: <hint>`, `Java is not installed: <hint>` |
| firestore, storage | `the Firebase emulator did not start: <last 15 output lines>`, plus the hint when the output mentions Java |
| firestore, storage | `the Firebase emulator run timed out after 180 s: ...` |
| firestore, storage | `the Firebase worker wrote an invalid result: ...`, `the emulator worker returned no results for <rule>` |
| firestore, storage | `the Firebase emulator could not be used: ...` (an emulator named by the environment variables) |

The hint: install firebase-tools (`npm install -g firebase-tools`) and a JDK 21 or later, or start the emulators
yourself and set `FIRESTORE_EMULATOR_HOST` and `FIREBASE_STORAGE_EMULATOR_HOST`.

## Postgres runner

Each test file runs on a fresh PGlite with the project's migrations applied. Each case runs in its own transaction,
rolled back after the case.

### Migrations

| Detail | Value |
|---|---|
| Files | `postgres.migrations` globs from `.holdline/config.yaml`, else `supabase/migrations/*.sql`, `prisma/migrations/*/migration.sql`, `drizzle/*.sql`, `migrations/*.sql`, `db/migrations/*.sql`. Sorted by path, each applied in its own transaction |
| Dialect | `postgres.dialect` from the config, else `supabase` when any file is under `supabase/migrations/`, else `plain` |
| Supabase shim (before the migrations) | Schemas `auth`, `storage`, `extensions`; roles `anon`, `authenticated`, `service_role`; `auth.uid()` (the `sub` claim as uuid), `auth.jwt()`, `auth.role()` read `request.jwt.claims`; table `auth.users (id uuid primary key, email text)` |
| Roles | `supabase`: `anon` and `authenticated`. `plain`: `holdline_actor`, created by the runner. Either gets usage and all privileges on the tables and sequences of every project schema (not `auth`, `storage`, `extensions`, `information_schema`, `pg_*`) |

The migration code is `packages/testkit/src/migrations.ts`, a temporary copy of `analyzer-postgres`'s `applyMigrations`
until that package is on `main`.

### Per case

1. **Seed as superuser** with `session_replication_role = replica` (foreign keys and triggers off; CHECK constraints
   stay on). Each seed row is completed (see Values and filler) and inserted with `returning` its primary key, so
   a key the database generates is known.
2. **Map the operation's row:** `create` data is completed like a seed; `update` data is only mapped.
3. **Act:** data-access cases switch to the case's actor (below). Invariant cases stay superuser and set
   `session_replication_role = origin`, so foreign keys are checked.
4. **Do the operation**, as below. A seeding failure is `error` (`seed <path> failed: ...`).

Acting as the actor:

| `as` | `supabase` | `plain` |
|---|---|---|
| a user | `set local role authenticated`; `request.jwt.claims` = the case's claims plus `sub` and `role` | `set local role holdline_actor`; the same claims |
| `null` | `set local role anon`; claims `{ "role": "anon" }` | `set local role holdline_actor`; no claims |

`sub` is `as.uid` when it is a UUID, else its UUID v5; `role` is `as.role`, default `authenticated`. A claim whose
string value (or array element) was mapped to a UUID elsewhere in the case gets that UUID, so
`auth.jwt() ->> 'org_id' = org_id::text` agrees with the seeded row.

Operations (data-access cases):

| `do.op` | Statement, as the actor | allow | deny |
|---|---|---|---|
| `read` | `select 1 from <table> where <primary key> = <record key>` | the row is returned | no row, or `42501` |
| `list` | `select <primary key> from <table>` | any seeded row of `do.path` is returned | none returned, or `42501` |
| `create` | `insert` of the completed row | it succeeds | `42501` (RLS or privilege) |
| `update` | `update <table> set <data>`, with no `WHERE` | the record's `ctid` changed (checked after `reset role`) | it did not, or `42501` |
| `delete` | `delete from <table>`, with no `WHERE` | the record is gone (checked after `reset role`) | it is still there, or `42501` |

| Detail | Value |
|---|---|
| The record | The first seed row of `do.path`, found by its primary key as superuser before acting. Not found is `error` |
| Why no `WHERE` | Postgres applies `SELECT` policies to an `UPDATE` or `DELETE` that reads columns; without a `WHERE` only that op's policies apply, matching a per-op data-access rule |
| `update` with no data | Writes the record's own value to one column (the first non-key column it has) |
| Several seed rows of the table | A refused `update` or `delete` (an error code) is `error`: the runner cannot tell which row the policy refused |
| No seed row of `do.path` (`read`, `list`, `update`, `delete`) | `error` (`no seed row of <table> to <op>`) |
| Table without a primary key | `error` for `read`, `list`, `update` and `delete` (the record is found by its key); `create` needs no key |
| `reject` | `create` and `update` only: the statement fails with `23502` (not null), `23503` (foreign key), `23505` (unique), `23514` (check) or `22P02` (invalid input, an enum label). The case format has no code field, so any of the five passes a `reject` case |
| Any other failure | `error` |

Invariant cases run as superuser (so RLS does not apply) and keep a `WHERE` on the record's key for `update` and
`delete`. The generator produces only `create` invariant cases.

### Values and filler

Generated test values are strings (`user-1`, `value-1`, `orgId-1`). The runner maps each value to the column's type:

| Column type | Value |
|---|---|
| `uuid` | A UUID as is; any other string becomes its UUID v5 (fixed namespace, name `holdline:<value>`). The case remembers the mapping for claims |
| numeric (`smallint` … `double precision`, `serial`) | A string becomes a stable integer in 1..30000 (fits `smallint`); a number stays |
| `json`, `jsonb` | The value as JSON text |
| `<type>[]` | Each element mapped as `<type>` |
| anything else | The value as is; `null` stays `null` |

Completing a row (a seed or a `create` row), for each column the case does not set:

| Column | Value |
|---|---|
| Identity `always`, or generated | Left out |
| Primary-key column | The runner's key: `uuid` → UUID v5 of `<schema>.<table>#<seed position>` (`#do` for the operation's row); numeric → `1000 + seed position` (`999` for the operation's row); otherwise `<schema>.<table>-<seed position>` (`-do`) |
| `NOT NULL`, no default, not identity | Filler, then mapped as above |
| Any other column | Left out |

Filler (`fillerValue` in `packages/core/src/testgen-filler.ts`, shared with the invariant generator so generated and
runtime-completed rows agree):

| Column | Filler |
|---|---|
| `<type>[]` | `[]` |
| Enum type | Its first label |
| A CHECK `col = ANY (ARRAY['a', ...])` or `col IN ('a', ...)` on the exact column | The first literal |
| `uuid` | `'filler'` (mapped to a UUID) |
| numeric | `1` (not `0`: `amount > 0` checks are common and CHECKs stay on while seeding) |
| `boolean` | `false` |
| `timestamp…` | `1970-01-01T00:00:00Z` |
| `date` | `1970-01-01` |
| `json`, `jsonb` | `{}` |
| anything else | `'x'` |

## Firestore and Storage runner

Uses `@firebase/rules-unit-testing` (v6) with project id `holdline-test`. Every Firestore and Storage file of a run
goes to the emulator in one batch.

### Rules files

One rules file per store, found in this order:

1. The `rules` globs of the `firestore` / `storage` section of `.holdline/config.yaml`: at most one file may match (more
   is a config error, exit 2).
2. The `rules` path of the `firestore` / `storage` section of `firebase.json` (the first entry when the section is an
   array), when that file exists.
3. `firestore.rules` / `storage.rules` at the project root.

Firestore files never run without Firestore rules (an already running emulator would keep the rules it has), and
Storage files never run without Storage rules: both are infrastructure failures. Storage rules read Firestore
(`firestore.get`, `firestore.exists`), so a run with Storage files also loads the Firestore rules when there are any.

### Emulator

| Situation | What runs |
|---|---|
| `FIRESTORE_EMULATOR_HOST` is set (and `FIREBASE_STORAGE_EMULATOR_HOST` when Storage files run) | The cases run in process against those emulators |
| Otherwise | `firebase emulators:exec --only firestore,storage --project holdline-test` in a temp directory, with a generated `firebase.json` (free ports, the Firestore websocket port included, UI off, the project's rules or deny-all rules for a store with none) and its own `TMPDIR` (firebase-tools keeps Storage blobs and the hub locator there), so runs side by side do not collide. The command it runs is a worker (`node --import tsx firebase-worker.ts in.json out.json`, each word single-quoted for the shell `emulators:exec` runs it through) that runs the cases and writes the results to a file. The run times out after 180 s. On a timeout, and whenever the run ends, Holdline stops the members of the CLI's process group and any process whose command line names the run's temp directory (the Firestore JVM runs in its own process group, outlives a CLI that crashed, and names the run's rules file). On a timeout while the CLI still runs, its descendants are stopped too. A process that left the group and does not name the run directory is not found. SIGTERM, then SIGKILL after 5 s for whatever is still the same process; a pid that may have been reused is never signalled |
| `firebase` or `java` is not on `PATH` | Infrastructure failure with the hint |

firebase-tools 15 needs Java 21 or later. With an older JDK the emulator does not start: `holdline test` exits 3 with
the emulator's output and the hint.

On its first run, firebase-tools may download the emulator JARs into its own cache. That is firebase-tools' doing:
Holdline's own code only talks to the emulators on `127.0.0.1`.

`@firebase/rules-unit-testing` 6 and the `@firebase/*` packages of `firebase` 13 declare Node 24.12 or later in
`engines`. The repo and CI run Node 22, where the runner works.

### Per case

1. `clearFirestore()`, and `clearStorage()` when the run includes Storage.
2. Seed with rules disabled: in Storage files a seed with `store: storage` is uploaded as an empty object; every other
   seed is a Firestore document (`setDoc`).
3. Act with `authenticatedContext(as.uid, as.claims)`, or `unauthenticatedContext()` for `as: null`. `as.role` has no
   Firestore meaning and is not used.
4. Do the operation:

| `do.op` | Firestore | Storage |
|---|---|---|
| `read` | `getDoc(doc(path))` | `getMetadata(ref(path))` |
| `list` | `getDocs(collection(path))` | `listAll(ref(path))` |
| `create` | `setDoc(doc(path), data)` | `uploadString(ref(path), '')` with `data` as custom metadata |
| `update` | `updateDoc(doc(path), data)` | `uploadString(ref(path), '')` with `data` as custom metadata |
| `delete` | `deleteDoc(doc(path))` | `deleteObject(ref(path))` |

| Outcome | Meaning |
|---|---|
| allow | The call succeeded |
| deny | It failed with `permission-denied` (Firestore) or `storage/unauthorized` (Storage) |
| error | Any other failure, or seeding failed |

`allow` cases pass on allow. `deny` and `reject` cases both pass on deny: the emulator only refuses a request.

Custom metadata holds strings only, so Storage seed and request `data` is converted: strings as is, numbers and
booleans as strings, `null` dropped, other values as JSON text.

## Known limits

- Access cases (`data-access`) run with `session_replication_role = replica` from seeding through the operation (only
  invariant cases switch back to `origin`), so triggers and foreign keys are off: a trigger that would refuse a write
  is bypassed, and the case reports what the policies and privileges alone allow.
- Column types the filler does not know (`time`, `interval`, `bytea`, `inet`, ...) get `'x'`, which fails at run time
  as `error`, not as a skip.

## Tests of the runner

`@emulator` suites (`packages/testkit/test/firebase-runner.test.ts`, `packages/cli/test/test-command-firebase.test.ts`)
need firebase-tools and a JDK the installed firebase-tools accepts. They skip only when the tools are missing
(`toolsMissing` in `packages/testkit/src/emulator.ts`: `firebase-tools is not installed`, `Java is not installed`, or an
emulator that did not start because of the Java version): each test skips with the reason, printed once on stderr
(`@emulator tests skipped: ...`). Any other infrastructure failure (a timeout, an invalid or missing worker result, an
emulator that could not be used) fails the suite with its message. The CI workflow installs Temurin Java 21 and
firebase-tools 15, so they run there. The Postgres suites need nothing beyond `pnpm install`.
