# Holdline

**AI reviewers might notice when an agent breaks your business rules. Holdline makes sure the rules you approved can't be broken silently.**

Holdline finds the business rules already in your codebase, asks you to approve them in plain language, and checks them deterministically every time an AI agent or a person changes the code.

> **Status: pre-alpha.** The core engine and CLI work end to end on hand-written facts. The analyzers that read real code (Postgres, Firestore, TypeScript, Go, Python) are in progress. Nothing is published to npm yet. See the [roadmap](#roadmap).

## Why

Coding agents keep tests green and still break rules nobody wrote down: who may transfer a record, which rows a user may read, that deleted records never come back.

- **Instruction files** (CLAUDE.md, AGENTS.md) state rules but don't enforce them.
- **CI** enforces only what someone wrote a check for.
- **AI reviewers** give an opinion on each PR, not a guarantee.

Holdline sits in between. Rules are inferred from your code, approved by you, and enforced by deterministic checks and database tests. No model ever decides whether a check passes.

## How it works

```
your code ──▶ analyzers ──▶ fact graph ──▶ your agent proposes rules ──▶ you approve
                                │                                            │
                                └──────────▶ holdline check ◀── holdline.rules
```

| Layer | What it does | Deterministic |
|---|---|---|
| **Analyzers** | Read routes, guards, queries, schemas, RLS policies and Firestore rules into one fact graph | Yes |
| **Inference** | Your own agent (Claude Code, Cursor, Codex) proposes rules from a condensed view of the facts. Holdline validates every proposal | No, and it never decides pass or fail |
| **Enforcement** | Five rule checkers run on the fact graph; database rules also get generated tests | Yes |

Holdline makes **no network calls** and ships **no model client**. Your code only reaches a model through the agent you already use.

## A rule

Rules live in `holdline.rules`, readable YAML that only the tool writes:

```yaml
- id: R-001
  text: Only admins can transfer dogs between teams
  type: access
  target: { routes: "POST /dogs/*/transfer" }
  requires: { atom: { op: in, left: actor.role, right: { literal: [admin] } } }
  evidence: ["route:POST /dogs/:id/transfer"]
  status: approved
  approved: { by: golden, at: 2026-10-21, hash: bafc42d0dbd5 }
```

When an agent removes that check, `holdline check --format agent` sends this back to it:

```
Holdline: 1 approved rule is broken. Fix the code so the rules hold again. Do not edit holdline.rules.
- R-001 "Only admins can transfer dogs between teams" at src/routes/dogs.ts:20: POST /dogs/:id/transfer does not check actor.role in ["admin"]. Missing: actor.role in ["admin"]. Fix: Add a check for actor.role in ["admin"] to POST /dogs/:id/transfer, as middleware or before its first data access.
If this behavior change is intended, stop and ask the user to approve a rule change (holdline propose, then holdline approve).
```

Editing an approved rule by hand doesn't help: each approval stores a hash, so the change shows up as an unapproved edit.

### Rule types

| Type | Example | Checked by |
|---|---|---|
| `access` | Only admins can call transfer | Every matching route's guards imply the requirement |
| `data-access` | Only account members read the account's dogs | Firestore rules or Postgres RLS imply it, plus generated database tests |
| `visibility` | Deleted dogs are never returned | Every read filters by the condition |
| `flow` | Transfer records are only written by the transfer service | Every write's call path goes through it |
| `invariant` | Every dog belongs to a team | The schema has the constraint |

When Holdline can't prove a rule, it says so (`violation`, `stale` or `unknown`). It never passes silently.

## Try it

Requires Node 20+ and pnpm.

```bash
git clone https://github.com/isAlmogK/holdline.git
cd holdline
pnpm install
pnpm test
```

Run the checks on the bundled example, a small Express and Prisma app with 12 approved rules. Holdline reads `holdline.rules` from the folder you run it in, so copy the example into a scratch folder:

```bash
HOLDLINE=$PWD
mkdir -p /tmp/holdline-demo
cp examples/golden-ts-postgres/expected-rules.yaml /tmp/holdline-demo/holdline.rules
cp examples/golden-ts-postgres/fixtures/facts.json /tmp/holdline-demo/
cd /tmp/holdline-demo
npx --prefix "$HOLDLINE" tsx "$HOLDLINE/packages/cli/src/bin.ts" check --facts facts.json
npx --prefix "$HOLDLINE" tsx "$HOLDLINE/packages/cli/src/bin.ts" explain R-001 --facts facts.json
```

Until the analyzers land, facts come from a hand-written file (`--facts`). The example also ships one deliberate breakage per rule in `fixtures/breakages/`, and its acceptance test checks that each one is caught.

## Commands

| Command | Does |
|---|---|
| `holdline check` | Check approved rules (`--format human\|agent\|json`, `--strict`, `--rule`) |
| `holdline explain <id>` | Show a rule, its evidence and its current status |
| `holdline scan` | Run the analyzers and cache the fact graph |
| `holdline infer --prompt` | Print the prompt your agent uses to propose rules |
| `holdline propose <file>` | Validate proposals and stage them for review |
| `holdline review` | Approve or reject staged proposals one by one |
| `holdline approve` / `reject` | Approve or drop staged proposals; re-approve edited rules |
| `holdline mute <id> --reason` | Turn a rule off, recording who and why |

Exit codes: `0` clean, `1` a rule is broken, `2` usage or config error, `3` analyzer or internal error.

## Roadmap

| Phase | Scope | State |
|---|---|---|
| 0. Foundation | Fact graph, rule model, checkers, DB test generator, CLI, golden app | Done |
| 1. Data layers | Postgres (constraints, RLS, Supabase) and Firestore/Storage rules, tests on PGlite and the Firebase emulator | Next |
| 2. Code analyzers | TypeScript (Express, Fastify, Next.js, SvelteKit, Cloud Functions), Go (Echo, gin, chi), Python (FastAPI, Django) | Planned |
| 3. Integrations | Claude Code plugin and hook, MCP server, GitHub Action | Planned |
| 4. Proof | Benchmark: how often agents silently break business rules, with and without Holdline | Planned |

## Docs

- [Design](docs/superpowers/specs/2026-10-21-holdline-design.md): the why, the user flow and the architecture
- [Fact graph reference](docs/reference/facts.md): what analyzers emit
- [Rules file reference](docs/reference/rules-file.md): `holdline.rules`, the checkers and the test-case format

## Contributing

Holdline is built test first. Read [CLAUDE.md](CLAUDE.md) for the principles and the frozen contracts before changing `packages/core`. Issues and ideas are welcome.

## License

[Apache 2.0](LICENSE)
