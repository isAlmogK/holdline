# Rules file reference

`holdline.rules` is the approved rule set. It is YAML, committed to the repo, and read by `holdline check`.
This page describes the code as built.
Sources: `packages/core/src/rules.ts`, `hash.ts`, `check/*.ts`, `results.ts`, `testcase.ts`, `testgen.ts`,
`proposals.ts`, `pending.ts`. Worked example: `examples/golden-ts-postgres/expected-rules.yaml`.

The expression language (`requires`) is defined in [facts.md](facts.md).

## File layout

```yaml
version: 1
vocabulary:            # optional, default []
  - id: account-member
    text: The caller is a member of the account
    expr: { atom: { op: exists, doc: "/accounts/{param.accountId}/members/{actor.uid}" } }
    recognize: [{ firestore-function: isAccountMember }]
rules:                 # optional, default []
  - id: R-001
    ...
lastRuleId: 1          # optional int >= 0, written by approve
```

`parseRulesFile(text)` throws `RulesFileError` on invalid YAML, any schema violation (unknown keys are errors),
a duplicate rule id, a duplicate vocabulary id, a failed semantic check (see "Invariant" below), a rule with `status: pending`
(`<id>: pending rules belong in .holdline/pending.yaml; approve them with holdline approve`), a rule with
`status: muted` and no `muted` block, or a `muted` block on a rule whose status is not `muted`. An empty file is an
empty rules file.
`serializeRulesFile` writes YAML with no line wrapping.

## Rule fields (all types)

| Field | Type | Notes |
|---|---|---|
| `id` | `R-` and 3 or more digits | `R-001`. Never reused: `nextRuleId` takes `max(lastRuleId ?? 0, highest existing id) + 1`, and `approve` sets the file's `lastRuleId` to the highest id it assigned, so deleting the top rule does not free its id |
| `text` | string | The plain language rule. Part of the approval hash |
| `type` | `access` `data-access` `visibility` `flow` `invariant` | |
| `target` | depends on type | See each type |
| `evidence` | string[] (default `[]`) | Symbol ids that showed the rule at inference time. Not hashed |
| `enforce` | `static` `test` `audit` list, optional | Defaults below |
| `status` | `approved` `muted` (`pending` exists in the schema but is rejected in `holdline.rules`) | Pending rules live only in `.holdline/pending.yaml` |
| `approved` | `{ by, at, hash }`, optional | Written by `approve`; never by hand |
| `muted` | `{ by, at, reason }` | Present exactly when `status: muted`. `reason` is required and non-empty |

### Targets

| Form | Used by | Meaning |
|---|---|---|
| `{ routes: "<selector>" }` | access | Route selector, see facts.md "Route paths and selectors" |
| `{ symbol: "<id>" }` | access | One function or method |
| `{ store: postgres, table: "dogs" }` | data targets | `dogs` and `public.dogs` are the same table |
| `{ store: firestore \| storage, path: "/accounts/{accountId}/dogs/{dogId}" }` | data targets | Path pattern (starts with `/`); overlaps with the facts' patterns are what match |

"Data targets" are the targets of `data-access`, `visibility`, `flow` and `invariant`.

### Default `enforce`

| Type | Default |
|---|---|
| access | `static` |
| data-access | `static`, `test` |
| visibility | `static` |
| flow | `static` |
| invariant | `static`, `test` |

`effectiveEnforce(rule)` returns `enforce ?? default`. `enforce` is metadata for the commands around core:
`runChecks` runs the static check for every approved rule regardless of it, and `generateTests` produces test
cases only for `data-access` rules.

## Rule types and their static checks

Every check returns `stale` (the target is not in the facts) or a list of violations. A violation carries
`message`, `at` (symbol, file, line), `unproven` (the part of the requirement that was not proven) and `fix`.

### access

"Callers must satisfy `requires` before this code runs."

