<div align="center">

# 🛡️ holdline

### Hold the line on your business rules, even when an AI writes the code.

**AI reviewers might notice when an agent breaks your business rules. Holdline makes sure the rules you approved can't be broken silently.**

[![CI](https://github.com/isAlmogK/holdline/actions/workflows/ci.yml/badge.svg)](https://github.com/isAlmogK/holdline/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](https://nodejs.org)
[![Status](https://img.shields.io/badge/status-pre--alpha-orange.svg)](#roadmap)
[![Rule types](https://img.shields.io/badge/rule%20types-5-blueviolet.svg)](#rule-types)
[![Sponsor](https://img.shields.io/badge/sponsor-%E2%99%A5-ea4aaa?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/isAlmogK)

[Why](#why-im-building-this) · [How it works](#how-it-works) · [A rule](#what-a-rule-looks-like) · [Rule types](#rule-types) · [Try it](#try-it) · [Commands](#commands) · [Roadmap](#roadmap) · [Docs](#docs) · [Sponsor](#sponsor) · [About me](#about-me)

</div>

---

Holdline finds the business rules already in your codebase, asks you to approve them in plain language, and checks them **deterministically** every time an AI agent or a person changes the code. Rules like *only admins can transfer a dog*, *users only read their own team's records*, *deleted records are never returned*.

No model decides whether a check passes. No server, no account. Your code never leaves your machine.

```console
$ holdline check --format agent

Holdline: 1 approved rule is broken. Fix the code so the rules hold again. Do not edit holdline.rules.
- R-001 "Only admins can transfer dogs between teams" at src/routes/dogs.ts:20:
  POST /dogs/:id/transfer does not check actor.role in ["admin"].
  Fix: Add a check for actor.role in ["admin"] to POST /dogs/:id/transfer,
  as middleware or before its first data access.
If this behavior change is intended, stop and ask the user to approve a rule change.
```

That message goes straight back to your coding agent, which fixes the code before you ever see the diff.

> [!NOTE]
> **Status: pre-alpha.** The engine and CLI work end to end on hand-written facts (225 tests, every deliberate breakage of the example app caught). The analyzers that read real code (Postgres, Firestore, TypeScript, Go, Python) are being built now. Nothing is published to npm yet. Watch or ⭐ the repo to follow along.

## Why I'm building this

AI agents now write a large share of the code I ship. They're good at keeping tests green. They're also good at quietly breaking a rule nobody wrote down: who may move a record between teams, which rows a user may read, that a deleted record never comes back.

The guardrails we have today don't cover that gap:

| | Knows your rules | Enforces them | Works on existing code |
|---|---|---|---|
| Instruction files (CLAUDE.md, AGENTS.md) | ✅ if written | ❌ | ✅ |
| Spec tools (Spec Kit, Kiro, OpenSpec) | ✅ if written | ◐ | ❌ needs specs first |
| AI code reviewers | ◐ learned | ❌ an opinion per PR | ✅ |
| Tests and CI | only what was tested | ✅ | ✅ |
| **Holdline** | ✅ **inferred, then approved by you** | ✅ **deterministic** | ✅ |

Holdline sits in that gap. Your agent proposes the rules, you approve them, and from then on they're checked the same way every time, with database tests as proof.

## How it works

```
your code ─▶ analyzers ─▶ fact graph ─▶ your agent proposes rules ─▶ you approve
                              │                                          │
                              └─────────▶  holdline check  ◀── holdline.rules
```

| | What it does | Deterministic |
|---|---|---|
| 🔎 **Analyzers** | Read routes, guards, queries, schemas, RLS policies and Firestore rules into one fact graph | ✅ |
| 🤝 **Inference** | Your own agent (Claude Code, Cursor, Codex) proposes rules from a condensed view of the facts. Holdline validates every proposal and flags the ones your code already breaks | Your agent, never Holdline. It never decides pass or fail |
| 🛡️ **Enforcement** | Five checkers prove each rule against the facts; database rules also get generated tests run on Postgres and the Firebase emulator | ✅ |

When Holdline can't prove a rule, it says so (`violation`, `stale` or `unknown`). **It never passes silently.**

## What a rule looks like

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

Every approval stores a hash. If an agent edits a rule to make a check pass, Holdline reports an **unapproved edit** and tells the agent to undo it. Only you approve rule changes.

## Rule types

| Type | Example | How it's checked |
|---|---|---|
| 🔐 `access` | Only admins can call transfer | Every matching route's guards imply the requirement |
| 🗄️ `data-access` | Only account members read the account's dogs | Firestore rules or Postgres RLS imply it, plus generated database tests |
| 🙈 `visibility` | Deleted dogs are never returned | Every read filters by the condition |
| 🧭 `flow` | Transfer records are only written by the transfer service | Every write's call path goes through it |
| 📐 `invariant` | Every dog belongs to a team | The schema has the constraint |

## Try it

**Requirements:** Node.js 20 or newer and pnpm.

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

Until the analyzers land, facts come from a hand-written file (`--facts`). The example ships one deliberate breakage per rule in `fixtures/breakages/`, and its acceptance test checks that each one is caught.

## Commands

| Command | Does |
|---|---|
| `holdline check` | Check approved rules (`--format human\|agent\|json`, `--strict`, `--rule`) |
| `holdline explain <id>` | Show a rule, its evidence and its current status |
| `holdline scan` | Run the analyzers and cache the fact graph |
| `holdline test` | Run the generated database test cases on PGlite and the Firebase emulator (`--rule`, `--store`, `--format`, `--regenerate`) |
| `holdline infer --prompt` | Print the prompt your agent uses to propose rules |
| `holdline propose <file>` | Validate proposals and stage them for review |
| `holdline review` | Approve or reject staged proposals one by one |
| `holdline approve` / `reject` | Approve or drop staged proposals; re-approve edited rules |
| `holdline mute <id> --reason` | Turn a rule off, recording who and why |

Exit codes: `0` clean · `1` a rule is broken · `2` usage or config error · `3` analyzer, test runner or internal error.

## Roadmap

| Phase | Scope | State |
|---|---|---|
| 0. Foundation | Fact graph, rule model, five checkers, DB test generator, CLI, example app | ✅ Done |
| 1. Data layers | Postgres (constraints, RLS, Supabase) and Firestore/Storage rules, tests on PGlite and the Firebase emulator | 🚧 In progress |
| 2. Code analyzers | TypeScript (Express, Fastify, Next.js, SvelteKit, Cloud Functions), Go (Echo, gin, chi), Python (FastAPI, Django) | Planned |
| 3. Integrations | Claude Code plugin and hook, MCP server, GitHub Action | Planned |
| 4. Proof | A public benchmark: how often agents silently break business rules, with and without Holdline | Planned |

## Docs

- 📘 [Design](docs/superpowers/specs/2026-10-21-holdline-design.md): the why, the user flow and the architecture
- 🧩 [Fact graph reference](docs/reference/facts.md): what analyzers emit
- 📜 [Rules file reference](docs/reference/rules-file.md): `holdline.rules`, the checkers and the test-case format
- 🧪 [Test runner reference](docs/reference/test-runner.md): `holdline test`, its runners and its report

Holdline is built test first, largely by AI agents working from written specs and plans, with every task reviewed before it merges. The specs and plans live in [`docs/superpowers/`](docs/superpowers/). Read [CLAUDE.md](CLAUDE.md) before changing `packages/core`. Issues and ideas are welcome.

## Sponsor

Holdline is free and open source, and I build it in my own time. If it keeps an agent from quietly breaking one of your rules, [sponsoring me on GitHub](https://github.com/sponsors/isAlmogK) keeps it maintained and moving down the [roadmap](#roadmap).

## About me

I'm Almog Koren, a software engineer in Tallinn with more than 15 years of shipping production software. I founded and built [DogBase](https://www.dogbase.co), a bootstrapped SaaS for working-dog teams that won the main pitch competition at Latitude59 2026, and before that I was co-founder and CTO of Platfarm, which was acquired. I took both companies through Techstars.

These days I mostly build AI agents and the systems around them. Holdline is the sibling of [trustbut](https://github.com/isAlmogK/trustbut): trustbut proves a change is actually tested, Holdline proves it didn't break a rule you approved. DogBase is Holdline's first real user.

**I'm open to work:** full-time roles, fractional CTO work and AI agent projects. My CV and contact details are at [almog.io](https://almog.io).

## License

[Apache-2.0](LICENSE)

---

<div align="center">

Built by **Almog Koren** · [almog.io](https://almog.io) · [@isAlmogK](https://github.com/isAlmogK). If Holdline keeps a rule from breaking, a ⭐ helps others find it, and [sponsoring](https://github.com/sponsors/isAlmogK) helps keep it going.

</div>
