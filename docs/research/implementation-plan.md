# Holdline: Implementation Plan

Product name: **Holdline** (see section 15).

## 1. Goal

Build an open source tool that discovers the business rules in an existing codebase, gets them approved in plain language, and enforces them every time an AI agent or a human changes the code.

**Personal goal:** career leverage (consulting projects, full time offers, acqui-hire or acquisition), not a venture backed company.

**One line pitch:** AI reviewers might notice when an agent breaks your business rules. Holdline makes sure the rules you approved can't be broken silently.

## 2. Scope for v0.1 (ten weeks)

The scope covers the most popular backend languages plus the DogBase stack, so the tool can reach a wide audience at launch and still be dogfooded on the production app that matters most for the case study.

### Launch support matrix

| Layer | v0.1 (launch) | Why |
|---|---|---|
| Languages | TypeScript/JavaScript, Python and Go | TypeScript and Python are the two biggest languages on GitHub and in AI coding. Go is the DogBase backend and is unusually easy to analyze precisely |
| Relational DB | Postgres via Prisma or Drizzle (TS), SQLAlchemy or Django ORM (Python), sqlc or GORM (Go) | Most common AI coding backend |
| Document DB | Firebase Firestore, including `firestore.rules` | DogBase uses it, Firebase has a huge AI and vibe coding user base, and agents break security rules often |
| Frameworks | Express, Fastify, Next.js API routes, Firebase Cloud Functions (TS); FastAPI, Django, Flask (Python); net/http, chi, gin (Go) | Covers the common shapes without going deep on any one |
| Clients | React Native and web apps, covered through the data layer | React Native, React and SvelteKit apps that talk to Firestore are protected through the security rules layer, which is where Firestore access control actually lives. Because React Native is TypeScript, the TS analyzer also reads its Firebase SDK calls directly, so direct client access to collections is checked against the rules |

**Firestore is a strong wedge, not just a DogBase need.** Its security rules are already a rules file, they are where data leaks happen, and the Firebase emulator plus `@firebase/rules-unit-testing` makes generated rule tests cheap to run. "The agent loosened your Firestore rules" is a story every Firebase developer understands.

**Explicitly later:** Java and Kotlin (Spring), C#, MongoDB (Mongoose), Supabase row level security, UI level rules. Supabase RLS is the most natural next step after launch since it mirrors the Firestore rules story for Postgres.

### In scope
- TypeScript, Python and Go backends per the matrix above
- Postgres and Firestore data layers per the matrix above
- Firestore security rules analysis and generated rule tests via the emulator
- Rule inference from existing code, with plain language approval
- Two enforcement types: static checks and generated tests
- Claude Code hook integration (in the agent loop)
- MCP server so any agent can read and respect the rules
- GitHub Action with PR comments
- Benchmark suite and published results

### Out of scope for v0.1
- Languages other than TypeScript, Python and Go
- Frontend rules
- Runtime guards in production
- Property based tests (stretch goal only)
- Hosted service, dashboard, accounts or billing
- Writing specs from scratch for greenfield projects

## 3. User experience

### Install
**Primary, for Claude Code users** (the Superpowers lesson: ship as a plugin and match a two command install):
```
/plugin marketplace add holdline/holdline
/plugin install holdline
```
The plugin bundles the hook, the MCP server and a skill that runs the first scan and review in chat.

**Everyone else** (Cursor, Codex, CI only, Python or Go projects without Node):
```bash
npx holdline init      # or: pipx install holdline, or a single binary via Homebrew
```
Asks two questions: which agent (Claude Code, Cursor, Codex, other) and whether to add the GitHub check. Creates:
```
holdline.rules            ← approved rules (managed by the tool)
.holdline/tests/          ← generated tests (managed by the tool)
.holdline/cache/          ← analysis cache (gitignored)
.claude/settings.json   ← hook added, if Claude Code
.mcp.json               ← MCP server entry
.github/workflows/holdline.yml
```