```yaml
- id: R-002
  text: Only trainers and admins can add dogs
  type: access
  target: { routes: POST /dogs }
  requires:
    atom: { op: in, left: actor.role, right: { literal: [trainer, admin] } }
```

| Check | Detail |
|---|---|
| Route target | Every route matching the selector: the conjunction of guards at the route id, then its middleware, then its handler must imply `requires`. One violation per failing route, located at the handler |
| Symbol target | The conjunction of guards at that exact symbol must imply `requires` (guards on its callers do not count) |
| Stale | Symbol not found, or no route matches the selector |

### data-access

"Every policy that allows these ops must require `requires`."

```yaml
- id: R-020
  text: Only account members can read dogs
  type: data-access
  target: { store: firestore, path: /accounts/{accountId}/dogs/{dogId} }
  ops: [read, list]
  requires: { ref: account-member }
```

| Check | Detail |
|---|---|
| Postgres | The table must exist and have `rlsEnabled`, otherwise a violation ("Row level security is not enabled", located at the table) |
| Per op | The OR of the conditions of all policies for that op on the target must imply `requires`. Violation names the first policy that fails on its own |
| Firestore and Storage | Policy conditions have their `param.*` renamed to the rule target's parameter names (aligned by position, `alignParams`) before comparing. A policy param that does not align (for example the policy's own `{rest=**}` param) gets a fresh name (`__p0`, `__p1`, ...) so it cannot collide with a rule param of the same name: `renameParams(condition, names, { fresh: true })` |
| No matching policy | The condition is false, so it holds (no policy allows it means denied) |
| Stale | Postgres table not in facts; for Firestore and Storage, no dataOp, policy or collection overlaps the target |

Policies are matched by store (`pg-rls`, `firestore`, `storage`), target, and `ops` containing the op.

### visibility

"Reads of this data must filter by `requires`, unless the code is only reachable through `via`."

```yaml
- id: R-005
  text: Deleted dogs are never returned
  type: visibility
  target: { store: postgres, table: dogs }
  requires: { atom: { op: isNull, operand: resource.deleted_at } }
  via: []
```

| Check | Detail |
|---|---|
| Scope | Every `read` and `list` dataOp on the target |
| Skipped | Ops whose `in` symbol is covered by `via` (see `coveredBy` in facts.md) |
| Proof | The op's `filters` (absent means true) must imply `requires` |
| Stale | No read or list dataOps and the target is not in the facts |

`via` defaults to `[]`; an entry covers its members (`ts:x#Repo` covers `ts:x#Repo.list`).

### flow

"These ops on the target may only happen inside code reached through `via`."

```yaml
- id: R-007
  text: Transfer records are only written by the transfer service
  type: flow
  target: { store: postgres, table: transfers }
  ops: [create, update, delete]
  via: [ts:src/services/transfer#TransferService.transfer]
```

| Check | Detail |
|---|---|
| Scope | dataOps on the target whose op is in `ops` |
| Violation | Each op whose `in` symbol is not covered by `via`: every call path into it must pass a `via` symbol |
| `via` | At least one entry |
| Stale | No such dataOps and the target is not in the facts |

### invariant

"The data layer enforces this constraint."

```yaml
- id: R-010
  text: A dog's team must exist
  type: invariant
  target: { store: postgres, table: dogs }
  kind: fk
  columns: [team_id]
  references: { table: public.teams, columns: [id] }
```

| Field | Used by |
|---|---|
| `kind` | `not-null` `fk` `unique` `check` `enum` |
| `columns` | All kinds, at least one |
| `references` | `fk`, required: `{ table, columns }` |
| `values` | `enum`, required, at least one |
| `expr` | `check`, required: SQL text |

Semantic validation (`validateRuleSemantics`, run by `parseRulesFile` and when proposing): `fk` needs `references`;
`enum` needs `values`; `check` needs `expr`; `fk`, `unique` and `check` apply to postgres targets only.

Postgres checks:

