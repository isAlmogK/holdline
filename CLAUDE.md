# Holdline

Holdline discovers the business rules in a codebase, gets them approved in plain language,
and enforces them deterministically when an agent or a person changes the code.

The design is [docs/superpowers/specs/2026-10-21-holdline-design.md](docs/superpowers/specs/2026-10-21-holdline-design.md).
Read it before changing anything in `packages/core`.

## Principles

- Three layers: analyzers (code → facts, deterministic), inference (facts → proposed rules, done by
  the user's own agent, never by Holdline), enforcement (rules + facts → results, deterministic).
- No model ever decides whether a check passes. Checkers are pure functions.
- Holdline makes no network calls and ships no model client.
- When Holdline can't prove something, it reports it (violation, stale, unknown). Never a silent pass.
  An `opaque` condition never satisfies a requirement.

## Contracts (frozen)

These are the interface between parallel tracks. Changing one means updating the spec first.

| Contract | Source |
|---|---|
| Fact graph | `packages/core/src/facts.ts`, `packages/core/src/expr.ts` |
| Rule model (`holdline.rules`) | `packages/core/src/rules.ts` |
| Results | `packages/core/src/results.ts` |
| DB test cases (`.holdline/tests/*.yaml`) | `packages/core/src/testcase.ts` |
| Analyzer contract | `packages/core/src/analyzer.ts` |

Reference docs (keep true when a contract changes): [docs/reference/facts.md](docs/reference/facts.md),
[docs/reference/rules-file.md](docs/reference/rules-file.md).

## Layout

| Folder | What |
|---|---|
| `packages/core` | Contracts, predicate logic, checkers, test generator, proposals, prompt, scan |
| `packages/cli` | The `holdline` command, a thin layer over core |
| `packages/analyzer-*` | One per stack (Phase 1 and 2), each emits the fact graph |
| `examples/golden-*` | Small apps with known rules and one breakage per rule |

## Adding an analyzer

A package under `packages/analyzer-*` depends only on `@holdline/core`. It is registered by one import and one array
entry in `packages/cli/src/analyzers.ts`. Its settings come from its own section of `.holdline/config.yaml`
(`AnalyzerContext.config`, see [docs/reference/facts.md](docs/reference/facts.md)).

## Golden apps

Phase 0 `golden-ts-postgres` uses JSON-patch breakages (`fixtures/breakages/*.json`) applied to hand-written facts.
Phase 1 apps use `breakages/*.patch` unified diffs against the app, run end to end.

## Commands

- `pnpm test`: all tests
- `pnpm typecheck`: TypeScript
- `pnpm holdline <command>`: run the CLI from source

## How to work

- Superpowers workflow: brainstorm → spec → plan → TDD. Specs and plans in `docs/superpowers/`.
- Write the failing test first. Every bug becomes a test or a golden-app breakage.
- ESM, strict TypeScript, relative imports end in `.js`. Validate boundaries with zod.
- One responsibility per file; split files that pass about 200 lines.
- Conventional commits on a feature branch, never on `main`.

## Never

- Never commit DogBase code, rules or facts. The DogBase reference set lives in the private dogbase repo.
- Never add network calls or a model client to Holdline.
- Never edit `holdline.rules` approvals by hand in tests; use `scripts/approve-fixture.ts`.

## Out of scope for v0.1

Generated handler tests, Flask, Java/Kotlin, C#, MongoDB, frontend UI rules, runtime guards,
BYOK model calls, hosted service.