### First run
```
Found 14 rules in your code. Review them:

✓ Only admins can call transferDog          (src/dogs/transfer.ts)
✓ Every dog belongs to exactly one team     (schema + 6 call sites)
✓ Deleted teams are never returned by APIs  (repository layer)
? Trainers can edit any dog's records       ← looks unintended, keep it?

[a]pprove all  [r]eview one by one  [e]dit
```
Rules that look like bugs are flagged as questions. This is a feature in itself: the first run often finds real issues, which is the "aha" moment.

### Daily use
- The user keeps working with their agent as normal
- After each agent edit, the hook runs `holdline check --changed`. Violations go back to the agent as structured feedback, and it fixes them before the user sees anything
- On each PR, the GitHub Action comments only when a rule breaks:
```
⚠ This PR breaks 1 approved rule:
"Only admins can call transferDog"
src/dogs/transfer.ts:42 now allows team_lead

→ Fix it, or approve the change: holdline approve R-003
```

### Changing a rule
The user asks the agent for new behavior ("let team leads transfer dogs"). The agent calls `propose_rule_change` through MCP, the user approves in chat or with `holdline approve`, and `holdline.rules` plus generated tests update together. Rules never change silently.

## 4. Architecture

```
            ┌──────────────────────────────────────────┐
            │                 holdline CLI               │
            │  init · scan · review · check · approve  │
            └───────┬──────────────┬───────────────┬───┘
                    │              │               │
          ┌─────────▼───┐   ┌──────▼──────┐  ┌─────▼────────┐
          │  Analyzer   │   │  Inference  │  │ Enforcement  │
          │ (static,    │──▶│  (LLM, BYO  │─▶│ engine       │
          │  no LLM)    │   │   API key)  │  │ static+tests │
          └─────────────┘   └─────────────┘  └─────┬────────┘
                                                   │
                ┌────────────────┬─────────────────┼──────────────┐
                ▼                ▼                 ▼              ▼
         Claude Code hook    MCP server     GitHub Action    holdline.rules
```

### 4.1 Analyzers (deterministic, no LLM)
One shared fact graph format, with a native analyzer per language and per data layer. Every analyzer emits the same JSON, so inference and enforcement never care which language produced it.

Facts collected:
- Routes and handlers, with their middleware chains
- Auth checks (role checks, guards, decorators, session lookups, Firebase Auth claims)
- Data schema: models, relations, constraints, soft delete fields, Firestore collection paths and document shapes
- Firestore security rules: match paths, allow conditions, functions they call
- Validation (zod, class-validator, Pydantic, Django forms and serializers, Go struct tags, manual checks)
- Call graph between handlers, services and repositories

**Analyzers:**
| Analyzer | Tooling |
|---|---|
| TypeScript | ts-morph on the TypeScript compiler API |
| Python | A small Python helper using the standard `ast` module (and libcst where precise locations matter), called by the core |
| Go | A small Go binary using `go/packages` and `go/ast`, shipped prebuilt and called by the core |
| SQLAlchemy, Django ORM | Model classes read by the Python analyzer |
| Prisma, Drizzle | Their schema parsers |
| sqlc, GORM | sqlc config and queries, GORM struct tags |
| Firestore rules | Parser for `firestore.rules` |
| Firestore data | Inferred from typed converters and SDK call sites (`collection(...)`, `doc(...)`), since Firestore has no schema file |

Native analyzers are more accurate than a generic tree-sitter approach, and accuracy is what keeps false positives down. Tree-sitter can be a fallback for quick experimental support of new languages later.

Output is cached in `.holdline/cache/`.

### 4.2 Inference (LLM)
Turns facts into candidate rules:
1. Group facts by entity and action ("transferDog": handler, guard, DB writes)
2. Send compact fact summaries, not whole files, to the model with a strict output schema
3. Model returns candidate rules with evidence (file and line), a rule type, a confidence score, and a "looks unintended" flag
4. Deduplicate, rank, keep the top 10 to 25 rules. Fewer, better rules beat a long list

**Model access:** bring your own key (Anthropic first, OpenAI and local models later). No code leaves the machine except to the user's own model provider. State this clearly in the README since it is the first enterprise question.