| Kind | Holds when |
|---|---|
| `not-null` | Every column exists and is not nullable (a missing column is a violation) |
| `fk` | A foreign key with exactly these columns in this order, referencing this table (normalized) and these columns in order |
| `unique` | The primary key or one unique constraint has exactly this set of columns (order ignored) |
| `check` | Some check equals `expr` after lowercasing, collapsing whitespace and stripping outer parentheses. A check that only mentions the columns does not count; a rule without `expr` (only possible when built in code) is a violation |
| `enum` | Each column has an enum whose value set equals `values` (order ignored) |

Firestore and Storage targets support only `not-null` and `enum`, checked by implication on the write policies:
every `create` and `update` policy on the target must imply `incoming.<col> != null` (not-null) or
`incoming.<col> in [values]` (enum) for each column. `fk`, `unique` and `check` on these stores are rejected at
parse time and, if constructed in code, reported as a violation ("not supported for ...").

## Result statuses

`checkRule` produces results in this order of precedence:

| Status | When |
|---|---|
| `unapproved-edit` | No `approved` block, or its hash differs from `hashRule(rule, vocab)`. Vocabulary entries get the same check (see "Vocabulary approval") |
| `unknown` | Error diagnostics make the facts unreliable for the rule: for an `access` rule on a `symbol`, an analyzer crash, missing evidence, or an error in its symbol's or evidence's files; for every other rule, any error diagnostic. See facts.md "Diagnostics and unknown" |
| `stale` | The target is not in the facts |
| `violation` | One result per failing item |
| `pass` | Everything is proven |

`runChecks(facts, file, { only })` returns `{ results, muted, mutedRules }`. It skips `pending` rules (only possible
for a file built in code), does not check `muted` rules but returns each as `{ id, text, by, at, reason }` in
`mutedRules` (`muted` is their count), and checks the rest. `summarize` counts each rule once under its worst status, ordered
`pass < violation < stale < unknown < unapproved-edit`.

## `holdline check` and exit codes

`holdline check [--facts <file>] [--format human|agent|json] [--strict] [--rule <ids...>]` runs `runChecks` and prints
the results. `--rule` limits the run to those rule ids; an id that is not in `holdline.rules` is a usage error
(`no rule <id>`, exit 2).

| Exit | When |
|---|---|
| 0 | `check`: no violation and no unapproved edit (stale and unknown results allowed without `--strict`) |
| 1 | `check`: a violation or an unapproved edit; with `--strict`, also a stale or unknown result |
| 2 | Any command: usage or config error. Bad arguments, an unknown `--rule` id, a malformed `holdline.rules`, facts file or `.holdline/pending.yaml` (`PendingFileError`, for both YAML and schema errors), a missing facts file, or a missing proposals file (`proposals file not found: <path>`) |
| 3 | Any command: internal error. `check` also exits 3 when the facts hold an error diagnostic with `file: ''` (an analyzer crashed): it still prints every result first, then exits 3 whatever the results were |

## Vocabulary and recognizers

A vocabulary entry names a condition once so rules can say `{ ref: <id> }`.

| Field | Type | Notes |
|---|---|---|
| `id` | lowercase slug `[a-z][a-z0-9-]*` | |
| `text` | string | Plain language |
| `expr` | Expr | May itself contain `ref`s |
| `recognize` | list, default `[]` | `{ firestore-function: "<name>" }` or `{ symbol: "<id>" }` |
| `approved` | `{ by, at, hash }`, optional | Written by `approve`; never by hand. Not allowed in proposals or `.holdline/pending.yaml` |

`recognize` tells an analyzer which function or symbol means this predicate, so it emits `{ ref: <id> }` instead
of `opaque`. Core only stores and validates the field; the analyzers act on it.

