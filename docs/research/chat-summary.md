# Conversation Summary: AI Native Frameworks and Holdline

October 14, 2026

## Where it started

The opening question: if AI agents write most of the code and developers stop reading it, why keep frameworks around the backend, data layer and frontend? Wouldn't it be better to have one framework that lets the agent write code at the lowest level possible?

## Key conclusions

### 1. Going lower is the wrong direction
- Frameworks compress intent. Lower level code means more tokens, more bugs and more to verify, even for an AI.
- The real bottleneck is verification, not generation. High level, typed, conventional code is far easier to check.
- Compilers already write the low level code, deterministically. Replacing them with a probabilistic model trades a solved problem for an unsolved one.
- Mature libraries (Postgres, TLS, crypto, React) hold decades of fixed edge cases. Regenerating them per app reintroduces those bugs.
- The layers exist for physical reasons: browsers, phones and databases have their own constraints regardless of who writes the code.
- Exception: hot paths like GPU kernels, where AI generated low level code can be checked against a slow reference implementation.

### 2. The spec becomes the source of truth
A useful spec has five parts: domain model, behaviors (pre and post conditions), invariants, policies, and scenarios that become tests. Pieces of this exist separately (OpenAPI, Prisma, Gherkin, TLA+, Dafny) but nothing unifies them for agents.

### 3. What makes a framework AI native
A human framework is designed to be pleasant to write. An AI native framework is designed to be impossible to misunderstand and cheap to verify:
- Explicit over magic
- Locality: everything about a feature in one place
- One way to do each thing
- Declared side effects, enforced
- Contracts as first class code
- Structured, machine readable errors
- Self describing (the agent can query the framework about itself)
- Stable APIs
- Clear separation between generated code and human owned code

### 4. Users should not write specs or config
The AI writes the rules from conversation and the user approves them in plain language. The rules file works like a lockfile: important, readable, but nobody edits it by hand. The real payoff is on changes, where the tool catches conflicts with earlier decisions instead of letting the agent silently change behavior.

### 5. Existing agent guardrails do not cover business rules
Agents today have four layers of protection: model safety training, permissions and sandboxing, instruction files (CLAUDE.md, AGENTS.md, Cursor rules), and hooks plus CI. Instruction files know the rules but do not enforce them. Hooks and CI enforce, but only what someone wrote checks for. Nothing in between discovers business rules and enforces them deterministically.

### 6. The pivot: inferred rules, enforced in CI
The spec first version asks people to change how they work, which kills adoption. The version that spreads works on an existing repo in five minutes:
1. `npx holdline init`
2. It reads the codebase and proposes rules in plain language
3. The user approves them
4. Rules are enforced through agent hooks while the agent works, and through a GitHub check on every PR
5. Rule changes only happen with explicit approval

The working name was "Keeper"; the final name is Holdline.

## Strategy decisions

- **Goal:** not a startup. The goal is career leverage: full time roles, consulting projects, an acqui-hire, or an acquisition.
- **Realistic odds, most to least likely:** consulting projects, full time offers, acqui-hire, acquisition.
- **Main risk:** spec tools (Spec Kit, Kiro, Tessl) or AI labs build enforcement themselves. This is acceptable because the goal is visibility to exactly those teams.
- **Users matter, but who matters more than how many.** Exposure comes from distribution and one strong story (the benchmark post), and users follow.
- **Distribution:** ride existing channels (GitHub Action marketplace, Claude Code plugins, MCP directories, Spec Kit and OpenSpec extensions). Every PR comment is visible to a whole team, which is the built in growth loop.
- **Time box:** ten weeks with clear kill criteria. Launch support is the most popular languages (TypeScript, Python, Go), Postgres and Firebase Firestore including security rules, with React Native and web clients covered through the data layer. That reaches a wide audience and covers the DogBase stack from day one.
- **Dogfooding:** build and prove it on real DogBase modules.
- **Install:** Claude Code plugin first (the Superpowers lesson), `npx` or a single binary for everyone else.
- **Name:** Holdline. "Keeper" was dropped because it is taken on npm and Keeper Security owns the name.

## Superpowers vs Spec Kit
Both are workflow tools, not rule enforcement. Spec Kit is artifact centric: it scaffolds spec, plan and task files any agent can use. Superpowers is behavior centric: Claude Code skills that make the agent brainstorm, plan, do TDD and review like a senior engineer. Neither knows or enforces your business rules, which is the gap this project fills.

## Positioning in one line

AI reviewers might notice when an agent breaks your business rules. Holdline makes sure the rules you approved can't be broken silently.

## Related files
- `market-research.md`: competitors, what AI labs are doing, and where the gap is
- `implementation-plan.md`: architecture, six week build plan, launch and success criteria