### 4.3 Rule model (`holdline.rules`)
YAML, readable but managed by the tool:
```yaml
version: 1
rules:
  - id: R-003
    text: Only admins can call transferDog
    type: access
    subject: { action: transferDog }
    condition: { actorRole: [admin] }
    evidence: [src/dogs/transfer.ts:12]
    checks: [static:guard-required, test:R-003.access.test.ts]
    approved: { by: almog, at: 2026-10-20 }
```

**Rule types in v0.1:**
| Type | Example | Enforced by |
|---|---|---|
| access | Only admins can call X | Static guard check + generated test |
| invariant | Every dog has exactly one team | Schema check + generated test |
| visibility | Soft deleted records never returned | Static query check + generated test |
| flow | Every order write goes through OrderService | Static call graph check |
| data access (Firestore) | Users can only read dogs on their own team | Rules check + generated emulator test |

### 4.4 Enforcement engine
- **Static checks:** fast rules on the fact graph (milliseconds), run on every agent edit
- **Generated tests:** written per rule in the project's own language and runner (Vitest for TypeScript, pytest for Python, `go test` for Go, `@firebase/rules-unit-testing` against the Firebase emulator for Firestore rules). Stored in `.holdline/tests/`, run in CI and on demand. Tests are generated once at approval time and regenerated only when the rule or relevant code structure changes
- **Results:** structured JSON (rule id, file, line, explanation, suggested fix) so agents can act on them directly

### 4.5 Agent integration
**Claude Code hook:** a PostToolUse hook on file edits runs `holdline check --changed --format agent`. On violation, it returns feedback that tells the agent which rule broke and why.

**MCP server tools:**
- `list_rules` and `get_rule`
- `check` (all or changed files)
- `explain_violation`
- `propose_rule_change` (creates a pending change for human approval)

Cursor, Codex and other agents use the MCP server plus an instruction snippet written into AGENTS.md or Cursor rules during init.

### 4.6 GitHub Action
- Runs static checks and generated tests on PRs
- Posts one comment, edited in place, only when something breaks
- Required check mode is optional; default is comment only to avoid friction

## 5. Repository structure

```
holdline/
  packages/
    core/          fact graph, rule model, check engine
    analyzer-ts/   TypeScript, Prisma, Drizzle, Cloud Functions
    analyzer-py/   Python helper: FastAPI, Django, Flask, SQLAlchemy
    analyzer-go/   Go binary: net/http, chi, gin, sqlc, GORM
    analyzer-firestore/  firestore.rules parser, collection inference
    plugin/        Claude Code plugin (hook, MCP entry, skill)
    inference/     prompts, schemas, model adapters
    testgen/       test generation per rule type
    cli/           init, scan, review, check, approve
    mcp/           MCP server
    action/        GitHub Action
  bench/
    apps/          20 benchmark apps
    tasks/         change requests per app
    runner/        runs agents with and without holdline
  examples/
    golden-app/    small reference app with known rules
  docs/
  CLAUDE.md        project constitution for agents
```

**Stack:** TypeScript, pnpm workspaces, Vitest, ts-morph, zod for schemas, the official MCP TypeScript SDK, Changesets for releases. License: Apache 2.0.

## 6. Benchmark (the launch story)

The benchmark is both the regression harness and the marketing.

**Setup:**
- 20 small to medium apps with known business rules: about 8 TypeScript plus Postgres, 6 Python plus Postgres, 3 Go plus Postgres, 5 Firebase apps with Firestore rules (some with a React Native client) (mix of open source apps and purpose built ones, plus one real DogBase module)
- For each app, 20 to 30 realistic change requests ("add team lead role", "refactor transfer service", "add bulk import")
- Some requests are designed to tempt the agent into breaking a rule

**Measure, with and without holdline:**
- Percentage of changes that silently break a business rule
- Percentage of violations caught before PR
- False positive rate
- Extra time and tokens per task

**Headline target:** "Agents silently broke business rules in X% of changes. With holdline, Y% were caught before merge." Publish raw data and the runner so others can reproduce it.

## 7. Ten week build plan

