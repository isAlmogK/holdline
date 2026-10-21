# Holdline: Feature and Core Design

**Status:** Phase 0 implemented (2026-10-21). Phases 1 to 5 are not built yet; see [As built](#as-built-phase-0).

**Repos:** holdline (this spec: the feature and the core) · dogbase (adoption, its own spec in that repo, written after Phase 1)

**Specs in this repo:**

| # | Spec | Covers |
|---|---|---|
| 1 | This one | Why, user flow, scope, fact graph, rule model, checkers, DB tests, CLI, inference flow |
| 2 | Data layers | `analyzer-postgres` (schema, constraints, RLS), `analyzer-firestore` (Firestore and Storage rules, collections), the DB test runner |
| 3 | Code analyzers | `analyzer-ts`, `analyzer-go`, `analyzer-py` |
| 4 | Integrations | Claude Code plugin and hook, inference skill, MCP server, GitHub Action, `init` |
| 5 | Proof and launch | Golden apps at scale, benchmark, README, docs site, launch |

Specs 2 to 5 build on the contracts in this spec (fact graph, rule model, result format). Those contracts are frozen at the end of Phase 0; changing one after that needs an update here first.

Earlier research (market research and a first implementation plan) is kept privately; where this spec differs from that first plan, the differences are listed in [Decisions](#decisions).

## 1. Why

AI agents now write most changes in many codebases. They keep tests green and still break business rules nobody wrote down: who may transfer a dog, which records a user may read, that deleted records never come back. Instruction files (CLAUDE.md, AGENTS.md) state rules but don't enforce them. CI enforces only what someone wrote a check for. AI reviewers give an opinion per PR, not a guarantee.

Holdline discovers the business rules already in a codebase, gets them approved in plain language, and enforces them deterministically every time an agent or a person changes the code.

**One line:** AI reviewers might notice when an agent breaks your business rules. Holdline makes sure the rules you approved can't be broken silently.

**Goal of the project:** an open source tool teams adopt because it makes AI-written changes safe to merge. That means launch quality matters as much as features: the most used stacks (Postgres first), a reproducible benchmark, and a real production case study (DogBase).

**DogBase** is the first real user and the case study. It is a production SaaS built on Go (Echo), TypeScript (Cloud Functions, SvelteKit, Expo/React Native), Firestore and Cloud Storage. It is not the scope; it is the proof.

## 2. User flow

### Install

Claude Code (primary):
```
/plugin marketplace add holdline/holdline
/plugin install holdline
```
Everyone else: `npx holdline init`. Details of `init` and each integration are in spec 4.

### First run

1. `holdline scan` reads the code and writes a fact graph. No network, no LLM.
2. The user's own agent proposes rules from the facts (section 8). In Claude Code a skill drives this; elsewhere an MCP prompt or `holdline infer --prompt | claude -p`.
3. Holdline validates every proposal and runs its checker against today's code.
4. The user reviews them in plain language:

```
Found 12 rules. Review them:

✓ Only account members can read the account's dogs     firestore: /accounts/{a}/dogs/{d}
✓ Every dog belongs to exactly one team                  pg: dogs.team_id (NOT NULL, FK)
✓ Deleted dogs are never returned by the API             3 read paths
? Any signed-in user can read share tokens               ← broken today, keep as a rule?

[a]pprove all  [r]eview one by one  [e]dit
```

A proposed rule that fails its own check on today's code is shown as a question. That is the "aha": the first run often finds a real gap.

### Daily use

- After each agent edit, the hook runs `holdline check --changed`. A violation goes back to the agent as structured feedback, and the agent fixes it before the user sees anything.
- On each PR, the Action runs `holdline check` and `holdline test`, and comments only when something breaks.

### Changing a rule

The user asks for new behavior ("let team leads transfer dogs"). The agent proposes a rule change (`holdline propose`, or `propose_rule_change` over MCP). The user approves it. `holdline.rules` and the generated tests change together. A rule never changes without an approval (section 6.4).

## 3. Scope for v0.1

### Support matrix

| Layer | v0.1 |
|---|---|
| Postgres | Plain SQL migrations, plus the migration output of Prisma, Drizzle, Alembic (SQLAlchemy), Django and sqlc. Tables, columns, foreign keys, NOT NULL, UNIQUE, CHECK, enums, triggers, RLS policies (covers Supabase) |
| Firestore | `firestore.rules`, `storage.rules`, collections inferred from SDK calls and typed converters |
| TypeScript | Express, Fastify, Next.js route handlers, SvelteKit server routes and actions, Firebase Cloud Functions; Firestore SDK calls in React Native and web clients |
| Go | Echo, gin, chi, net/http; Firestore Go client; sqlc and GORM |
| Python | FastAPI, Django; SQLAlchemy and Django ORM |

### Out of scope for v0.1

- Generated tests for application handlers. Handler code is checked statically; the database layer carries the runtime proof (section 7).
- Flask, Java/Kotlin, C#, MongoDB, frontend UI rules, runtime guards in production
- Holdline calling a model API itself (BYOK). Inference runs in the user's agent.
- Hosted service, dashboard, accounts
- Writing specs for greenfield projects

## 4. Architecture

```
  analyzers (deterministic, per stack)
  postgres · firestore · ts · go · py
            │  facts (one format)
            ▼
  ┌──────────────── core ────────────────┐
  │ fact graph · rule model · checkers   │◀── proposals from the user's agent
  │ test generator · result formatter    │
  └───────┬──────────────┬───────────────┘
          │              │
       cli            testkit (PGlite, Firestore emulator)
          │
  plugin/hook · MCP server · GitHub Action   (spec 4)
```

Three layers, and only one of them uses a model:

| Layer | Deterministic | Who runs it |
|---|---|---|
| Analysis: code → facts | Yes | Holdline |
| Inference: facts → proposed rules | No | The user's agent |
| Enforcement: rules + facts → pass or fail | Yes | Holdline |

No model ever decides whether a check passes.

### Packages

```
holdline/
  packages/
    core/                 fact graph, rule model, predicate logic, checkers, test generator, results
    cli/                  the holdline command
    testkit/              runs generated DB tests (PGlite, Firestore emulator)
    analyzer-postgres/    spec 2
    analyzer-firestore/   spec 2
    analyzer-ts/          spec 3
    analyzer-go/          spec 3 (Go helper binary)
    analyzer-py/          spec 3 (Python helper)
    plugin/ mcp/ action/  spec 4
  examples/               golden apps (section 11)
  bench/                  spec 5
  docs/
  CLAUDE.md               constitution for agents working on Holdline
```

**Stack:** TypeScript on Node 20+, pnpm workspaces, Vitest, zod (schemas, also exported as JSON Schema for agents), `yaml`, PGlite, Changesets. License Apache 2.0.

**Analyzer contract:** an analyzer is a package exporting `detect(root): boolean` and `analyze(files, ctx): Promise<Facts>`. Helpers in other languages (Go, Python) run as child processes that print facts as JSON on stdout. Core never imports language tooling.

## 5. Fact graph

The fact graph is the contract between analyzers and everything else. Every analyzer emits the same shape; the checkers never know which language produced a fact.

### 5.1 Symbols and stable ids

Every fact hangs off a symbol with an id that survives ordinary refactors (moving lines, reformatting, editing a body). Ids use names, not line numbers:

| Kind | Id example |
|---|---|
| Route | `route:POST /dogs/:id/transfer` |
| Function or method | `go:example.com/api/handlers.TransferDog`, `ts:functions/src/dogs#transferDog` |
| Postgres table, column, policy | `pg:public.dogs`, `pg:public.dogs.team_id`, `pg:public.dogs#policy:dogs_select_member` |
| Firestore match block | `firestore:/accounts/{accountId}/dogs/{dogId}` |
| Storage match block | `storage:/accounts/{accountId}/files/{path=**}` |

Every symbol also carries a location (file, start and end line) for display and a content hash for caching. Locations are evidence; ids are identity.

### 5.2 Fact types

```ts
type Facts = {
  version: 1
  analyzers: { name: string; version: string }[]
  symbols: Symbol[]       // id, kind, lang, location, hash
  routes: Route[]         // id, method, path, handler, middleware[], framework, kind: http | callable | trigger
  guards: Guard[]         // at (symbol), requires: Expr, evidence
  dataOps: DataOp[]       // in (symbol), store, target, op, filters: Expr, evidence
  calls: [from: string, to: string][]
  tables: Table[]         // columns, foreign keys, uniques, checks, enums, rlsEnabled
  collections: Collection[]  // path pattern, known fields, source (converter | inferred)
  policies: Policy[]      // store: pg-rls | firestore | storage, target, ops, condition: Expr, functions used
  diagnostics: Diagnostic[]  // files or constructs an analyzer could not read
}
```

`op` is one of `read`, `list`, `create`, `update`, `delete`. `write` in Firestore rules expands to `create`, `update`, `delete`; `read` expands to `get` (`read`) and `list`.

### 5.3 Predicate expressions

Guards, policies and data-op filters all carry conditions. Analyzers normalize them into one small expression language so a Firestore rule, an RLS policy and an Echo middleware can be compared with the same logic.

```ts
type Expr =
  | { and: Expr[] } | { or: Expr[] } | { not: Expr }
  | { atom: Atom }
  | { ref: string }                 // a named predicate from the vocabulary (6.2)
  | { opaque: string }              // a condition the analyzer could not normalize

type Atom =
  | { op: 'authenticated' }
  | { op: 'eq' | 'ne' | 'in' | 'lt' | 'gt'; left: Operand; right: Operand }
  | { op: 'exists'; doc: PathPattern }        // Firestore get()/exists(), SQL EXISTS subquery
  | { op: 'isNull'; operand: Operand }

type Operand =
  | 'actor.uid' | `actor.claim.${string}` | 'actor.role'
  | `resource.${string}`            // the stored record
  | `incoming.${string}`            // the data being written
  | `param.${string}`               // path or route parameter
  | { literal: string | number | boolean | null | (string | number)[] }
```

Mapping examples:

| Source | Normalized |
|---|---|
| `request.auth.uid == resource.data.ownerId` (Firestore) | `eq(actor.uid, resource.ownerId)` |
| `auth.uid() = owner_id` (RLS) | `eq(actor.uid, resource.owner_id)` |
| `exists(/databases/$(database)/documents/accounts/$(accountId)/members/$(request.auth.uid))` | `exists(/accounts/{param.accountId}/members/{actor.uid})` |
| `if user.Role != "admin" { return echo.ErrForbidden }` | `in(actor.role, ["admin"])` |
| `.where('deletedAt', '==', null)` | `isNull(resource.deletedAt)` |

Anything an analyzer can't normalize becomes `opaque` with its source text. An opaque condition never satisfies a requirement (section 7.1), so it can't produce a false pass; it can produce a violation, which the vocabulary fixes (6.2).

## 6. Rule model: `holdline.rules`

YAML at the repo root. Readable, reviewed in PRs, written only by the tool.

### 6.1 Example

```yaml
version: 1

vocabulary:
  - id: account-member
    text: Caller is a member of the record's account
    expr: { atom: { op: exists, doc: "/accounts/{param.accountId}/members/{actor.uid}" } }
    recognize:
      - firestore-function: isAccountMember
      - symbol: go:example.com/api/middleware.RequireAccountMember

rules:
  - id: R-001
    text: Only account members can read the account's dogs
    type: data-access
    target: { store: firestore, path: "/accounts/{accountId}/dogs/{dogId}" }
    ops: [read, list]
    requires: { ref: account-member }
    enforce: [static, test]
    evidence: ["firestore:/accounts/{accountId}/dogs/{dogId}"]
    status: approved
    approved: { by: almog, at: 2026-10-21, hash: 9f2c41 }
```

### 6.2 Vocabulary

Real codebases wrap checks in helpers (`isAccountMember()`, `RequireRole("admin")`, a FastAPI dependency). The vocabulary names those predicates once and tells analyzers how to recognize them. When an analyzer meets a recognized function or symbol, it emits `{ ref: <id> }` instead of `opaque`.

Vocabulary entries are proposed by the agent during inference and approved by the user like rules. This is how Holdline handles helpers it has never seen without a per-framework plugin for each.

### 6.3 Fields

| Field | Meaning |
|---|---|
| `id` | `R-###`, assigned by Holdline, never reused |
| `text` | The rule in plain language. This is what the user approves |
| `type` | One of the five types in section 7 |
| `target` | What the rule is about: a route selector, a symbol, a table, a collection path |
| `ops` | Which operations it covers, when the type uses them |
| `requires` | An `Expr` the target's conditions must imply |
| `enforce` | Any of `static`, `test`, `audit`. Defaults per type (section 7) |
| `evidence` | Symbol ids that showed the rule at inference time |
| `status` | `pending`, `approved`, `muted` (with `reason`) |
| `approved` | Who approved it, when, and a hash of the rule's fields |

### 6.4 Rules never change silently

`approved.hash` is a hash of the rule's normalized fields. If someone or something edits an approved rule without going through `holdline approve`, the hash no longer matches and `check` fails with `unapproved-edit`. In CI the Action also lists every rule added, changed or removed in the PR, so a human sees rule changes in review. This is tamper evidence, not security: the goal is that no change to a rule goes unnoticed.

## 7. Rule types and enforcement

### 7.1 Implication

Every checker reduces to one question: does the condition in the code imply what the rule requires? Implication is structural and conservative:

- An atom implies an equal atom (`eq` is symmetric).
- `in(x, A)` implies `in(x, B)` when A is a subset of B, and `eq(x, v)` implies `in(x, B)` when v is in B. Code that allows only admins satisfies a rule that allows admins and owners.
- `and[...]` implies X if any child implies X.
- `or[...]` implies X only if every child implies X.
- `ref` expands to its vocabulary expression.
- `opaque` implies nothing.
- To satisfy `and[a, b]`, the condition must imply both `a` and `b`.

No solver, no model. When the checker can't prove implication, the result is a violation that names the unproven part, never a silent pass.

### 7.2 The five types

| Type | Example | Static check | Default `enforce` |
|---|---|---|---|
| `access` | Only admins can call transfer | Every route matching `target` has a guard chain (middleware plus guards in the handler before its first data op) that implies `requires` | `static` |
| `data-access` | Only account members read the account's dogs | The policy for `target` and each op in `ops` implies `requires`. For Postgres, RLS must also be enabled on the table. Client SDK calls to the target are shown as evidence in `explain` | `static`, `test` |
| `visibility` | Deleted dogs are never returned | Every `read`/`list` data op on `target` reachable from a route has a filter implying `requires`, or runs inside a symbol listed in `via` | `static` |
| `flow` | Every training write goes through `versionedUpdate` | Every data op on `target` with an op in `ops` has a symbol from `via` on its call path | `static` |
| `invariant` | Every dog has exactly one team | The schema has the constraint (`kind`: `not-null`, `fk`, `unique`, `check`, `enum`). For Firestore, the write rules for `target` check the field | `static`, `test` |

Rule-specific fields beyond 6.3: `via` (symbols) for `visibility` and `flow`; `kind`, `columns` and `references` for `invariant`.

### 7.3 Database tests: proof without app tests

Holdline doesn't generate tests for handlers. For rules that the database itself enforces (RLS, constraints, Firestore and Storage rules), it generates tests that run against a throwaway database:

| Store | Runs on | Setup for the user |
|---|---|---|
| Postgres | PGlite (Postgres compiled to WASM, in process): apply migrations, seed, run the cases | None |
| Firestore, Storage | Firebase emulator with `@firebase/rules-unit-testing` | `firebase-tools` and Java, which Firebase projects already have |

**Tests are data, not code.** Each rule gets `.holdline/tests/R-001.yaml`:

```yaml
rule: R-001
generatedFrom: 9f2c41          # rule hash; regenerate when it changes
cases:
  - name: member can read
    as: { uid: u1 }
    seed: { "/accounts/a1/members/u1": {}, "/accounts/a1/dogs/d1": { name: Rex } }
    do: { op: read, path: /accounts/a1/dogs/d1 }
    expect: allow
  - name: non-member cannot read
    as: { uid: u2 }
    seed: { "/accounts/a1/dogs/d1": { name: Rex } }
    do: { op: read, path: /accounts/a1/dogs/d1 }
    expect: deny
```

Cases are generated deterministically from `requires`: one case that satisfies every atom (expect allow) and, for each atom, one case that breaks only that atom (expect deny). For `invariant`, cases are writes that break the constraint (expect reject). `holdline test` runs them through `testkit`. No model is involved, so the same rule always produces the same tests, and a user can read them.

### 7.4 Audits (opt-in)

`holdline audit --db <url>` turns `invariant` and `visibility` rules into read-only queries against a real database (local or staging). Example: `SELECT count(*) FROM dogs WHERE team_id IS NULL` must be 0. Audits find records that already break a rule. They never write, and they run only when asked; they are not part of `check` or CI by default.

### 7.5 Moving a rule into the database

When an `access` or `invariant` rule is enforced only in handler code but the store could enforce it (an RLS policy, a constraint, a Firestore rule), `check --suggest` says so and drafts the policy or migration. Holdline never applies it; the agent or the user does.

## 8. Inference: the user's agent proposes, Holdline validates

Holdline ships no model client and needs no API key. The agent the user already runs does the inference.

1. `holdline scan` writes `.holdline/cache/facts.json`.
2. `holdline infer --prompt [--area <path>]` prints one prompt: instructions, the JSON Schema for proposals, and a condensed view of the facts (grouped by entity and action, no source files). The condensed view has a budget (default 30k tokens); larger repos are split with `--area`.
3. The agent returns proposals: rules and vocabulary entries, each with `text`, structured fields and `evidence`.
4. `holdline propose <file|->` validates each proposal and sorts it:

| Result | Meaning |
|---|---|
| `holds` | Valid, targets exist, its checker passes today |
| `broken` | Valid, but its checker fails today. Shown as a question ("looks unintended") |
| `rejected` | Invalid schema, a target that doesn't exist, or evidence that doesn't support it. Returned to the agent with the reason, so it can retry |

Holdline then deduplicates (same type, target and `requires`), ranks (`broken` first, then by how many evidence symbols support the rule), keeps the top 25 and writes them to `.holdline/pending.yaml`.

5. `holdline review` (interactive) or `holdline approve <ids>|--all` / `holdline reject <ids>` moves rules into `holdline.rules`, generates their tests and records the approval.

Ways to run it:

| Where | How |
|---|---|
| Claude Code | The plugin's skill runs steps 1 to 5 in chat (spec 4) |
| Cursor, Codex, other MCP agents | MCP prompt plus an instruction snippet in AGENTS.md or Cursor rules (spec 4) |
| Terminal or headless | `holdline infer --prompt \| claude -p > proposals.json && holdline propose proposals.json` |

**Privacy:** Holdline makes no network calls. Code reaches a model only through the agent the user already trusts. `audit` connects only to the database URL the user passes.

## 9. CLI

| Command | Does |
|---|---|
| `holdline scan [--changed]` | Run analyzers, update the fact cache |
| `holdline infer --prompt [--area]` | Print the inference prompt |
| `holdline propose <file\|->` | Validate proposals, write `pending.yaml` |
| `holdline review` | Interactive approve, reject, edit |
| `holdline approve <ids>\|--all`, `holdline reject <ids>` | Non-interactive approval |
| `holdline check [--changed] [--format] [--strict] [--suggest]` | Static checks (scans first if needed) |
| `holdline test [--rule]` | Run generated DB tests |
| `holdline audit --db <url>` | Read-only data audit |
| `holdline explain <rule-id>` | The rule, its evidence, current status, and why |
| `holdline mute <rule-id> --reason` | Turn a rule off with a recorded reason |
| `holdline init` | Wire up agents and CI (spec 4) |

### 9.1 Results

Every check produces the same result records; formatters only change how they print.

```ts
type Result = {
  rule: string                  // R-001
  status: 'pass' | 'violation' | 'stale' | 'unknown' | 'unapproved-edit'
  target: string
  at?: { symbol: string; file: string; line: number }
  message: string               // plain language
  unproven?: Expr               // the part of `requires` that couldn't be shown
  fix?: string                  // a concrete suggestion for the agent
}
```

- `stale`: the rule's target no longer exists. It never disappears silently; the user updates or removes the rule.
- `unknown`: an analyzer couldn't read a file the rule depends on.

Formats: `human` (default), `agent` (short, imperative, made for feedback loops), `json`, `github` (annotations and comment body).

### 9.2 Exit codes

| Code | Meaning |
|---|---|
| 0 | No violations (`stale` and `unknown` are warnings) |
| 1 | At least one violation or `unapproved-edit`; with `--strict`, also `stale` or `unknown` |
| 2 | Usage or config error |
| 3 | Analyzer or internal error |

Integrations map these to their host's conventions (spec 4).

## 10. Performance and errors

**Budgets** (a mid-size production codebase: about 400 Go files, 1,500 TypeScript files, several hundred lines of rules):

| Path | Budget |
|---|---|
| Cold `scan` | Under 60 s |
| `check --changed` with a warm cache (the hook path) | Under 2 s |
| `test` for 25 rules | Under 30 s on PGlite, under 60 s with the emulator |

The cache is per file, keyed by content hash and analyzer version, stored in `.holdline/cache/` (gitignored). `--changed` re-analyzes changed files and rechecks the rules whose targets or evidence touch them.

**Errors never pass quietly:**

- A file an analyzer can't parse becomes a `diagnostic`; rules that depend on it report `unknown`.
- A malformed `holdline.rules` is a config error (exit 2) with the line and the problem.
- A missing toolchain (no Go, no Python, no Java for the emulator) skips that analyzer or runner with a clear message and marks affected rules `unknown`.
- `testkit` failures that are infrastructure (emulator didn't start) exit 3 and are reported separately from rule failures.

## 11. Testing Holdline

**Unit tests** in each package. Core's implication logic, test generation and hashing get property-style tests (random expressions, checking for example that `and` and `or` behave as specified).

**Golden apps** in `examples/`, small apps with known rules, each with:

- `expected-rules.yaml`: about 10 rules a careful engineer would write
- `breakages/*.patch`: each patch breaks exactly one rule

| App | Stack |
|---|---|
| `golden-ts-postgres` | Express + Prisma |
| `golden-py-postgres` | FastAPI + SQLAlchemy/Alembic |
| `golden-go-postgres` | gin + sqlc |
| `golden-firebase` | Cloud Functions + `firestore.rules` + `storage.rules` + a small Expo client |
| `golden-supabase` | Next.js + Supabase RLS migrations |

**Acceptance per golden app:**

- `check` with `expected-rules.yaml` on the clean app: zero violations.
- Each breakage patch: `check` or `test` reports a violation of exactly the rule it breaks.
- Inference: proposals cover at least 8 of the 10 expected rules, with at most 5 rejected or junk proposals. This is checked manually per release, since it runs a model.

**DogBase reference set:** the rules DogBase should hold, written from its own code and docs. **It stays in the private DogBase repo** and is never committed to the public Holdline repo. Holdline's repo only gets the aggregate numbers for the case study.

## 12. Phases

Phases end on a "done when" gate, not a date. Phases 1 to 3 run as parallel Claude sessions in separate worktrees, one per track.

| Phase | Tracks | Done when |
|---|---|---|
| 0. Foundation | One: core, cli, `CLAUDE.md`, `golden-ts-postgres` skeleton | Fact and rule schemas frozen; `check` runs end to end on hand-written facts |
| 1. Data layers (spec 2) | Postgres + PGlite tests · Firestore/Storage + emulator tests · golden apps | Every data-layer breakage in the golden apps is caught; Holdline scans DogBase's rules |
| 2. Code analyzers (spec 3) | TS · Go (Echo first) · Python | Each golden app passes its breakage suite |
| 3. Integrations (spec 4) | Plugin, hook and inference skill · MCP and Action | Claude Code breaks a rule, gets feedback, fixes it; a PR that breaks a rule gets one comment |
| 4. Proof (spec 5) | Benchmark · DogBase run | Benchmark results reproducible; DogBase case study written |
| 5. Launch (spec 5) | — | README, demo, docs, launch post |

**Before launch, owner actions:** reserve `holdline` on npm (and the `@holdline` scope), PyPI and GitHub (`github.com/holdline`), a domain, and run a quick trademark search.

## Decisions

Made while brainstorming on 2026-10-21, and where they differ from the first implementation plan:

| Decision | Why |
|---|---|
| DogBase first, the five stacks built in parallel | DogBase is the case study; the open source launch is the goal |
| Postgres is its own analyzer on SQL migrations, not one adapter per ORM | One analyzer covers every ORM that emits migrations, and Supabase RLS comes with it |
| Go adds Echo | DogBase's three Go services use Echo |
| Firestore covers `storage.rules` too | Same language, same parser; DogBase uses both |
| No generated handler tests; the database is the proof (PGlite, emulator, audits) | Booting apps with auth and data is the flakiest part; DB tests are self-contained and deterministic |
| Tests stored as data cases, run by Holdline | Language-independent, deterministic, readable |
| Inference by the user's agent, no BYOK in v0.1 | No key to set up, no model adapters, works where developers already are |
| Vocabulary of named predicates | Handles project-specific helpers without a plugin per framework |
| Symbol ids instead of line numbers | Rules survive refactors |
| Phases with gates instead of weeks | AI writes the code fast; review, tuning and benchmark runs set the pace |
| Benchmark at launch: 5 golden apps, not 20 apps | Enough for a credible, reproducible headline; grow it after launch |
| Flask moves to v0.2 | Smallest loss among the Python frameworks |
| The DogBase reference set stays private | It describes a private codebase |

## As built (Phase 0)

Phase 0 built `packages/core`, `packages/cli`, the `golden-ts-postgres` acceptance fixture and the reference docs ([facts](../../reference/facts.md), [rules file](../../reference/rules-file.md)). The reference docs are the current truth for the contracts; this list records where the code differs from the sections above.

| Section | As built |
|---|---|
| 4 Analyzer contract | `detect(root, files)` also receives the file list; `analyze(ctx)` takes one context (`root`, `files`, `cache`). A crash in `detect` or `analyze`, or output that fails the fact schema, becomes an error diagnostic with `file: ''`. |
| 5.3 Predicates | Only `authenticated`, `exists` on the actor, and actor-to-literal `eq`/`in` (non-null string or number, non-empty array) imply `authenticated`; an anonymous actor is null. Analyzers for stores that deny anonymous callers (Firestore rules, RLS) emit an explicit `authenticated` atom. Equal atoms always imply each other; only array literals are sets for `in`. In `data-access` checks, unaligned policy params are renamed to fresh names before comparison. |
| 5.1 / 5.2 Paths and routes | Malformed brace segments in path patterns count as wildcards. Route paths use `:name` params; `{x}`, `<x>` and `<type:x>` are normalized. Postgres `exists` docs use `pg:<table>?<col>={<operand>}&…`. Policies use store `pg-rls` while data ops use `postgres`. |
| 6 Rule model | `approved.hash` covers the rule with `requires` expanded through the vocabulary, so editing a predicate needs re-approval of every rule using it. `status`, `muted` and `evidence` are not hashed; instead `status: pending` is rejected inside `holdline.rules`, `muted` needs a `muted` block, and muted rules are listed in every output. Vocabulary entries carry their own `approved` hash over `id`, `text`, `expr` and `recognize`; an unapproved or edited entry reports `unapproved-edit` as `vocabulary:<id>` (also under `--rule`, and counted in the summary). `lastRuleId` keeps rule ids from being reused. `kind: check` requires `expr`. |
| 7.2 Checkers | `visibility` checks every read and list of the target, not only those reachable from a route (stricter). `flow` and `visibility` use "every call path into the operation passes a `via` symbol"; a `via` entry covers its members (`<via>.`), and a cycle with no `via` node is uncovered. Firestore and Storage invariants support only `not-null` and `enum` (checked by implication on write rules); `fk`, `unique` and `check` are Postgres-only. |
| 7.3 Tests | Generated only for `data-access` rules in Phase 0; `expect: reject` exists in the format for invariant cases, which Phase 1 generates. Seeds are a list of `{ path, data }`. Generation skips (and says why) any requirement it cannot build exact worlds for: `or`, `not`, `opaque`, `ne`/`lt`/`gt`, literal or `actor.uid`/`param` targets, conflicting atoms, unset placeholders, dotted fields, `create` reading the stored record, `list` reading the stored record. |
| 9.1 Results | `at.file` and `at.line` are optional (some facts have no location). `unknown` replaces pass, violation and stale: an `access` rule on a `symbol` becomes unknown when an error touches its files, an analyzer crashed, or its evidence does not resolve while errors exist; every other rule becomes unknown when any error diagnostic exists (conservative until per-store attribution lands). |
| 9.2 Exit codes | `check` exits 3 after printing results when an analyzer crashed (an error diagnostic with `file: ''`). Malformed `.holdline/pending.yaml`, a missing proposals file and `--rule` with an unknown id exit 2. |
| 8 Inference | `--budget` is enforced as a hard cap; a budget smaller than the instructions and schema is a usage error. `propose` also reports proposals it skipped because they duplicate a pending rule or redefine pending vocabulary. |
| 11 Golden apps | Only `golden-ts-postgres` exists, with hand-written facts; its breakages are JSON Patches against `fixtures/facts.json` (code patches come with the analyzers). Its README fixes the conventions analyzers must reproduce: filters reference the function's own parameters, `where` clauses become filters on every operation, every referenced class or function is a symbol, `location.line` is the declaration line. |

**Left for later phases:** per-language `via` member boundaries (decided by each analyzer track), per-store attribution of diagnostics (to narrow `unknown`), how analyzer packages register in `packages/cli/src/analyzers.ts`, and flagging `holdline mute` or `holdline approve` run by an agent (spec 4).