Expansion: `expand` replaces each `ref` with the entry's `expr`, recursively. An unknown id becomes
`opaque "unknown predicate ..."`, and a cycle becomes `opaque "circular predicate ..."`; an `opaque` never
satisfies a requirement. Rules referring to a vocabulary id that is not in the file therefore fail rather than pass.
`vocabularyMap(file, extra)` builds the lookup (extras win on id collisions). Vocabulary ids are unique in a file.

### Vocabulary approval

`hashVocabulary(entry)` is the first 12 hex characters of the SHA-256 of `canonicalJson({ id, text, expr, recognize })`.
`recognize` is hashed because it changes what analyzers emit.

For each vocabulary entry with no `approved` block, or whose `approved.hash` differs from `hashVocabulary(entry)`,
`runChecks` emits one result before the rule results (the `only` filter does not hide it):

```json
{ "rule": "vocabulary:<id>", "status": "unapproved-edit", "target": "vocabulary",
  "message": "vocabulary <id> was changed without approval. Approve it with `holdline approve vocabulary:<id>`, or restore it." }
```

It counts like a rule in the summary and makes `check` exit 1. The agent format tells the agent to undo the change
(only the user approves). Editing `expr` also changes the hash of every rule that uses the entry, so those rules are
`unapproved-edit` too until re-approved. `approve` stamps every entry it moves from pending into the file, and
`holdline approve vocabulary:<id>` restamps an edited entry.

## Approval hashes

`hashRule(rule, vocab)` is the first 12 hex characters of the SHA-256 of the canonical JSON (sorted keys,
undefined dropped) of the parsed rule, excluding `id`, `status`, `approved`, `muted` and `evidence`.

| Property | Detail |
|---|---|
| Hashed | `type`, `text`, `target`, `ops`, `via`, `kind`, `columns`, `references`, `values`, `expr`, `enforce`, and `requires` |
| `requires` is expanded | Refs are replaced by their vocabulary definition before hashing. Editing a vocabulary entry changes the hash of every rule using it, so they become `unapproved-edit` until re-approved |
| Parsed rules only | Hash the output of `RuleSchema`, so defaults (`via: []`) are present. Pass the same vocabulary `check` uses, `vocabularyMap(file)` |
| Not hashed | `id`, `status`, `approved`, `muted`, `evidence`, so approving, muting and changing evidence never invalidate a rule |

Never edit `approved.hash` by hand. After editing `holdline.rules` text in a fixture, run
`pnpm tsx scripts/approve-fixture.ts <rules.yaml>`. It restamps every approved rule and every vocabulary entry that
has an `approved` block.

## Muting

`mute(file, id, { by, at, reason })` sets `status: muted` and records `muted`. Muted rules are not checked, but they
stay visible in every `holdline check` format:

| Format | How muted rules appear |
|---|---|
| human | One line each after the summary: `- R-002 muted by <by> on <at>: <reason>` |
| agent | Appended to the first (summary) line: ` 1 rule muted: R-002 (<reason>)`, or ` <k> rules muted: R-002 (<reason>), R-005 (<reason>)` |
| json | `mutedRules: [{ id, text, by, at, reason }]` next to `summary` |

With no approved rules to check, the agent format prints `Holdline: no approved rules to check.` (plus the muted
note, if any). Re-approving a muted rule (`approve` with its id) restamps its hash, sets `approved` status and
removes `muted`. `reason` is required.

## Proposals and pending rules

Inference is done by the user's agent. It submits `{ vocabulary: [...], rules: [...] }`; proposed rules are the
rule schemas without `id`, `status`, `approved` and `muted`, and proposed vocabulary entries are
`ProposedVocabularySchema` (the entry schema without `approved`). Pending vocabulary uses the same schema.

`validateProposals(input, facts, file, { limit })` returns `{ rules, vocabulary, dropped }`.

Vocabulary entries are `accepted` unless they fail the schema or reuse an id that is already in `holdline.rules`
(or was accepted earlier in the same batch).

Each rule gets one classification, decided in this order (first match wins):