The order keeps one complete path (TypeScript plus Postgres) working end to end first, so there is always something shippable. Each new language then only needs an analyzer and a test generator, because inference, rules and enforcement are shared.

### Week 0 (2 to 3 days, before the clock starts)
- Write `CLAUDE.md` constitution: principles, fact graph format, rule model, coding standards, what is out of scope
- Build four golden apps by hand, about 10 known rules each: TypeScript plus Postgres, Python (FastAPI) plus Postgres, Go plus Postgres, Firebase plus Firestore rules with a small React Native client
- Reserve the Holdline name (section 15)
- Set up the repo, CI and the task workflow

### Week 1: Core and TypeScript analyzer
- Shared fact graph format in `core`
- TypeScript analyzer: routes, middleware, auth checks, Prisma and Drizzle schema, call graph
- **Done when:** `holdline scan` outputs a correct fact graph for the TypeScript golden app

### Week 2: Inference and review
- Prompt design, output schema, ranking and dedupe
- Interactive review in the terminal, write `holdline.rules`
- **Done when:** on the TypeScript golden app, at least 8 of 10 known rules are proposed, with few junk rules

### Week 3: Enforcement
- Static checks for all rule types
- Test generation for TypeScript
- `holdline check` with human and agent output formats
- **Done when:** deliberately breaking each TypeScript golden app rule is caught

### Week 4: Agent and CI integration
- Claude Code plugin (hook, MCP server, review skill), GitHub Action
- `init` wiring for other agents
- `propose_rule_change` and `holdline approve` flow
- **Done when:** a full loop works on TypeScript: Claude Code breaks a rule, gets feedback, fixes it; a PR that breaks a rule gets a comment

### Week 5: Python
- Python analyzer: FastAPI, Django, Flask, SQLAlchemy and Django ORM, Pydantic
- pytest generation, `pipx install` packaging
- **Done when:** the Python golden app passes the same breakage tests as the TypeScript one

### Week 6: Firestore and React Native
- `firestore.rules` parser and collection inference from SDK call sites, including React Native client code
- Data access rule type, generated emulator tests
- **Done when:** loosening any rule in the Firebase golden app, or adding a client query the rules shouldn't allow, is caught in the agent loop and in CI

### Week 7: Go
- Go analyzer binary: net/http, chi, gin, sqlc, GORM
- `go test` generation
- **Done when:** the Go golden app passes the same breakage tests

### Week 8: Benchmark
- Build out benchmark apps and tasks across all stacks, run the comparison
- Tune false positives per language

### Week 9: Dogfooding
- Run on real DogBase modules (backend services, Postgres, Firestore rules, the React Native app's data access), fix what breaks in the real world
- **Done when:** benchmark results are in and Holdline runs cleanly on DogBase

### Week 10: Polish and launch
- README with a 60 second demo GIF, benchmark headline, privacy statement
- Docs site at holdline's domain, llms.txt
- Launch blog post on almog.io
- Launch (see section 9)

**If time runs short, cut in this order:** Go becomes a fast follow release two to three weeks after launch, then Flask and Django drop to FastAPI only. Keep TypeScript, Python, Postgres and Firestore; that combination covers the largest audience and the most distinctive launch story.

## 8. How to build it with AI

- **You own:** the rule model, rule types, CLI UX, the benchmark design and the review of every generated test. These are design decisions; don't delegate them
- **Agents own:** implementation, inside small, well scoped tasks with tests written or approved first
- **Parallel work:** run agents in separate worktrees on independent packages (each analyzer, testgen, MCP, action, plugin). The Python and Go analyzers are the most parallel friendly work in the project, since they only need to emit the shared fact format
- **Review:** a separate review agent checks each change before merge
- **Every bug becomes a benchmark or golden app case**
- **Dogfood holdline on itself** from week 4, so its own rules (for example "inference never sends full files to the model") are enforced

## 9. Launch and distribution

**During the build (weeks 1 to 10):**
- Weekly LinkedIn and X posts with real findings ("agents broke an auth rule in 3 of 10 refactors"). Feed these through the content pipeline
- Share early versions with 5 to 10 engineering leads you know for feedback

**Launch week:**
1. Benchmark blog post on almog.io
2. Show HN the same day
3. Posts in r/ClaudeAI, r/cursor, relevant Discords, with the demo GIF
4. Submit to newsletters (TLDR, Console, AI coding newsletters)
5. List on GitHub Action marketplace, MCP directories and the Claude Code plugin ecosystem

**Integrations as doors to companies:**
- Spec Kit extension: import Spec Kit specs as rules (opens a conversation with GitHub)
- OpenSpec extension
- Kiro hooks integration (opens a conversation with AWS)
- Open a well researched issue or PR on Spec Kit and OpenSpec proposing the enforcement layer

**Talks:** submit to AI Native DevCon, local Tallinn and Nordic meetups, and Node or TypeScript conferences.

## 10. Career packaging

- Project page and case study on almog.io: "how holdline caught regressions in a production SaaS"
- Top of CV and fractional CTO pitch
- Productized consulting offer: "Two weeks: I set up AI coding with enforced business rules for your team"
- Target list for direct outreach: GitHub (Spec Kit), AWS Kiro, Tessl, Augment, CodeRabbit, Cursor, Vercel, AI lab developer tooling teams, and companies hiring for AI engineering platform or developer productivity roles

## 11. Success metrics and kill criteria

**Measured 60 days after launch:**

| Signal | Good | Great |
|---|---|---|
| GitHub stars | 500 | 3,000+ |
| Weekly npm installs | 100 | 1,000+ |
| Repos with the Action installed | 30 | 200+ |
| Issues or PRs from strangers | 10 | 50+ |
| Inbound conversations from target companies | 2 | 10+ |
| Consulting inquiries | 1 | 5+ |

**Kill or pause if, 60 days after launch:** fewer than 200 stars, no inbound from target companies, and no consulting interest. Keep the benchmark, blog posts and case study as portfolio pieces and move on.

**Most important signal:** who is engaging, not how many. Ten engineering leads at real companies beat a thousand casual stars.

## 12. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Inferred rules are wrong or trivial | Rank hard, show fewer rules, always show evidence, flag "looks unintended" rules as questions |
| False positives get the check disabled | Comment only mode by default, per rule mute, track false positive rate in the benchmark |
| Privacy concerns about sending code to an LLM | Bring your own key, fact summaries instead of full files, document it clearly |
| Kiro, Spec Kit or CodeRabbit ship the same thing | Move fast, integrate with them rather than compete, and treat being noticed by them as a win |
| Scope creep | Out of scope list above is final for v0.1. New ideas go to a later list |
| Time pulled from DogBase | Strict ten week box, and dogfood on DogBase so the work benefits it either way |

## 13. After v0.1 (only if signals are good)

1. Supabase row level security, then Java and Kotlin (Spring), C# and MongoDB
2. Property based tests for invariants (fast-check)
3. Runtime guards as a small middleware
4. Frontend rules (React: permission gated UI, data exposure)
5. Spec Kit and OpenSpec two way sync
6. Team features: rule ownership, approval policies
7. Optional hosted dashboard, only if a business case appears

## 14. Immediate next steps

1. Pick the name from section 15 and reserve the npm package, GitHub org and domain
2. Write the `CLAUDE.md` constitution
3. Build the four golden apps
4. Start week 1

## 15. Naming

**Chosen name: Holdline.** "Hold the line": approved rules don't move unless you say so. The npm name `holdline` was free as of October 14, 2026.

**Reserve now, before anything is public:**
- npm: `holdline` (publish a placeholder 0.0.1) and the `@holdline` scope
- PyPI: `holdline` for the Python install
- GitHub org: `github.com/holdline`
- Domain: holdline.dev or holdline.sh
- Social handles on X and LinkedIn
- A quick trademark search in the US and EU

**Naming conventions in the product:**
| Thing | Name |
|---|---|
| CLI | `holdline` |
| Rules file | `holdline.rules` |
| Managed folder | `.holdline/` (tests, cache) |
| GitHub Action | `holdline/check` |
| Claude Code plugin | `holdline` |
| MCP server | `holdline-mcp` |