| Classification | Reason |
|---|---|
| `rejected` | Fails the schema; fails semantic validation; has a `ref` that is not in the vocabulary (file plus accepted entries); lists `evidence` ids not in the facts; duplicates an existing rule or another rule in the batch (same type, target and requirement, compared on everything except `text`, `evidence`, `enforce` and meta fields); its target is not in the facts (stale) |
| `broken` | The static check finds violations, which are returned as messages. These are the rules most worth approving: the code already breaks them |
| `holds` | The static check passes |

Ranking: `broken` before `holds`, then more `evidence` first (a stable sort). The top `limit` (default 25) are kept;
`dropped` counts the rest. Rejected proposals are always listed after the kept ones and are not counted against the limit.

### Pending file (`.holdline/pending.yaml`)

`addToPending(pending, report)` stores kept proposals as `P-<n>` keys (n continues from the highest existing key),
along with newly accepted vocabulary. Not added, and reported as `conflicts`:

| Conflict | Reason |
|---|---|
| Duplicate pending | The same rule key is already pending (`duplicate of pending P-3`) |
| Vocabulary redefinition | The rule uses a vocabulary id that is already pending with a different `expr` (approve or reject the pending rules first) |

`reject(pending, keys)` drops pending rules by key (throws on an unknown key).

### Approval

`approve(file, pending, keys | 'all', { by, at })`:

| Behavior | Detail |
|---|---|
| New rule | Gets the next `R-nnn` (and the file's `lastRuleId` is set to it), `status: approved`, and `approved: { by, at, hash }` where the hash is computed against the approved vocabulary plus the pending vocabulary |
| Existing rule id | Restamps `approved` with a fresh hash (this is how an `unapproved-edit` is accepted), clears `muted` |
| Vocabulary | `'all'` moves all pending vocabulary into the file. Specific keys move only the entries the approved rules use, transitively. The rest stay pending. Every moved entry is stamped `approved: { by, at, hash: hashVocabulary(entry) }` |
| `vocabulary:<id>` key | Restamps that approved vocabulary entry (how an edited entry is accepted). Reported as `vocabulary:<id> re-approved` |
| Errors | An unknown key (including `vocabulary:<id>` for an id not in the file); a pending vocabulary id that is already approved |
| Pending after | Approved keys are removed |

## Test cases (`.holdline/tests/<rule id>.yaml`)

Tests are data. `generateTests(rule, vocab)` is deterministic: the same rule and vocabulary always give the same
file. It returns `undefined` for every rule type except `data-access`. `holdline approve` writes the file.

```yaml
rule: R-020
generatedFrom: 839700ca42ec      # hashRule at generation time
store: firestore
cases:
  - name: "read: allowed when every condition holds"
    as: { uid: user-1, claims: {} }     # null means unauthenticated
    seed:
      - path: /accounts/accountId-1/dogs/dogId-1      # the record itself
        data: {}
      - path: /accounts/accountId-1/members/user-1    # the exists() document
        data: {}
    do: { op: read, path: /accounts/accountId-1/dogs/dogId-1 }
    expect: allow
  - name: "read: denied without exists(/accounts/{param.accountId}/members/{actor.uid})"
    as: { uid: user-1, claims: {} }
    seed:
      - path: /accounts/accountId-1/dogs/dogId-1
        data: {}
    do: { op: read, path: /accounts/accountId-1/dogs/dogId-1 }
    expect: deny
skipped: []                              # why cases were not generated
```

| Field | Notes |
|---|---|
| `rule`, `generatedFrom`, `store` | `store` is `postgres`, `firestore` or `storage` |
| `cases[].as` | `{ uid, role?, claims }` or `null` for an anonymous caller |
| `cases[].seed` | Records to exist first: `{ path, data }`. Postgres paths are `schema.table` and `data` is the row |
| `cases[].do` | `{ op, path, data? }`. `data` is present for `create` and `update` |
| `cases[].expect` | `allow`, `deny`, or `reject`. `reject` means a write the database must refuse (for `invariant` cases, such as inserting a null into a `not-null` column). `generateTests` does not produce `reject` cases yet; that lands in Phase 1 |
| `skipped` | Human readable reasons |

### Generation

The requirement is expanded through the vocabulary and split on `and`. Atoms are deduplicated.
For each op in the rule: one case that satisfies every atom (`allow`), then for each atom one case that breaks only
that atom (`deny`), named `<op>: denied without <atom>`.

| Detail | Value |
|---|---|
| Actor | `{ uid: 'user-1', claims: {} }` |
| Path parameters | `<name>-1` (`accountId-1`) |
| Values made up to make two operands equal | `value-1`, `value-2`, ... |
| Postgres paths | `public.<table>` when the name has no schema |
| `list` on Firestore and Storage | `do.path` is the parent path of the document path |
| Seed for create | None: the record does not exist yet. Other ops seed the record |
| Data | `create` and `update` carry the record fields plus `incoming.*` values |

How each atom is satisfied and then broken:

| Atom | Satisfy | Break |
|---|---|---|
| `authenticated` | Default actor | `as: null` |
| `isNull x` | Sets `x` to null | Sets `x` to `'not-null'` |
| `in x [..]` | Sets `x` to the first value | Sets `x` to `'not-allowed'` |
| `eq a b` | Copies the fixed side (`actor.uid`, `param.*`, literal) to the other, or invents `value-n` for both | Sets the `resource.*` or `incoming.*` side to `'other-value'`; else a claim or role side; else changes the actor uid to `user-2` |
| `exists doc` | Adds the document to the seed, filling placeholders from the world. Postgres `pg:<table>?<col>={<operand>}...` becomes a row | Leaves the document out |

`exists` atoms are satisfied last, so the placeholders they refer to already have values.

### When generation is skipped

Nothing is generated, `cases` is empty and `skipped` has one reason, when:

| Case | Reason text starts |
|---|---|
| The requirement is not only `and` of atoms (has `or`, `not`, `opaque`) | the requirement must be only "and" of atoms |
| An atom is `ne`, `lt` or `gt` | `<op> conditions are not generated yet` |
| An `eq`/`in` would need to set a literal, `actor.uid` or a `param.*` | `cannot set ...` |
| `in` with a non-array or empty right side | `cannot satisfy ...` |
| Two atoms need different values on the same field | `conflicting conditions on ...` |
| An operand with a dot beyond one field level (`resource.address.city`, `actor.claim.a.b`) | `nested field ... is not generated yet` |
| An `exists` placeholder has no value in the generated world | `cannot resolve {...}` |

Per op, only that op is skipped (the others are still generated) and the reason is added to `skipped`:

| Case | Reason |
|---|---|
| `create` and an atom reads the stored record (`resource.*`, or an `exists` doc containing `{resource.`) | `create: the condition reads the stored record, which does not exist on create` |
| `list` and the satisfied record has fields | `list: needs query filters to test; read cases cover the condition` |

Parse and write with `parseTestFile` / `serializeTestFile`.

## Worked example

`examples/golden-ts-postgres/expected-rules.yaml` holds 12 approved rules, one per golden breakage in
`fixtures/breakages/R-xxx.json` (JSON Patches against `fixtures/facts.json`). `packages/cli/test/golden.test.ts` asserts that the
rules pass on the clean facts and that each breakage produces a violation only for its own rule.

| Rule | Type | What it shows |
|---|---|---|
| R-001 to R-003 | access | Route selectors: exact, `*` segment in `/dogs/*/transfer`, `* /admin/**` |
| R-004 | access | `authenticated` proven through middleware, with a `* /dogs/**` selector |
| R-005, R-006 | visibility | `isNull` filter on every read and list |
| R-007, R-008 | flow | `via` a method, `via` a class (covers its members) |
| R-009 to R-012 | invariant | `not-null`, `fk`, `enum`, `unique` on Postgres |
