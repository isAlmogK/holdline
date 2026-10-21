# Holdline Phase 0: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@holdline/core` and the `holdline` CLI so that `holdline check` runs end to end on hand-written facts, with the fact graph, rule model and test-case formats frozen as contracts for the parallel Phase 1 to 3 tracks.

**Architecture:** A pnpm monorepo. `packages/core` holds the contracts (zod schemas for facts, rules, test cases), the predicate logic (implication), the fact index, the five rule checkers, the DB test-case generator, proposal validation and the inference prompt. `packages/cli` is a thin commander layer over core with injectable I/O so commands are tested in process. `examples/golden-ts-postgres` holds a small Express + Prisma app, its expected rules, a hand-written facts file and one breakage per rule; an end-to-end test proves every breakage is caught.

**Tech Stack:** TypeScript 5.9 on Node 20+, pnpm 10 workspaces, Vitest 5, zod 4, yaml 2, commander 15, fast-check 4, tsx 4.

**Spec:** [`docs/superpowers/specs/2026-10-21-holdline-design.md`](../specs/2026-10-21-holdline-design.md). Section numbers below (§5.3 etc.) refer to it.

## Global Constraints

- Node 20 or newer; ESM only (`"type": "module"`); relative imports end in `.js` (they resolve to `.ts` under tsx and Vitest).
- TypeScript `strict: true`. No `any` in exported signatures.
- Validate every input that crosses a boundary (files, JSON, CLI args) with zod.
- Holdline makes no network calls. No model client anywhere in the code.
- No model decides whether a check passes; checkers are pure functions of facts and rules.
- `opaque` conditions never satisfy a requirement (§5.3, §7.1).
- Rule ids match `R-` followed by three or more digits; vocabulary ids are lowercase slugs.
- Exit codes: 0 no violations, 1 violation or unapproved edit (with `--strict` also stale or unknown), 2 usage or config error, 3 analyzer or internal error (§9.2).
- Files: one responsibility each; prefer files under 200 lines.
- Never commit DogBase code, rules or facts to this repo (§11).
- Commits use conventional commit messages and end with the `Co-Authored-By:` trailer naming the model that wrote the commit (the committing agent's own attribution instructions). Work happens on a feature branch, never on `main`.

## File Structure

```
package.json, pnpm-workspace.yaml, tsconfig.base.json, vitest.config.ts
CLAUDE.md, README.md, .github/workflows/ci.yml
scripts/approve-fixture.ts            dev-only: fill approval hashes in a fixture rules file
packages/core/
  package.json, tsconfig.json
  src/canonical.ts                    canonical JSON, sha256, deepEqual
  src/expr.ts                         Operand, Atom, Expr types and schemas
  src/format.ts                       formatOperand, formatAtom, formatExpr
  src/logic.ts                        expand, atomImplies, prove, implies, renameParams, collectRefs, mentionsOperand
  src/paths.ts                        path patterns, overlap, param alignment, route selectors, table names
  src/facts.ts                        fact graph schemas, parseFacts, mergeFacts
  src/rules.ts                        rule model schemas, YAML parse/serialize, enforce defaults, ids
  src/hash.ts                         hashRule
  src/fact-index.ts                   FactIndex: lookups over a fact graph
  src/results.ts                      Result, Summary, describeTarget
  src/check/types.ts                  CheckContext, CheckOutcome, Violation
  src/check/access.ts, data-access.ts, visibility.ts, flow.ts, invariant.ts
  src/check/run.ts                    evaluateRule, checkRule, runChecks
  src/testcase.ts                     test-case file schema
  src/testgen.ts                      generateTests for data-access rules
  src/proposals.ts                    validateProposals
  src/pending.ts                      pending file, addToPending, approve, reject, mute
  src/prompt.ts                       buildInferPrompt
  src/analyzer.ts                     Analyzer contract
  src/cache.ts                        FileCache
  src/scan.ts                         listFiles, scan
  src/index.ts                        public exports
  test/*.test.ts
packages/cli/
  package.json, tsconfig.json
  src/bin.ts, src/main.ts, src/io.ts, src/workspace.ts, src/analyzers.ts
  src/format/human.ts, agent.ts, json.ts
  src/commands/check.ts, explain.ts, mute.ts, scan.ts, infer.ts, propose.ts, approve.ts, review.ts
  test/*.test.ts, test/helpers/*.ts
examples/golden-ts-postgres/
  README.md, package.json, prisma/schema.prisma, prisma/migrations/0001_init/migration.sql
  src/** (app source)
  expected-rules.yaml
  fixtures/facts.json, fixtures/breakages/R-001.json … R-012.json
```

---

### Task 1: Monorepo scaffold, constitution and CI

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.config.ts`, `README.md`, `CLAUDE.md`, `.github/workflows/ci.yml`
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/src/index.ts`, `packages/core/test/smoke.test.ts`
- Create: `packages/cli/package.json`, `packages/cli/tsconfig.json`, `packages/cli/src/index.ts`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `@holdline/core` importable from `packages/cli` (`"@holdline/core": "workspace:*"`), root scripts `pnpm test`, `pnpm typecheck`, `pnpm holdline`.

- [ ] **Step 1: Write root config files**

`package.json`:
```json
{
  "name": "holdline-monorepo",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.34.6",
  "engines": { "node": ">=20" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc -p packages/core && tsc -p packages/cli",
    "holdline": "tsx packages/cli/src/bin.ts"
  },
  "devDependencies": {
    "@types/node": "^22.20.5",
    "fast-check": "^4.10.2",
    "tsx": "^4.23.15",
    "typescript": "~5.9.3",
    "vitest": "^5.0.5"
  }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - packages/*
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": true,
    "resolveJsonModule": true,
    "types": ["node"]
  }
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
  },
})
```

Append to `.gitignore`:
```
.holdline/pending.yaml
*.tsbuildinfo
```

- [ ] **Step 2: Write package skeletons**

`packages/core/package.json`:
```json
{
  "name": "@holdline/core",
  "version": "0.0.0",
  "type": "module",
  "license": "Apache-2.0",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "yaml": "^2.9.1",
    "zod": "^4.6.7"
  }
}
```

`packages/core/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
```

`packages/core/src/index.ts`:
```ts
export const HOLDLINE_FACTS_VERSION = 1
```

`packages/cli/package.json`:
```json
{
  "name": "holdline",
  "version": "0.0.0",
  "type": "module",
  "license": "Apache-2.0",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "@holdline/core": "workspace:*",
    "commander": "^15.0.0",
    "yaml": "^2.9.1"
  }
}
```

`packages/cli/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
```

`packages/cli/src/index.ts`:
```ts
export {}
```

- [ ] **Step 3: Write the smoke test**

`packages/core/test/smoke.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { HOLDLINE_FACTS_VERSION } from '../src/index.js'

describe('core package', () => {
  it('exposes the facts version', () => {
    expect(HOLDLINE_FACTS_VERSION).toBe(1)
  })
})
```

- [ ] **Step 4: Install and run**

Run: `pnpm install && pnpm test && pnpm typecheck`
Expected: 1 test passes; typecheck prints nothing and exits 0.

- [ ] **Step 5: Write `CLAUDE.md`**

```markdown
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

## Layout

| Folder | What |
|---|---|
| `packages/core` | Contracts, predicate logic, checkers, test generator, proposals, prompt, scan |
| `packages/cli` | The `holdline` command, a thin layer over core |
| `packages/analyzer-*` | One per stack (Phase 1 and 2), each emits the fact graph |
| `examples/golden-*` | Small apps with known rules and one breakage per rule |

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
```

- [ ] **Step 6: Write `README.md` and CI**

`README.md`:
```markdown
# Holdline

AI reviewers might notice when an agent breaks your business rules. Holdline makes sure the rules
you approved can't be broken silently.

Status: under construction. Design: [docs/superpowers/specs/2026-10-21-holdline-design.md](docs/superpowers/specs/2026-10-21-holdline-design.md).

## Develop

    pnpm install
    pnpm test
    pnpm holdline --help

License: Apache 2.0
```

`.github/workflows/ci.yml`:
```yaml
name: ci
on:
  pull_request:
  push:
    branches: [main]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm test
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: scaffold pnpm monorepo with core and cli packages"
```

---

### Task 2: Canonical JSON, expressions and formatting

**Files:**
- Create: `packages/core/src/canonical.ts`, `packages/core/src/expr.ts`, `packages/core/src/format.ts`
- Test: `packages/core/test/expr.test.ts`

**Interfaces:**
- Produces:
  - `canonicalJson(value: unknown): string`, `sha256Hex(text: string): string`, `deepEqual(a: unknown, b: unknown): boolean`
  - Types `Literal`, `Operand`, `ComparisonOp`, `Atom`, `Expr`; schemas `LiteralSchema`, `OperandSchema`, `AtomSchema`, `ExprSchema`; constants `TRUE: Expr` (`{ and: [] }`), `FALSE: Expr` (`{ or: [] }`), `OPERAND_PATTERN`
  - `formatOperand(o: Operand): string`, `formatAtom(a: Atom): string`, `formatExpr(e: Expr): string`

- [ ] **Step 1: Write the failing tests**

`packages/core/test/expr.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { canonicalJson, deepEqual } from '../src/canonical.js'
import { ExprSchema, OperandSchema } from '../src/expr.js'
import { formatExpr } from '../src/format.js'

describe('canonicalJson', () => {
  it('sorts keys at every level and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: undefined } }))
      .toBe('{"a":{"d":[2,{"y":2,"z":1}]},"b":1}')
  })
  it('deepEqual ignores key order', () => {
    expect(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true)
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false)
  })
})

describe('OperandSchema', () => {
  it('accepts the documented operand forms', () => {
    for (const o of ['actor.uid', 'actor.role', 'actor.claim.team_id', 'resource.owner_id', 'incoming.name', 'param.accountId']) {
      expect(OperandSchema.safeParse(o).success).toBe(true)
    }
    expect(OperandSchema.safeParse({ literal: ['admin'] }).success).toBe(true)
  })
  it('rejects anything else', () => {
    expect(OperandSchema.safeParse('request.auth.uid').success).toBe(false)
    expect(OperandSchema.safeParse('param.a.b').success).toBe(false)
  })
})

describe('ExprSchema', () => {
  it('parses nested expressions', () => {
    const e = {
      and: [
        { atom: { op: 'authenticated' } },
        { or: [{ ref: 'account-member' }, { not: { opaque: 'x' } }] },
        { atom: { op: 'in', left: 'actor.role', right: { literal: ['admin'] } } },
      ],
    }
    expect(ExprSchema.parse(e)).toEqual(e)
  })
  it('rejects unknown keys and ops', () => {
    expect(ExprSchema.safeParse({ atom: { op: 'like', left: 'actor.uid', right: 'resource.x' } }).success).toBe(false)
    expect(ExprSchema.safeParse({ and: [], extra: 1 }).success).toBe(false)
  })
})

describe('formatExpr', () => {
  it('prints readable conditions', () => {
    expect(formatExpr({
      and: [
        { atom: { op: 'eq', left: 'actor.uid', right: 'resource.owner_id' } },
        { or: [{ ref: 'staff' }, { atom: { op: 'isNull', operand: 'resource.deleted_at' } }] },
      ],
    })).toBe('actor.uid == resource.owner_id and (staff or resource.deleted_at is null)')
    expect(formatExpr({ atom: { op: 'in', left: 'actor.role', right: { literal: ['admin', 'owner'] } } }))
      .toBe('actor.role in ["admin","owner"]')
    expect(formatExpr({ and: [] })).toBe('true')
    expect(formatExpr({ or: [] })).toBe('false')
    expect(formatExpr({ opaque: 'customCheck()' })).toBe('<customCheck()>')
    expect(formatExpr({ atom: { op: 'exists', doc: '/accounts/{param.a}/members/{actor.uid}' } }))
      .toBe('exists(/accounts/{param.a}/members/{actor.uid})')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/core/test/expr.test.ts`
Expected: FAIL, cannot find module `../src/canonical.js`.

- [ ] **Step 3: Implement**

`packages/core/src/canonical.ts`:
```ts
import { createHash } from 'node:crypto'

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export function deepEqual(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b)
}
```

`packages/core/src/expr.ts`:
```ts
import { z } from 'zod'

export type Literal = string | number | boolean | null | (string | number)[]
export type Operand = string | { literal: Literal }

export const OPERAND_PATTERN =
  /^(actor\.uid|actor\.role|actor\.claim\.[A-Za-z0-9_.]+|resource\.[A-Za-z0-9_.]+|incoming\.[A-Za-z0-9_.]+|param\.[A-Za-z0-9_]+)$/

export const LiteralSchema = z.union([
  z.string(), z.number(), z.boolean(), z.null(), z.array(z.union([z.string(), z.number()])),
])

export const OperandSchema = z.union([
  z.string().regex(OPERAND_PATTERN, 'operand must be actor.uid, actor.role, actor.claim.*, resource.*, incoming.* or param.*'),
  z.strictObject({ literal: LiteralSchema }),
])

export const COMPARISON_OPS = ['eq', 'ne', 'in', 'lt', 'gt'] as const
export type ComparisonOp = (typeof COMPARISON_OPS)[number]

export type Atom =
  | { op: 'authenticated' }
  | { op: ComparisonOp; left: Operand; right: Operand }
  | { op: 'exists'; doc: string }
  | { op: 'isNull'; operand: Operand }

export const AtomSchema = z.union([
  z.strictObject({ op: z.literal('authenticated') }),
  z.strictObject({ op: z.enum(COMPARISON_OPS), left: OperandSchema, right: OperandSchema }),
  z.strictObject({ op: z.literal('exists'), doc: z.string().min(1) }),
  z.strictObject({ op: z.literal('isNull'), operand: OperandSchema }),
])

export type Expr =
  | { and: Expr[] }
  | { or: Expr[] }
  | { not: Expr }
  | { atom: Atom }
  | { ref: string }
  | { opaque: string }

export const ExprSchema: z.ZodType<Expr> = z.lazy(() =>
  z.union([
    z.strictObject({ and: z.array(ExprSchema) }),
    z.strictObject({ or: z.array(ExprSchema) }),
    z.strictObject({ not: ExprSchema }),
    z.strictObject({ atom: AtomSchema }),
    z.strictObject({ ref: z.string().min(1) }),
    z.strictObject({ opaque: z.string() }),
  ]),
)

export const TRUE: Expr = { and: [] }
export const FALSE: Expr = { or: [] }
```

`packages/core/src/format.ts`:
```ts
import type { Atom, ComparisonOp, Expr, Operand } from './expr.js'

const SYMBOLS: Record<ComparisonOp, string> = { eq: '==', ne: '!=', in: 'in', lt: '<', gt: '>' }

export function formatOperand(o: Operand): string {
  return typeof o === 'string' ? o : JSON.stringify(o.literal)
}

export function formatAtom(a: Atom): string {
  switch (a.op) {
    case 'authenticated': return 'authenticated'
    case 'exists': return `exists(${a.doc})`
    case 'isNull': return `${formatOperand(a.operand)} is null`
    default: return `${formatOperand(a.left)} ${SYMBOLS[a.op]} ${formatOperand(a.right)}`
  }
}

export function formatExpr(e: Expr): string {
  if ('atom' in e) return formatAtom(e.atom)
  if ('ref' in e) return e.ref
  if ('opaque' in e) return `<${e.opaque}>`
  if ('not' in e) return `not (${formatExpr(e.not)})`
  if ('and' in e) return e.and.length === 0 ? 'true' : e.and.map(wrap).join(' and ')
  return e.or.length === 0 ? 'false' : e.or.map(wrap).join(' or ')
}

function wrap(e: Expr): string {
  return 'and' in e || 'or' in e ? `(${formatExpr(e)})` : formatExpr(e)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/test/expr.test.ts && pnpm typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): add predicate expression schemas and formatting"
```

---

### Task 3: Implication logic

**Files:**
- Create: `packages/core/src/logic.ts`
- Test: `packages/core/test/logic.test.ts`

**Interfaces:**
- Consumes: `Atom`, `Expr`, `Operand`, `Literal` (Task 2), `deepEqual` (Task 2)
- Produces:
  - `type Vocabulary = ReadonlyMap<string, Expr>`
  - `expand(expr: Expr, vocab: Vocabulary): Expr`
  - `atomImplies(a: Atom, b: Atom): boolean`
  - `prove(cond: Expr, req: Expr): boolean` (both already expanded)
  - `type Implication = { ok: true } | { ok: false; unproven: Expr }`
  - `implies(cond: Expr, req: Expr, vocab: Vocabulary): Implication`
  - `renameParams(expr: Expr, names: ReadonlyMap<string, string>): Expr`
  - `collectRefs(expr: Expr): string[]`
  - `mentionsOperand(expr: Expr, operand: string): boolean`
  - `flattenAnd(expr: Expr): Expr[]` (list of conjuncts, nested `and` flattened)

- [ ] **Step 1: Write the failing tests**

`packages/core/test/logic.test.ts`:
```ts
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { Atom, Expr } from '../src/expr.js'
import { atomImplies, collectRefs, expand, flattenAnd, implies, mentionsOperand, prove, renameParams } from '../src/logic.js'

const a = (atom: Atom): Expr => ({ atom })
const member = a({ op: 'exists', doc: '/accounts/{param.accountId}/members/{actor.uid}' })
const owner = a({ op: 'eq', left: 'actor.uid', right: 'resource.owner_id' })
const admin = a({ op: 'in', left: 'actor.role', right: { literal: ['admin'] } })
const notDeleted = a({ op: 'isNull', operand: 'resource.deleted_at' })
const noVocab = new Map<string, Expr>()

describe('atomImplies', () => {
  it('treats eq as symmetric and normalizes literal sides', () => {
    expect(atomImplies(
      { op: 'eq', left: 'resource.owner_id', right: 'actor.uid' },
      { op: 'eq', left: 'actor.uid', right: 'resource.owner_id' },
    )).toBe(true)
    expect(atomImplies(
      { op: 'eq', left: { literal: 'admin' }, right: 'actor.role' },
      { op: 'eq', left: 'actor.role', right: { literal: 'admin' } },
    )).toBe(true)
  })
  it('handles in-subsets and eq-into-in', () => {
    const inSet = (xs: string[]): Atom => ({ op: 'in', left: 'actor.role', right: { literal: xs } })
    expect(atomImplies(inSet(['admin']), inSet(['admin', 'owner']))).toBe(true)
    expect(atomImplies(inSet(['admin', 'member']), inSet(['admin', 'owner']))).toBe(false)
    expect(atomImplies({ op: 'eq', left: 'actor.role', right: { literal: 'owner' } }, inSet(['admin', 'owner']))).toBe(true)
  })
  it('any actor-dependent atom implies authenticated', () => {
    expect(atomImplies({ op: 'eq', left: 'actor.uid', right: 'resource.owner_id' }, { op: 'authenticated' })).toBe(true)
    expect(atomImplies({ op: 'exists', doc: '/m/{actor.uid}' }, { op: 'authenticated' })).toBe(true)
    expect(atomImplies({ op: 'isNull', operand: 'resource.deleted_at' }, { op: 'authenticated' })).toBe(false)
    expect(atomImplies({ op: 'authenticated' }, { op: 'eq', left: 'actor.uid', right: 'resource.owner_id' })).toBe(false)
  })
  it('compares exists docs and isNull operands exactly', () => {
    expect(atomImplies({ op: 'exists', doc: '/a/{x}' }, { op: 'exists', doc: '/a/{x}' })).toBe(true)
    expect(atomImplies({ op: 'exists', doc: '/a/{x}' }, { op: 'exists', doc: '/a/{y}' })).toBe(false)
  })
})

describe('implies', () => {
  it('and implies each of its parts; or needs every branch', () => {
    expect(implies({ and: [member, owner] }, member, noVocab)).toEqual({ ok: true })
    expect(implies({ or: [member, owner] }, member, noVocab).ok).toBe(false)
    expect(implies({ or: [{ and: [member, admin] }, { and: [member, owner] }] }, member, noVocab)).toEqual({ ok: true })
  })
  it('proves or-requirements from and-conditions holding an or', () => {
    expect(implies({ and: [notDeleted, { or: [member, owner] }] }, { or: [member, owner] }, noVocab)).toEqual({ ok: true })
  })
  it('reports the unproven top-level parts', () => {
    expect(implies(member, { and: [member, owner] }, noVocab)).toEqual({ ok: false, unproven: owner })
    expect(implies({ and: [] }, { and: [member, owner] }, noVocab)).toEqual({ ok: false, unproven: { and: [member, owner] } })
  })
  it('false (no policies) implies anything; nothing implies false', () => {
    expect(implies({ or: [] }, member, noVocab)).toEqual({ ok: true })
    expect(implies(member, { or: [] }, noVocab).ok).toBe(false)
  })
  it('opaque never proves anything, not even itself', () => {
    expect(implies({ opaque: 'x' }, { opaque: 'x' }, noVocab).ok).toBe(false)
    expect(implies({ opaque: 'x' }, member, noVocab).ok).toBe(false)
  })
  it('expands vocabulary refs on both sides and reports them unexpanded', () => {
    const vocab = new Map<string, Expr>([['account-member', member], ['staff', admin]])
    expect(implies({ ref: 'account-member' }, member, vocab)).toEqual({ ok: true })
    expect(implies(member, { and: [{ ref: 'account-member' }, { ref: 'staff' }] }, vocab))
      .toEqual({ ok: false, unproven: { ref: 'staff' } })
  })
  it('unknown and circular refs become opaque', () => {
    expect(expand({ ref: 'nope' }, noVocab)).toEqual({ opaque: 'unknown predicate "nope"' })
    const loop = new Map<string, Expr>([['a', { ref: 'b' }], ['b', { ref: 'a' }]])
    expect(expand({ ref: 'a' }, loop)).toEqual({ opaque: 'circular predicate "a"' })
  })
})

describe('properties', () => {
  const atoms: Expr[] = [member, owner, admin, notDeleted, a({ op: 'authenticated' })]
  const expr: fc.Arbitrary<Expr> = fc.letrec<{ e: Expr }>(tie => ({
    e: fc.oneof(
      { depthSize: 'small', withCrossShrink: true },
      fc.constantFrom(...atoms),
      fc.array(tie('e'), { maxLength: 3 }).map(xs => ({ and: xs })),
      fc.array(tie('e'), { maxLength: 3 }).map(xs => ({ or: xs })),
    ),
  })).e

  it('every expression implies itself unless it contains opaque', () => {
    fc.assert(fc.property(expr, e => prove(e, e)))
  })
  it('and[x, y] implies x, and x implies or[x, y]', () => {
    fc.assert(fc.property(expr, expr, (x, y) => prove({ and: [x, y] }, x) && prove(x, { or: [x, y] })))
  })
})

describe('helpers', () => {
  it('renameParams renames operands and doc placeholders', () => {
    const e: Expr = { and: [
      a({ op: 'exists', doc: '/accounts/{param.acct}/members/{actor.uid}' }),
      a({ op: 'eq', left: 'param.acct', right: 'resource.account_id' }),
    ] }
    expect(renameParams(e, new Map([['acct', 'accountId']]))).toEqual({ and: [
      a({ op: 'exists', doc: '/accounts/{param.accountId}/members/{actor.uid}' }),
      a({ op: 'eq', left: 'param.accountId', right: 'resource.account_id' }),
    ] })
  })
  it('collectRefs, mentionsOperand and flattenAnd', () => {
    const e: Expr = { and: [{ ref: 'x' }, { and: [owner, { not: { ref: 'y' } }] }] }
    expect(collectRefs(e).sort()).toEqual(['x', 'y'])
    expect(mentionsOperand(e, 'resource.owner_id')).toBe(true)
    expect(mentionsOperand(e, 'incoming.owner_id')).toBe(false)
    expect(flattenAnd(e)).toEqual([{ ref: 'x' }, owner, { not: { ref: 'y' } }])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/core/test/logic.test.ts`
Expected: FAIL, cannot find module `../src/logic.js`.

- [ ] **Step 3: Implement**

`packages/core/src/logic.ts`:
```ts
import { deepEqual } from './canonical.js'
import type { Atom, Expr, Literal, Operand } from './expr.js'

export type Vocabulary = ReadonlyMap<string, Expr>
export type Implication = { ok: true } | { ok: false; unproven: Expr }

export function expand(expr: Expr, vocab: Vocabulary, seen: ReadonlySet<string> = new Set()): Expr {
  if ('ref' in expr) {
    if (seen.has(expr.ref)) return { opaque: `circular predicate "${expr.ref}"` }
    const target = vocab.get(expr.ref)
    if (!target) return { opaque: `unknown predicate "${expr.ref}"` }
    return expand(target, vocab, new Set([...seen, expr.ref]))
  }
  if ('and' in expr) return { and: expr.and.map(e => expand(e, vocab, seen)) }
  if ('or' in expr) return { or: expr.or.map(e => expand(e, vocab, seen)) }
  if ('not' in expr) return { not: expand(expr.not, vocab, seen) }
  return expr
}

const isLiteral = (o: Operand): o is { literal: Literal } => typeof o !== 'string'
const isActor = (o: Operand) => typeof o === 'string' && o.startsWith('actor.')

function normalizeAtom(a: Atom): Atom {
  if ((a.op === 'eq' || a.op === 'ne') && isLiteral(a.left) && !isLiteral(a.right)) {
    return { op: a.op, left: a.right, right: a.left }
  }
  return a
}

function mentionsActor(a: Atom): boolean {
  switch (a.op) {
    case 'authenticated': return true
    case 'exists': return a.doc.includes('{actor.')
    case 'isNull': return isActor(a.operand)
    default: return isActor(a.left) || isActor(a.right)
  }
}

function literalSet(o: Operand): (string | number)[] | undefined {
  if (!isLiteral(o)) return undefined
  const v = o.literal
  if (Array.isArray(v)) return v
  return typeof v === 'string' || typeof v === 'number' ? [v] : undefined
}

export function atomImplies(rawA: Atom, rawB: Atom): boolean {
  const a = normalizeAtom(rawA)
  const b = normalizeAtom(rawB)
  if (b.op === 'authenticated') return mentionsActor(a)
  if (a.op === 'authenticated') return false
  if (b.op === 'exists') return a.op === 'exists' && a.doc === b.doc
  if (b.op === 'isNull') return a.op === 'isNull' && deepEqual(a.operand, b.operand)
  if (a.op === 'exists' || a.op === 'isNull') return false
  if (b.op === 'in') {
    if ((a.op !== 'in' && a.op !== 'eq') || !deepEqual(a.left, b.left)) return false
    const have = literalSet(a.right)
    const allowed = literalSet(b.right)
    return !!have && !!allowed && have.every(v => allowed.includes(v))
  }
  if (a.op !== b.op) return false
  if (deepEqual(a.left, b.left) && deepEqual(a.right, b.right)) return true
  return (a.op === 'eq' || a.op === 'ne') && deepEqual(a.left, b.right) && deepEqual(a.right, b.left)
}

// Both sides must already be expanded. Order matters: split the requirement's `and`,
// then the condition's `or`, then try the condition's `and`, then the requirement's `or`.
export function prove(c: Expr, r: Expr): boolean {
  if ('and' in r) return r.and.every(ri => prove(c, ri))
  if ('or' in c) return c.or.every(ci => prove(ci, r))
  if ('and' in c && c.and.some(ci => prove(ci, r))) return true
  if ('or' in r && r.or.some(ri => prove(c, ri))) return true
  if ('atom' in c && 'atom' in r) return atomImplies(c.atom, r.atom)
  if ('not' in c && 'not' in r) return !containsOpaque(c.not) && deepEqual(c.not, r.not)
  return false
}

export function implies(cond: Expr, req: Expr, vocab: Vocabulary): Implication {
  const c = expand(cond, vocab)
  const parts = 'and' in req ? req.and : [req]
  const failing = parts.filter(p => !prove(c, expand(p, vocab)))
  if (failing.length === 0) return { ok: true }
  return { ok: false, unproven: failing.length === 1 ? failing[0]! : { and: failing } }
}

function containsOpaque(e: Expr): boolean {
  if ('opaque' in e) return true
  if ('and' in e) return e.and.some(containsOpaque)
  if ('or' in e) return e.or.some(containsOpaque)
  if ('not' in e) return containsOpaque(e.not)
  return false
}

function mapAtoms(expr: Expr, f: (a: Atom) => Atom): Expr {
  if ('atom' in expr) return { atom: f(expr.atom) }
  if ('and' in expr) return { and: expr.and.map(e => mapAtoms(e, f)) }
  if ('or' in expr) return { or: expr.or.map(e => mapAtoms(e, f)) }
  if ('not' in expr) return { not: mapAtoms(expr.not, f) }
  return expr
}

function atoms(expr: Expr): Atom[] {
  if ('atom' in expr) return [expr.atom]
  if ('and' in expr) return expr.and.flatMap(atoms)
  if ('or' in expr) return expr.or.flatMap(atoms)
  if ('not' in expr) return atoms(expr.not)
  return []
}

export function renameParams(expr: Expr, names: ReadonlyMap<string, string>): Expr {
  if (names.size === 0) return expr
  const op = (o: Operand): Operand =>
    typeof o === 'string' && o.startsWith('param.') ? `param.${names.get(o.slice(6)) ?? o.slice(6)}` : o
  const doc = (d: string) =>
    d.replace(/\{param\.([A-Za-z0-9_]+)\}/g, (_, n: string) => `{param.${names.get(n) ?? n}}`)
  return mapAtoms(expr, a => {
    switch (a.op) {
      case 'authenticated': return a
      case 'exists': return { op: 'exists', doc: doc(a.doc) }
      case 'isNull': return { op: 'isNull', operand: op(a.operand) }
      default: return { op: a.op, left: op(a.left), right: op(a.right) }
    }
  })
}

export function collectRefs(expr: Expr): string[] {
  if ('ref' in expr) return [expr.ref]
  if ('and' in expr) return expr.and.flatMap(collectRefs)
  if ('or' in expr) return expr.or.flatMap(collectRefs)
  if ('not' in expr) return collectRefs(expr.not)
  return []
}

export function mentionsOperand(expr: Expr, operand: string): boolean {
  return atoms(expr).some(a => {
    switch (a.op) {
      case 'authenticated': return false
      case 'exists': return a.doc.includes(`{${operand}}`)
      case 'isNull': return a.operand === operand
      default: return a.left === operand || a.right === operand
    }
  })
}

export function flattenAnd(expr: Expr): Expr[] {
  return 'and' in expr ? expr.and.flatMap(flattenAnd) : [expr]
}
```

Note: the `prove(e, e)` property in the test uses generated expressions without `opaque` or `not`, so it holds.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/test/logic.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): add conservative implication logic over predicate expressions"
```

---

### Task 4: Path patterns and the fact graph schema

**Files:**
- Create: `packages/core/src/paths.ts`, `packages/core/src/facts.ts`
- Test: `packages/core/test/paths.test.ts`, `packages/core/test/facts.test.ts`

**Interfaces:**
- Consumes: `ExprSchema` (Task 2)
- Produces:
  - `parsePattern(path: string): Segment[]`, `patternsOverlap(a: string, b: string): boolean`, `alignParams(from: string, to: string): Map<string, string>`, `concretize(path: string, value: (param: string) => string): string`, `routeMatches(selector: string, route: { id: string; method: string; path: string }): boolean`, `normalizeTable(name: string): string`
  - `OPS`, `OpSchema`, `type Op`, `DataStoreSchema`, `type DataStore`, `LocationSchema`, `type Location`, `SymbolFactSchema`, `RouteSchema`, `GuardSchema`, `DataOpSchema`, `TableSchema`, `CollectionSchema`, `PolicySchema`, `DiagnosticSchema`, `FactsSchema`
  - Types `SymbolFact`, `Route`, `Guard`, `DataOp`, `Table`, `Collection`, `Policy`, `Diagnostic`, `Facts` (parsed output), `FactsInput` (input with defaults optional)
  - `class FactsError extends Error`, `parseFacts(json: unknown, source?: string): Facts`, `emptyFacts(): Facts`, `mergeFacts(parts: Facts[]): Facts`

- [ ] **Step 1: Write the failing tests**

`packages/core/test/paths.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { alignParams, concretize, normalizeTable, patternsOverlap, routeMatches } from '../src/paths.js'

describe('patternsOverlap', () => {
  it('matches params against anything and literals exactly', () => {
    expect(patternsOverlap('/accounts/{a}/dogs/{d}', '/accounts/{accountId}/dogs/{dogId}')).toBe(true)
    expect(patternsOverlap('/accounts/{a}/dogs/{d}', '/accounts/{a}/teams/{t}')).toBe(false)
    expect(patternsOverlap('/accounts/{a}/dogs/special', '/accounts/{a}/dogs/{d}')).toBe(true)
    expect(patternsOverlap('/accounts/{a}', '/accounts/{a}/dogs/{d}')).toBe(false)
  })
  it('treats {x=**} as zero or more segments', () => {
    expect(patternsOverlap('/{document=**}', '/accounts/{a}/dogs/{d}')).toBe(true)
    expect(patternsOverlap('/accounts/{a}/{rest=**}', '/accounts/{a}')).toBe(true)
    expect(patternsOverlap('/teams/{rest=**}', '/accounts/{a}')).toBe(false)
  })
})

describe('alignParams and concretize', () => {
  it('maps param names by position', () => {
    expect([...alignParams('/accounts/{acct}/dogs/{id}', '/accounts/{accountId}/dogs/{dogId}')])
      .toEqual([['acct', 'accountId'], ['id', 'dogId']])
  })
  it('fills params', () => {
    expect(concretize('/accounts/{accountId}/files/{path=**}', p => `${p}-1`)).toBe('/accounts/accountId-1/files/path-1')
  })
})

describe('routeMatches', () => {
  const route = (method: string, path: string) => ({ id: `route:${method} ${path}`, method, path })
  it('matches method and globbed path', () => {
    expect(routeMatches('POST /dogs/*/transfer', route('POST', '/dogs/:id/transfer'))).toBe(true)
    expect(routeMatches('GET /dogs/*/transfer', route('POST', '/dogs/:id/transfer'))).toBe(false)
    expect(routeMatches('* /dogs/**', route('GET', '/dogs'))).toBe(true)
    expect(routeMatches('* /dogs/**', route('DELETE', '/dogs/{id}'))).toBe(true)
    expect(routeMatches('* /dogs/**', route('GET', '/teams'))).toBe(false)
    expect(routeMatches('POST /dogs', route('POST', '/dogs/:id'))).toBe(false)
  })
  it('matches exact route ids', () => {
    expect(routeMatches('route:GET /teams', route('GET', '/teams'))).toBe(true)
  })
  it('throws on a malformed selector', () => {
    expect(() => routeMatches('dogs', route('GET', '/dogs'))).toThrow(/route selector/)
  })
})

describe('normalizeTable', () => {
  it('defaults the schema to public', () => {
    expect(normalizeTable('dogs')).toBe('public.dogs')
    expect(normalizeTable('audit.events')).toBe('audit.events')
  })
})
```

`packages/core/test/facts.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { FactsError, emptyFacts, mergeFacts, parseFacts } from '../src/facts.js'

describe('parseFacts', () => {
  it('fills defaults for missing arrays', () => {
    const f = parseFacts({ version: 1 })
    expect(f).toEqual(emptyFacts())
  })
  it('parses a full fact graph', () => {
    const f = parseFacts({
      version: 1,
      analyzers: [{ name: 'test', version: '0' }],
      symbols: [{ id: 'ts:src/a#f', kind: 'function', lang: 'ts', location: { file: 'src/a.ts', line: 3 } }],
      routes: [{ id: 'route:GET /a', method: 'GET', path: '/a', handler: 'ts:src/a#f', framework: 'express' }],
      guards: [{ at: 'route:GET /a', requires: { atom: { op: 'authenticated' } } }],
      dataOps: [{ in: 'ts:src/a#f', store: 'postgres', target: 'public.a', op: 'read' }],
      calls: [['ts:src/a#f', 'ts:src/b#g']],
      tables: [{ id: 'pg:public.a', name: 'public.a', columns: [{ name: 'id', type: 'uuid', nullable: false }] }],
      collections: [{ path: '/a/{id}', source: 'inferred' }],
      policies: [{ id: 'firestore:/a/{id}#read', store: 'firestore', target: '/a/{id}', ops: ['read'], condition: { or: [] } }],
      diagnostics: [{ analyzer: 'test', file: 'src/c.ts', message: 'parse error', severity: 'error' }],
    })
    expect(f.routes[0]!.middleware).toEqual([])
    expect(f.routes[0]!.kind).toBe('http')
    expect(f.tables[0]!.rlsEnabled).toBe(false)
  })
  it('throws FactsError with the source and the problem', () => {
    expect(() => parseFacts({ version: 2 }, 'facts.json')).toThrow(FactsError)
    expect(() => parseFacts({ version: 1, dataOps: [{ in: 'x', store: 'mongo', target: 't', op: 'read' }] }, 'facts.json'))
      .toThrow(/facts\.json/)
  })
})

describe('mergeFacts', () => {
  it('concatenates every list', () => {
    const a = parseFacts({ version: 1, analyzers: [{ name: 'a', version: '1' }], calls: [['x', 'y']] })
    const b = parseFacts({ version: 1, analyzers: [{ name: 'b', version: '1' }], calls: [['y', 'z']] })
    const m = mergeFacts([a, b])
    expect(m.analyzers.map(x => x.name)).toEqual(['a', 'b'])
    expect(m.calls).toEqual([['x', 'y'], ['y', 'z']])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/core/test/paths.test.ts packages/core/test/facts.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement `paths.ts`**

```ts
export type Segment =
  | { kind: 'literal'; value: string }
  | { kind: 'param'; name: string }
  | { kind: 'rest'; name: string }

export function parsePattern(path: string): Segment[] {
  return path.split('/').filter(Boolean).map((s): Segment => {
    const m = /^\{([A-Za-z0-9_.]+)(=\*\*)?\}$/.exec(s)
    if (!m) return { kind: 'literal', value: s }
    return m[2] ? { kind: 'rest', name: m[1]! } : { kind: 'param', name: m[1]! }
  })
}

export function patternsOverlap(a: string, b: string): boolean {
  const sa = parsePattern(a)
  const sb = parsePattern(b)
  const go = (i: number, j: number): boolean => {
    if (sa[i]?.kind === 'rest' || sb[j]?.kind === 'rest') return true
    if (i === sa.length || j === sb.length) return i === sa.length && j === sb.length
    const x = sa[i]!
    const y = sb[j]!
    if (x.kind === 'literal' && y.kind === 'literal' && x.value !== y.value) return false
    return go(i + 1, j + 1)
  }
  return go(0, 0)
}

export function alignParams(from: string, to: string): Map<string, string> {
  const a = parsePattern(from)
  const b = parsePattern(to)
  const map = new Map<string, string>()
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i]!
    const y = b[i]!
    if (x.kind === 'rest' || y.kind === 'rest') break
    if (x.kind === 'param' && y.kind === 'param') map.set(x.name, y.name)
  }
  return map
}

export function concretize(path: string, value: (param: string) => string): string {
  return '/' + parsePattern(path).map(s => (s.kind === 'literal' ? s.value : value(s.name))).join('/')
}

export function routeMatches(selector: string, route: { id: string; method: string; path: string }): boolean {
  if (selector.startsWith('route:')) return selector === route.id
  const m = /^(\S+)\s+(\/\S*)$/.exec(selector.trim())
  if (!m) throw new Error(`invalid route selector "${selector}": expected "METHOD /path" or "route:METHOD /path"`)
  const method = m[1]!
  if (method !== '*' && method.toUpperCase() !== route.method.toUpperCase()) return false
  return globMatch(m[2]!.split('/').filter(Boolean), route.path.split('/').filter(Boolean))
}

function globMatch(glob: string[], segs: string[]): boolean {
  if (glob.length === 0) return segs.length === 0
  const [head, ...rest] = glob
  if (head === '**') return segs.some((_, i) => globMatch(rest, segs.slice(i))) || globMatch(rest, [])
  if (segs.length === 0) return false
  return (head === '*' || head === segs[0]) && globMatch(rest, segs.slice(1))
}

export function normalizeTable(name: string): string {
  return name.includes('.') ? name : `public.${name}`
}
```

- [ ] **Step 4: Implement `facts.ts`**

```ts
import { z } from 'zod'
import { ExprSchema } from './expr.js'

export const OPS = ['read', 'list', 'create', 'update', 'delete'] as const
export const OpSchema = z.enum(OPS)
export type Op = z.infer<typeof OpSchema>

export const DataStoreSchema = z.enum(['postgres', 'firestore', 'storage'])
export type DataStore = z.infer<typeof DataStoreSchema>

export const LocationSchema = z.strictObject({
  file: z.string(),
  line: z.number().int().positive(),
  endLine: z.number().int().positive().optional(),
})
export type Location = z.infer<typeof LocationSchema>

export const SymbolFactSchema = z.strictObject({
  id: z.string().min(1),
  kind: z.enum(['function', 'method', 'class', 'route', 'middleware', 'table', 'column', 'policy', 'match', 'collection']),
  lang: z.enum(['ts', 'go', 'py', 'sql', 'firestore', 'storage']),
  location: LocationSchema.optional(),
  hash: z.string().optional(),
})

export const RouteSchema = z.strictObject({
  id: z.string().min(1),
  method: z.string().min(1),
  path: z.string().startsWith('/'),
  handler: z.string().min(1),
  middleware: z.array(z.string()).default([]),
  framework: z.string().min(1),
  kind: z.enum(['http', 'callable', 'trigger']).default('http'),
})

export const GuardSchema = z.strictObject({
  at: z.string().min(1),
  requires: ExprSchema,
  evidence: LocationSchema.optional(),
})

export const DataOpSchema = z.strictObject({
  in: z.string().min(1),
  store: DataStoreSchema,
  target: z.string().min(1),
  op: OpSchema,
  filters: ExprSchema.optional(),
  evidence: LocationSchema.optional(),
})

export const TableSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  columns: z.array(z.strictObject({
    name: z.string(), type: z.string(), nullable: z.boolean(), default: z.string().optional(),
  })),
  primaryKey: z.array(z.string()).default([]),
  foreignKeys: z.array(z.strictObject({
    columns: z.array(z.string()).min(1),
    references: z.strictObject({ table: z.string(), columns: z.array(z.string()).min(1) }),
  })).default([]),
  uniques: z.array(z.array(z.string()).min(1)).default([]),
  checks: z.array(z.strictObject({ name: z.string().optional(), expr: z.string() })).default([]),
  enums: z.array(z.strictObject({ column: z.string(), values: z.array(z.string()) })).default([]),
  rlsEnabled: z.boolean().default(false),
  location: LocationSchema.optional(),
})

export const CollectionSchema = z.strictObject({
  path: z.string().startsWith('/'),
  fields: z.array(z.string()).default([]),
  source: z.enum(['converter', 'inferred']),
})

export const PolicySchema = z.strictObject({
  id: z.string().min(1),
  store: z.enum(['pg-rls', 'firestore', 'storage']),
  target: z.string().min(1),
  ops: z.array(OpSchema).min(1),
  condition: ExprSchema,
  functions: z.array(z.string()).default([]),
  evidence: LocationSchema.optional(),
})

export const DiagnosticSchema = z.strictObject({
  analyzer: z.string(),
  file: z.string(),
  message: z.string(),
  severity: z.enum(['error', 'warning']),
})

export const FactsSchema = z.strictObject({
  version: z.literal(1),
  analyzers: z.array(z.strictObject({ name: z.string(), version: z.string() })).default([]),
  symbols: z.array(SymbolFactSchema).default([]),
  routes: z.array(RouteSchema).default([]),
  guards: z.array(GuardSchema).default([]),
  dataOps: z.array(DataOpSchema).default([]),
  calls: z.array(z.tuple([z.string(), z.string()])).default([]),
  tables: z.array(TableSchema).default([]),
  collections: z.array(CollectionSchema).default([]),
  policies: z.array(PolicySchema).default([]),
  diagnostics: z.array(DiagnosticSchema).default([]),
})

export type SymbolFact = z.output<typeof SymbolFactSchema>
export type Route = z.output<typeof RouteSchema>
export type Guard = z.output<typeof GuardSchema>
export type DataOp = z.output<typeof DataOpSchema>
export type Table = z.output<typeof TableSchema>
export type Collection = z.output<typeof CollectionSchema>
export type Policy = z.output<typeof PolicySchema>
export type Diagnostic = z.output<typeof DiagnosticSchema>
export type Facts = z.output<typeof FactsSchema>
export type FactsInput = z.input<typeof FactsSchema>

export class FactsError extends Error {}

export function parseFacts(json: unknown, source = 'facts'): Facts {
  const parsed = FactsSchema.safeParse(json)
  if (!parsed.success) throw new FactsError(`${source}: ${z.prettifyError(parsed.error)}`)
  return parsed.data
}

export function emptyFacts(): Facts {
  return FactsSchema.parse({ version: 1 })
}

const LIST_KEYS = ['analyzers', 'symbols', 'routes', 'guards', 'dataOps', 'calls', 'tables', 'collections', 'policies', 'diagnostics'] as const

export function mergeFacts(parts: Facts[]): Facts {
  const out = emptyFacts()
  for (const part of parts) {
    for (const key of LIST_KEYS) (out[key] as unknown[]).push(...part[key])
  }
  return out
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/test/paths.test.ts packages/core/test/facts.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core
git commit -m "feat(core): add fact graph schema and path pattern helpers"
```

---

### Task 5: Rule model, YAML and hashing

**Files:**
- Create: `packages/core/src/rules.ts`, `packages/core/src/hash.ts`
- Test: `packages/core/test/rules.test.ts`

**Interfaces:**
- Consumes: `ExprSchema`, `Expr` (Task 2), `OpSchema` (Task 4), `canonicalJson`, `sha256Hex` (Task 2), `collectRefs` (Task 3)
- Produces:
  - Schemas: `VocabularyEntrySchema`, `RouteTargetSchema`, `SymbolTargetSchema`, `DocTargetSchema`, `TableTargetSchema`, `DataTargetSchema`, `AccessRuleSchema`, `DataAccessRuleSchema`, `VisibilityRuleSchema`, `FlowRuleSchema`, `InvariantRuleSchema`, `RuleSchema`, `ProposedRuleSchema`, `RulesFileSchema`
  - Types: `VocabularyEntry`, `DataTarget`, `Rule`, `RuleType`, `AccessRule`, `DataAccessRule`, `VisibilityRule`, `FlowRule`, `InvariantRule`, `ProposedRule`, `RulesFile`, `Enforce`
  - `class RulesFileError extends Error`, `parseRulesFile(text: string, source?: string): RulesFile`, `serializeRulesFile(file: RulesFile): string`, `emptyRulesFile(): RulesFile`
  - `validateRuleSemantics(rule: Rule | ProposedRule): string[]`
  - `DEFAULT_ENFORCE: Record<RuleType, Enforce[]>`, `effectiveEnforce(rule: Rule): Enforce[]`
  - `vocabularyMap(file: RulesFile, extra?: VocabularyEntry[]): Map<string, Expr>`
  - `nextRuleId(file: RulesFile): string`
  - `hashRule(rule: Rule): string` (12 hex chars over every field except `id`, `status`, `approved`, `muted`, `evidence`)

- [ ] **Step 1: Write the failing tests**

`packages/core/test/rules.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { hashRule } from '../src/hash.js'
import {
  RuleSchema, RulesFileError, emptyRulesFile, nextRuleId, parseRulesFile, serializeRulesFile,
  validateRuleSemantics, vocabularyMap, effectiveEnforce,
} from '../src/rules.js'

const yamlText = `
version: 1
vocabulary:
  - id: account-member
    text: Caller is a member of the record's account
    expr: { atom: { op: exists, doc: "/accounts/{param.accountId}/members/{actor.uid}" } }
    recognize:
      - firestore-function: isAccountMember
rules:
  - id: R-001
    text: Only account members can read the account's dogs
    type: data-access
    target: { store: firestore, path: "/accounts/{accountId}/dogs/{dogId}" }
    ops: [read, list]
    requires: { ref: account-member }
    evidence: ["firestore:/accounts/{accountId}/dogs/{dogId}"]
    status: approved
    approved: { by: almog, at: "2026-10-21", hash: abc }
  - id: R-002
    text: Every dog belongs to a team
    type: invariant
    target: { store: postgres, table: dogs }
    kind: not-null
    columns: [team_id]
    status: pending
`

describe('parseRulesFile', () => {
  it('parses vocabulary and rules', () => {
    const f = parseRulesFile(yamlText)
    expect(f.vocabulary[0]!.id).toBe('account-member')
    expect(f.rules.map(r => r.type)).toEqual(['data-access', 'invariant'])
  })
  it('treats an empty file as empty rules', () => {
    expect(parseRulesFile('')).toEqual(emptyRulesFile())
  })
  it('reports schema problems with the source name', () => {
    expect(() => parseRulesFile('version: 1\nrules: [{ id: X-1 }]', 'holdline.rules')).toThrow(/holdline\.rules/)
    expect(() => parseRulesFile('version: 1\nrules: [{ id: X-1 }]')).toThrow(RulesFileError)
  })
  it('reports invalid YAML', () => {
    expect(() => parseRulesFile('rules: [')).toThrow(/invalid YAML/)
  })
  it('rejects duplicate ids', () => {
    const dup = yamlText.replace('id: R-002', 'id: R-001')
    expect(() => parseRulesFile(dup)).toThrow(/duplicate rule id R-001/)
  })
  it('rejects invariants missing their kind-specific fields', () => {
    const bad = yamlText.replace('kind: not-null', 'kind: fk')
    expect(() => parseRulesFile(bad)).toThrow(/R-002: fk needs references/)
  })
})

describe('serializeRulesFile', () => {
  it('round-trips', () => {
    const f = parseRulesFile(yamlText)
    expect(parseRulesFile(serializeRulesFile(f))).toEqual(f)
  })
  it('writes id and text before other fields', () => {
    const out = serializeRulesFile(parseRulesFile(yamlText))
    expect(out.indexOf('id: R-001')).toBeLessThan(out.indexOf('text: Only account members'))
    expect(out.indexOf('text: Only account members')).toBeLessThan(out.indexOf('type: data-access'))
  })
})

describe('hashRule', () => {
  const rule = parseRulesFile(yamlText).rules[0]!
  it('ignores id, status, approval, mute and evidence', () => {
    const same = RuleSchema.parse({ ...rule, id: 'R-999', status: 'pending', approved: undefined, evidence: [] })
    expect(hashRule(same)).toBe(hashRule(rule))
    expect(hashRule(rule)).toMatch(/^[0-9a-f]{12}$/)
  })
  it('changes when the text or the requirement changes', () => {
    expect(hashRule(RuleSchema.parse({ ...rule, text: 'Anyone can read dogs' }))).not.toBe(hashRule(rule))
    expect(hashRule(RuleSchema.parse({ ...rule, ops: ['read'] }))).not.toBe(hashRule(rule))
  })
})

describe('helpers', () => {
  it('validateRuleSemantics checks invariant fields', () => {
    const r = RuleSchema.parse({ id: 'R-001', text: 't', type: 'invariant', target: { store: 'postgres', table: 'x' }, kind: 'enum', columns: ['c'], status: 'pending' })
    expect(validateRuleSemantics(r)).toEqual(['enum needs values'])
  })
  it('effectiveEnforce uses per-type defaults', () => {
    const f = parseRulesFile(yamlText)
    expect(effectiveEnforce(f.rules[0]!)).toEqual(['static', 'test'])
  })
  it('vocabularyMap and nextRuleId', () => {
    const f = parseRulesFile(yamlText)
    expect(vocabularyMap(f).has('account-member')).toBe(true)
    expect(nextRuleId(f)).toBe('R-003')
    expect(nextRuleId(emptyRulesFile())).toBe('R-001')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/core/test/rules.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement `rules.ts`**

```ts
import YAML from 'yaml'
import { z } from 'zod'
import { ExprSchema, type Expr } from './expr.js'
import { OpSchema } from './facts.js'

const RuleIdSchema = z.string().regex(/^R-\d{3,}$/, 'rule ids look like R-001')
const SlugSchema = z.string().regex(/^[a-z][a-z0-9-]*$/, 'vocabulary ids are lowercase slugs')

export const RecognizerSchema = z.union([
  z.strictObject({ 'firestore-function': z.string().min(1) }),
  z.strictObject({ symbol: z.string().min(1) }),
])

export const VocabularyEntrySchema = z.strictObject({
  id: SlugSchema,
  text: z.string().min(1),
  expr: ExprSchema,
  recognize: z.array(RecognizerSchema).default([]),
})
export type VocabularyEntry = z.output<typeof VocabularyEntrySchema>

export const RouteTargetSchema = z.strictObject({ routes: z.string().min(1) })
export const SymbolTargetSchema = z.strictObject({ symbol: z.string().min(1) })
export const DocTargetSchema = z.strictObject({ store: z.enum(['firestore', 'storage']), path: z.string().startsWith('/') })
export const TableTargetSchema = z.strictObject({ store: z.literal('postgres'), table: z.string().min(1) })
export const DataTargetSchema = z.union([DocTargetSchema, TableTargetSchema])
export type DataTarget = z.output<typeof DataTargetSchema>

export const ENFORCE = ['static', 'test', 'audit'] as const
export type Enforce = (typeof ENFORCE)[number]

const head = { id: RuleIdSchema, text: z.string().min(1) }
const tail = {
  evidence: z.array(z.string()).default([]),
  enforce: z.array(z.enum(ENFORCE)).optional(),
  status: z.enum(['pending', 'approved', 'muted']),
  approved: z.strictObject({ by: z.string(), at: z.string(), hash: z.string() }).optional(),
  muted: z.strictObject({ by: z.string(), at: z.string(), reason: z.string().min(1) }).optional(),
}

export const AccessRuleSchema = z.strictObject({
  ...head,
  type: z.literal('access'),
  target: z.union([RouteTargetSchema, SymbolTargetSchema]),
  requires: ExprSchema,
  ...tail,
})

export const DataAccessRuleSchema = z.strictObject({
  ...head,
  type: z.literal('data-access'),
  target: DataTargetSchema,
  ops: z.array(OpSchema).min(1),
  requires: ExprSchema,
  ...tail,
})

export const VisibilityRuleSchema = z.strictObject({
  ...head,
  type: z.literal('visibility'),
  target: DataTargetSchema,
  requires: ExprSchema,
  via: z.array(z.string()).default([]),
  ...tail,
})

export const FlowRuleSchema = z.strictObject({
  ...head,
  type: z.literal('flow'),
  target: DataTargetSchema,
  ops: z.array(OpSchema).min(1),
  via: z.array(z.string()).min(1),
  ...tail,
})

export const InvariantRuleSchema = z.strictObject({
  ...head,
  type: z.literal('invariant'),
  target: DataTargetSchema,
  kind: z.enum(['not-null', 'fk', 'unique', 'check', 'enum']),
  columns: z.array(z.string()).min(1),
  references: z.strictObject({ table: z.string().min(1), columns: z.array(z.string()).min(1) }).optional(),
  values: z.array(z.string()).min(1).optional(),
  expr: z.string().min(1).optional(),
  ...tail,
})

export const RuleSchema = z.discriminatedUnion('type', [
  AccessRuleSchema, DataAccessRuleSchema, VisibilityRuleSchema, FlowRuleSchema, InvariantRuleSchema,
])

const META = { id: true, status: true, approved: true, muted: true } as const
export const ProposedRuleSchema = z.discriminatedUnion('type', [
  AccessRuleSchema.omit(META), DataAccessRuleSchema.omit(META), VisibilityRuleSchema.omit(META),
  FlowRuleSchema.omit(META), InvariantRuleSchema.omit(META),
])

export type Rule = z.output<typeof RuleSchema>
export type RuleType = Rule['type']
export type AccessRule = z.output<typeof AccessRuleSchema>
export type DataAccessRule = z.output<typeof DataAccessRuleSchema>
export type VisibilityRule = z.output<typeof VisibilityRuleSchema>
export type FlowRule = z.output<typeof FlowRuleSchema>
export type InvariantRule = z.output<typeof InvariantRuleSchema>
export type ProposedRule = z.output<typeof ProposedRuleSchema>

export const RulesFileSchema = z.strictObject({
  version: z.literal(1),
  vocabulary: z.array(VocabularyEntrySchema).default([]),
  rules: z.array(RuleSchema).default([]),
})
export type RulesFile = z.output<typeof RulesFileSchema>

export class RulesFileError extends Error {}

export function validateRuleSemantics(rule: Rule | ProposedRule): string[] {
  if (rule.type !== 'invariant') return []
  const problems: string[] = []
  if (rule.kind === 'fk' && !rule.references) problems.push('fk needs references')
  if (rule.kind === 'enum' && !rule.values) problems.push('enum needs values')
  if (rule.kind === 'fk' && rule.target.store !== 'postgres') problems.push('fk applies to postgres tables only')
  return problems
}

export function parseRulesFile(text: string, source = 'holdline.rules'): RulesFile {
  let raw: unknown
  try {
    raw = YAML.parse(text)
  } catch (e) {
    throw new RulesFileError(`${source}: invalid YAML: ${(e as Error).message}`)
  }
  const parsed = RulesFileSchema.safeParse(raw ?? { version: 1 })
  if (!parsed.success) throw new RulesFileError(`${source}: ${z.prettifyError(parsed.error)}`)
  const seen = new Set<string>()
  const problems: string[] = []
  for (const rule of parsed.data.rules) {
    if (seen.has(rule.id)) problems.push(`duplicate rule id ${rule.id}`)
    seen.add(rule.id)
    problems.push(...validateRuleSemantics(rule).map(p => `${rule.id}: ${p}`))
  }
  if (problems.length > 0) throw new RulesFileError(`${source}: ${problems.join('; ')}`)
  return parsed.data
}

export function serializeRulesFile(file: RulesFile): string {
  return YAML.stringify(file, { lineWidth: 0 })
}

export function emptyRulesFile(): RulesFile {
  return { version: 1, vocabulary: [], rules: [] }
}

export const DEFAULT_ENFORCE: Record<RuleType, Enforce[]> = {
  access: ['static'],
  'data-access': ['static', 'test'],
  visibility: ['static'],
  flow: ['static'],
  invariant: ['static', 'test'],
}

export function effectiveEnforce(rule: Rule): Enforce[] {
  return rule.enforce ?? DEFAULT_ENFORCE[rule.type]
}

export function vocabularyMap(file: RulesFile, extra: VocabularyEntry[] = []): Map<string, Expr> {
  return new Map([...file.vocabulary, ...extra].map(v => [v.id, v.expr]))
}

export function nextRuleId(file: RulesFile): string {
  const max = file.rules.reduce((m, r) => Math.max(m, Number(r.id.slice(2))), 0)
  return `R-${String(max + 1).padStart(3, '0')}`
}
```

- [ ] **Step 4: Implement `hash.ts`**

```ts
import { canonicalJson, sha256Hex } from './canonical.js'
import type { Rule } from './rules.js'

const UNHASHED = new Set(['id', 'status', 'approved', 'muted', 'evidence'])

// Hash parsed rules only (RuleSchema output), so defaults such as `via: []` are always present.
export function hashRule(rule: Rule): string {
  const fields = Object.fromEntries(Object.entries(rule).filter(([k]) => !UNHASHED.has(k)))
  return sha256Hex(canonicalJson(fields)).slice(0, 12)
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/test/rules.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core
git commit -m "feat(core): add rule model, holdline.rules YAML IO and rule hashing"
```

---

### Task 6: FactIndex

**Files:**
- Create: `packages/core/src/fact-index.ts`
- Test: `packages/core/test/fact-index.test.ts`

**Interfaces:**
- Consumes: `Facts`, `Route`, `Guard`, `DataOp`, `Policy`, `Table`, `Op` (Task 4), `DataTarget` (Task 5), `patternsOverlap`, `routeMatches`, `normalizeTable` (Task 4)
- Produces: `class FactIndex` with
  - `constructor(facts: Facts)`, `readonly facts: Facts`
  - `hasId(id: string): boolean` (symbols, routes, tables, policies)
  - `at(id: string): { symbol: string; file?: string; line?: number }`
  - `routesMatching(selector: string): Route[]`
  - `guardsAt(id: string): Guard[]`, `guardChain(route: Route): Guard[]`
  - `dataOps(target: DataTarget, ops?: readonly Op[]): DataOp[]`
  - `policies(target: DataTarget, op: Op): Policy[]`
  - `table(name: string): Table | undefined`
  - `targetExists(target: DataTarget): boolean`
  - `coveredBy(symbol: string, via: readonly string[]): boolean`
  - `fileOf(id: string): string | undefined`
  - `errorFiles(): Set<string>`

- [ ] **Step 1: Write the failing tests**

`packages/core/test/fact-index.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { FactIndex } from '../src/fact-index.js'
import { parseFacts } from '../src/facts.js'

const facts = parseFacts({
  version: 1,
  symbols: [
    { id: 'ts:src/routes#transfer', kind: 'function', lang: 'ts', location: { file: 'src/routes.ts', line: 10 } },
    { id: 'ts:src/repo#DogRepo.update', kind: 'method', lang: 'ts', location: { file: 'src/repo.ts', line: 5 } },
  ],
  routes: [
    { id: 'route:POST /dogs/:id/transfer', method: 'POST', path: '/dogs/:id/transfer', handler: 'ts:src/routes#transfer', middleware: ['ts:src/mw#auth'], framework: 'express' },
    { id: 'route:GET /dogs', method: 'GET', path: '/dogs', handler: 'ts:src/routes#list', framework: 'express' },
  ],
  guards: [
    { at: 'ts:src/mw#auth', requires: { atom: { op: 'authenticated' } } },
    { at: 'route:POST /dogs/:id/transfer', requires: { atom: { op: 'in', left: 'actor.role', right: { literal: ['admin'] } } } },
  ],
  dataOps: [
    { in: 'ts:src/repo#DogRepo.update', store: 'postgres', target: 'dogs', op: 'update' },
    { in: 'ts:src/script#fix', store: 'postgres', target: 'public.dogs', op: 'update' },
    { in: 'ts:src/client#load', store: 'firestore', target: '/accounts/{a}/dogs/{d}', op: 'read' },
  ],
  calls: [
    ['ts:src/routes#transfer', 'ts:src/service#Transfer.run'],
    ['ts:src/service#Transfer.run', 'ts:src/repo#DogRepo.update'],
    ['ts:src/other#handler', 'ts:src/repo#DogRepo.update'],
  ],
  tables: [{ id: 'pg:public.dogs', name: 'public.dogs', columns: [], location: { file: 'm.sql', line: 1 } }],
  policies: [
    { id: 'firestore:/{document=**}#read', store: 'firestore', target: '/{document=**}', ops: ['read'], condition: { or: [] } },
    { id: 'firestore:/accounts/{acct}/dogs/{id}#rw', store: 'firestore', target: '/accounts/{acct}/dogs/{id}', ops: ['read', 'update'], condition: { atom: { op: 'authenticated' } } },
  ],
  diagnostics: [{ analyzer: 'ts', file: 'src/broken.ts', message: 'x', severity: 'error' }],
})
const index = new FactIndex(facts)
const dogs = { store: 'postgres', table: 'dogs' } as const
const fsDogs = { store: 'firestore', path: '/accounts/{accountId}/dogs/{dogId}' } as const

describe('FactIndex', () => {
  it('finds ids and locations', () => {
    expect(index.hasId('route:GET /dogs')).toBe(true)
    expect(index.hasId('pg:public.dogs')).toBe(true)
    expect(index.hasId('nope')).toBe(false)
    expect(index.at('ts:src/routes#transfer')).toEqual({ symbol: 'ts:src/routes#transfer', file: 'src/routes.ts', line: 10 })
    expect(index.at('pg:public.dogs')).toEqual({ symbol: 'pg:public.dogs', file: 'm.sql', line: 1 })
    expect(index.at('unknown')).toEqual({ symbol: 'unknown' })
  })
  it('builds guard chains from the route, its middleware and its handler', () => {
    const [route] = index.routesMatching('POST /dogs/*/transfer')
    expect(index.guardChain(route!).map(g => g.at)).toEqual(['route:POST /dogs/:id/transfer', 'ts:src/mw#auth'])
  })
  it('finds data ops by target with schema normalization and path overlap', () => {
    expect(index.dataOps(dogs).length).toBe(2)
    expect(index.dataOps(dogs, ['read']).length).toBe(0)
    expect(index.dataOps(fsDogs).map(o => o.in)).toEqual(['ts:src/client#load'])
  })
  it('finds policies covering a target and op', () => {
    expect(index.policies(fsDogs, 'read').map(p => p.id)).toEqual(['firestore:/{document=**}#read', 'firestore:/accounts/{acct}/dogs/{id}#rw'])
    expect(index.policies(fsDogs, 'delete')).toEqual([])
  })
  it('knows whether a target exists', () => {
    expect(index.targetExists(dogs)).toBe(true)
    expect(index.targetExists({ store: 'postgres', table: 'cats' })).toBe(false)
    expect(index.targetExists(fsDogs)).toBe(true)
  })
  it('coveredBy requires every call path to pass through via', () => {
    expect(index.coveredBy('ts:src/repo#DogRepo.update', ['ts:src/repo#DogRepo'])).toBe(true)
    expect(index.coveredBy('ts:src/repo#DogRepo.update', ['ts:src/service#Transfer.run'])).toBe(false)
    expect(index.coveredBy('ts:src/script#fix', ['ts:src/service#Transfer.run'])).toBe(false)
  })
  it('lists files with error diagnostics', () => {
    expect([...index.errorFiles()]).toEqual(['src/broken.ts'])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/core/test/fact-index.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`packages/core/src/fact-index.ts`:
```ts
import type { DataOp, Facts, Guard, Location, Op, Policy, Route, Table } from './facts.js'
import { normalizeTable, patternsOverlap, routeMatches } from './paths.js'
import type { DataTarget } from './rules.js'

const POLICY_STORE = { postgres: 'pg-rls', firestore: 'firestore', storage: 'storage' } as const

export class FactIndex {
  private readonly locations = new Map<string, Location | undefined>()
  private readonly callersOf = new Map<string, string[]>()

  constructor(readonly facts: Facts) {
    for (const s of facts.symbols) this.locations.set(s.id, s.location)
    for (const r of facts.routes) if (!this.locations.has(r.id)) this.locations.set(r.id, undefined)
    for (const t of facts.tables) this.locations.set(t.id, t.location)
    for (const p of facts.policies) this.locations.set(p.id, p.evidence)
    for (const [from, to] of facts.calls) this.callersOf.set(to, [...(this.callersOf.get(to) ?? []), from])
  }

  hasId(id: string): boolean {
    return this.locations.has(id)
  }

  at(id: string): { symbol: string; file?: string; line?: number } {
    const loc = this.locations.get(id)
    return loc ? { symbol: id, file: loc.file, line: loc.line } : { symbol: id }
  }

  fileOf(id: string): string | undefined {
    return this.locations.get(id)?.file
  }

  routesMatching(selector: string): Route[] {
    return this.facts.routes.filter(r => routeMatches(selector, r))
  }

  guardsAt(id: string): Guard[] {
    return this.facts.guards.filter(g => g.at === id)
  }

  guardChain(route: Route): Guard[] {
    return [route.id, ...route.middleware, route.handler].flatMap(id => this.guardsAt(id))
  }

  dataOps(target: DataTarget, ops?: readonly Op[]): DataOp[] {
    return this.facts.dataOps.filter(o =>
      o.store === target.store && targetMatches(target, o.target) && (!ops || ops.includes(o.op)))
  }

  policies(target: DataTarget, op: Op): Policy[] {
    return this.facts.policies.filter(p =>
      p.store === POLICY_STORE[target.store] && targetMatches(target, p.target) && p.ops.includes(op))
  }

  table(name: string): Table | undefined {
    const wanted = normalizeTable(name)
    return this.facts.tables.find(t => normalizeTable(t.name) === wanted)
  }

  targetExists(target: DataTarget): boolean {
    if (target.store === 'postgres') return !!this.table(target.table) || this.dataOps(target).length > 0
    return this.dataOps(target).length > 0
      || this.facts.policies.some(p => p.store === target.store && patternsOverlap(p.target, target.path))
      || this.facts.collections.some(c => patternsOverlap(c.path, target.path))
  }

  // True when every call path that reaches `symbol` passes through a symbol in `via`.
  // A `via` entry also covers its members: `ts:x#Repo` covers `ts:x#Repo.update`.
  coveredBy(symbol: string, via: readonly string[], visiting: ReadonlySet<string> = new Set()): boolean {
    if (via.some(v => symbol === v || symbol.startsWith(`${v}.`))) return true
    if (visiting.has(symbol)) return false
    const callers = this.callersOf.get(symbol) ?? []
    if (callers.length === 0) return false
    const next = new Set([...visiting, symbol])
    return callers.every(c => this.coveredBy(c, via, next))
  }

  errorFiles(): Set<string> {
    return new Set(this.facts.diagnostics.filter(d => d.severity === 'error').map(d => d.file))
  }
}

function targetMatches(target: DataTarget, name: string): boolean {
  return target.store === 'postgres'
    ? normalizeTable(name) === normalizeTable(target.table)
    : patternsOverlap(name, target.path)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/test/fact-index.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): add FactIndex lookups over the fact graph"
```

---

### Task 7: Checkers and results

**Files:**
- Create: `packages/core/src/results.ts`, `packages/core/src/check/types.ts`, `packages/core/src/check/access.ts`, `packages/core/src/check/data-access.ts`, `packages/core/src/check/visibility.ts`, `packages/core/src/check/flow.ts`, `packages/core/src/check/invariant.ts`, `packages/core/src/check/run.ts`
- Test: `packages/core/test/check.test.ts`

**Interfaces:**
- Consumes: `FactIndex` (Task 6), `implies`, `renameParams`, `mentionsOperand`, `Vocabulary` (Task 3), `alignParams`, `normalizeTable` (Task 4), rule types, `vocabularyMap` (Task 5), `hashRule` (Task 5), `formatExpr` (Task 2)
- Produces:
  - `RESULT_STATUSES`, `type ResultStatus`, `type Result = { rule: string; status: ResultStatus; target: string; at?: { symbol: string; file?: string; line?: number }; message: string; unproven?: Expr; fix?: string }`
  - `type Summary = Record<ResultStatus, number> & { muted: number; rules: number }`, `summarize(results: Result[], muted: number): Summary`, `describeTarget(rule: Rule | ProposedRule): string`
  - `type CheckContext = { index: FactIndex; vocab: Vocabulary }`, `type Violation = { message: string; at?: Result['at']; unproven?: Expr; fix?: string }`, `type CheckOutcome = { stale: string } | { violations: Violation[] }`
  - `evaluateRule(rule: Rule | ProposedRule, ctx: CheckContext): CheckOutcome`
  - `checkRule(rule: Rule, ctx: CheckContext): Result[]`
  - `runChecks(facts: Facts, file: RulesFile, opts?: { only?: string[] }): { results: Result[]; muted: number }`

- [ ] **Step 1: Write the failing tests**

`packages/core/test/check.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { runChecks } from '../src/check/run.js'
import { parseFacts, type FactsInput } from '../src/facts.js'
import { hashRule } from '../src/hash.js'
import { RuleSchema, type RulesFile } from '../src/rules.js'
import { summarize } from '../src/results.js'

const approvedRule = (raw: Record<string, unknown>) => {
  const rule = RuleSchema.parse({ status: 'approved', ...raw })
  return { ...rule, approved: { by: 't', at: '2026-10-21', hash: hashRule(rule) } }
}
const file = (rules: Record<string, unknown>[], vocabulary: RulesFile['vocabulary'] = []): RulesFile =>
  ({ version: 1, vocabulary, rules: rules.map(approvedRule) })
const run = (facts: Omit<FactsInput, 'version'>, f: RulesFile) => runChecks(parseFacts({ version: 1, ...facts }), f).results

const admin = { atom: { op: 'in', left: 'actor.role', right: { literal: ['admin'] } } }
const auth = { atom: { op: 'authenticated' } }
const member = { atom: { op: 'exists', doc: '/accounts/{param.accountId}/members/{actor.uid}' } }
const notDeleted = { atom: { op: 'isNull', operand: 'resource.deleted_at' } }

describe('access', () => {
  const facts = {
    routes: [
      { id: 'route:POST /dogs/:id/transfer', method: 'POST', path: '/dogs/:id/transfer', handler: 'h:transfer', middleware: ['mw:auth'], framework: 'express' },
      { id: 'route:POST /dogs/:id/archive', method: 'POST', path: '/dogs/:id/archive', handler: 'h:archive', middleware: ['mw:auth'], framework: 'express' },
    ],
    guards: [
      { at: 'mw:auth', requires: auth },
      { at: 'route:POST /dogs/:id/transfer', requires: admin },
    ],
    symbols: [{ id: 'h:archive', kind: 'function' as const, lang: 'ts' as const, location: { file: 'src/dogs.ts', line: 30 } }],
  }
  it('passes when every matching route checks the requirement', () => {
    const r = run(facts, file([{ id: 'R-001', text: 'Only admins transfer', type: 'access', target: { routes: 'POST /dogs/*/transfer' }, requires: admin }]))
    expect(r).toEqual([{ rule: 'R-001', status: 'pass', target: 'routes POST /dogs/*/transfer', message: 'Only admins transfer' }])
  })
  it('reports each route that does not', () => {
    const r = run(facts, file([{ id: 'R-001', text: 'Only admins change dogs', type: 'access', target: { routes: 'POST /dogs/**' }, requires: admin }]))
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({
      status: 'violation',
      message: 'POST /dogs/:id/archive does not check actor.role in ["admin"]',
      at: { symbol: 'h:archive', file: 'src/dogs.ts', line: 30 },
      unproven: admin,
    })
  })
  it('is stale when no route matches', () => {
    const r = run(facts, file([{ id: 'R-001', text: 't', type: 'access', target: { routes: 'GET /cats' }, requires: auth }]))
    expect(r[0]!.status).toBe('stale')
  })
  it('checks guards on a symbol target', () => {
    const r = run({ ...facts, guards: [...facts.guards, { at: 'fn:onCall', requires: auth }], symbols: [{ id: 'fn:onCall', kind: 'function', lang: 'ts' }] },
      file([{ id: 'R-001', text: 't', type: 'access', target: { symbol: 'fn:onCall' }, requires: admin }]))
    expect(r[0]!.status).toBe('violation')
  })
})

describe('data-access', () => {
  const target = { store: 'firestore', path: '/accounts/{accountId}/dogs/{dogId}' }
  const rule = { id: 'R-001', text: 'Members read dogs', type: 'data-access', target, ops: ['read', 'update'], requires: member }
  it('passes when every covering policy implies the requirement, after renaming params', () => {
    const r = run({ policies: [
      { id: 'p1', store: 'firestore', target: '/accounts/{acct}/dogs/{id}', ops: ['read', 'update'], condition: { atom: { op: 'exists', doc: '/accounts/{param.acct}/members/{actor.uid}' } } },
    ] }, file([rule]))
    expect(r.map(x => x.status)).toEqual(['pass'])
  })
  it('flags a loosened policy and points at it', () => {
    const r = run({ policies: [
      { id: 'p1', store: 'firestore', target: '/accounts/{acct}/dogs/{id}', ops: ['read', 'update'], condition: { atom: { op: 'exists', doc: '/accounts/{param.acct}/members/{actor.uid}' } } },
      { id: 'p2', store: 'firestore', target: '/{document=**}', ops: ['read'], condition: auth, evidence: { file: 'firestore.rules', line: 4 } },
    ] }, file([rule]))
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ status: 'violation', at: { symbol: 'p2', file: 'firestore.rules', line: 4 } })
    expect(r[0]!.message).toContain('read on firestore:/accounts/{accountId}/dogs/{dogId}')
  })
  it('requires RLS to be enabled on postgres tables', () => {
    const pgRule = { ...rule, target: { store: 'postgres', table: 'dogs' }, requires: { atom: { op: 'eq', left: 'actor.uid', right: 'resource.owner_id' } } }
    const table = { id: 'pg:public.dogs', name: 'public.dogs', columns: [] }
    expect(run({ tables: [table] }, file([pgRule]))[0]!.message).toMatch(/Row level security is not enabled/)
    expect(run({ tables: [{ ...table, rlsEnabled: true }] }, file([pgRule])).map(x => x.status)).toEqual(['pass'])
  })
})

describe('visibility and flow', () => {
  const dogs = { store: 'postgres', table: 'dogs' }
  const facts = {
    tables: [{ id: 'pg:public.dogs', name: 'public.dogs', columns: [] }],
    dataOps: [
      { in: 'repo:Dogs.list', store: 'postgres', target: 'public.dogs', op: 'list', filters: { and: [notDeleted] } },
      { in: 'repo:Dogs.get', store: 'postgres', target: 'public.dogs', op: 'read' },
      { in: 'repo:Dogs.update', store: 'postgres', target: 'public.dogs', op: 'update' },
      { in: 'script:fix', store: 'postgres', target: 'public.dogs', op: 'update', evidence: { file: 'scripts/fix.ts', line: 3 } },
    ],
    calls: [['svc:Transfer.run', 'repo:Dogs.update']] as [string, string][],
  }
  it('visibility flags reads without the filter unless they go through via', () => {
    const r = run(facts, file([{ id: 'R-001', text: 'No deleted dogs', type: 'visibility', target: dogs, requires: notDeleted }]))
    expect(r.map(x => x.at?.symbol)).toEqual(['repo:Dogs.get'])
    const r2 = run(facts, file([{ id: 'R-001', text: 'No deleted dogs', type: 'visibility', target: dogs, requires: notDeleted, via: ['repo:Dogs.get'] }]))
    expect(r2.map(x => x.status)).toEqual(['pass'])
  })
  it('flow flags writes that bypass via', () => {
    const r = run(facts, file([{ id: 'R-001', text: 'Dog updates go through the transfer service', type: 'flow', target: dogs, ops: ['update'], via: ['svc:Transfer'] }]))
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ status: 'violation', at: { symbol: 'script:fix', file: 'scripts/fix.ts', line: 3 } })
  })
})

describe('invariant', () => {
  const table = {
    id: 'pg:public.dogs', name: 'public.dogs',
    columns: [{ name: 'team_id', type: 'uuid', nullable: false }, { name: 'status', type: 'dog_status', nullable: true }],
    foreignKeys: [{ columns: ['team_id'], references: { table: 'teams', columns: ['id'] } }],
    uniques: [['name', 'team_id']],
    checks: [{ expr: '(weight > 0)' }],
    enums: [{ column: 'status', values: ['active', 'retired'] }],
  }
  const target = { store: 'postgres', table: 'dogs' }
  const inv = (extra: Record<string, unknown>) => ({ id: 'R-001', text: 't', type: 'invariant', target, ...extra })
  it('passes each kind when the schema has the constraint', () => {
    const rules = [
      inv({ id: 'R-001', kind: 'not-null', columns: ['team_id'] }),
      inv({ id: 'R-002', kind: 'fk', columns: ['team_id'], references: { table: 'public.teams', columns: ['id'] } }),
      inv({ id: 'R-003', kind: 'unique', columns: ['team_id', 'name'] }),
      inv({ id: 'R-004', kind: 'check', columns: ['weight'], expr: 'weight > 0' }),
      inv({ id: 'R-005', kind: 'enum', columns: ['status'], values: ['retired', 'active'] }),
    ]
    expect(run({ tables: [table] }, file(rules)).map(r => r.status)).toEqual(['pass', 'pass', 'pass', 'pass', 'pass'])
  })
  it('fails each kind when the constraint is missing', () => {
    const broken = { ...table, columns: [{ name: 'team_id', type: 'uuid', nullable: true }, table.columns[1]!], foreignKeys: [], uniques: [], checks: [], enums: [{ column: 'status', values: ['active'] }] }
    const rules = [
      inv({ id: 'R-001', kind: 'not-null', columns: ['team_id'] }),
      inv({ id: 'R-002', kind: 'fk', columns: ['team_id'], references: { table: 'teams', columns: ['id'] } }),
      inv({ id: 'R-003', kind: 'unique', columns: ['team_id', 'name'] }),
      inv({ id: 'R-004', kind: 'check', columns: ['weight'], expr: 'weight > 0' }),
      inv({ id: 'R-005', kind: 'enum', columns: ['status'], values: ['active', 'retired'] }),
    ]
    expect(run({ tables: [broken] }, file(rules)).map(r => r.status)).toEqual(['violation', 'violation', 'violation', 'violation', 'violation'])
  })
  it('firestore invariants require write policies to check the field', () => {
    const fsTarget = { store: 'firestore', path: '/dogs/{dogId}' }
    const ok = { id: 'p', store: 'firestore', target: '/dogs/{d}', ops: ['create', 'update'], condition: { atom: { op: 'ne', left: 'incoming.team_id', right: { literal: null } } } }
    const rule = inv({ kind: 'not-null', columns: ['team_id'], target: fsTarget })
    expect(run({ policies: [ok] }, file([rule]))[0]!.status).toBe('pass')
    expect(run({ policies: [{ ...ok, condition: auth }] }, file([rule]))[0]!.status).toBe('violation')
  })
})

describe('runChecks bookkeeping', () => {
  const facts = { routes: [{ id: 'route:GET /a', method: 'GET', path: '/a', handler: 'h', framework: 'x' }], guards: [{ at: 'h', requires: auth }] }
  const base = { id: 'R-001', text: 'Sign-in for /a', type: 'access', target: { routes: 'GET /a' }, requires: auth }
  it('reports unapproved edits', () => {
    const f = file([base])
    f.rules[0] = { ...f.rules[0]!, text: 'Edited by an agent' }
    expect(runChecks(parseFacts({ version: 1, ...facts }), f).results[0]!.status).toBe('unapproved-edit')
  })
  it('skips pending and muted rules and counts muted', () => {
    const f = file([base])
    f.rules.push(RuleSchema.parse({ ...base, id: 'R-002', status: 'pending' }))
    f.rules.push({ ...approvedRule({ ...base, id: 'R-003' }), status: 'muted' })
    const out = runChecks(parseFacts({ version: 1, ...facts }), f)
    expect(out.results.map(r => r.rule)).toEqual(['R-001'])
    expect(out.muted).toBe(1)
    expect(summarize(out.results, out.muted)).toMatchObject({ pass: 1, violation: 0, muted: 1, rules: 1 })
  })
  it('turns a violation into unknown when evidence sits in a file an analyzer could not read', () => {
    const f = file([{ ...base, requires: admin, evidence: ['h'] }])
    const out = runChecks(parseFacts({ version: 1, ...facts,
      symbols: [{ id: 'h', kind: 'function', lang: 'ts', location: { file: 'src/a.ts', line: 1 } }],
      diagnostics: [{ analyzer: 'ts', file: 'src/a.ts', message: 'parse error', severity: 'error' }] }), f)
    expect(out.results[0]!.status).toBe('unknown')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/core/test/check.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement `results.ts` and `check/types.ts`**

`packages/core/src/results.ts`:
```ts
import type { Expr } from './expr.js'
import type { ProposedRule, Rule } from './rules.js'

export const RESULT_STATUSES = ['pass', 'violation', 'stale', 'unknown', 'unapproved-edit'] as const
export type ResultStatus = (typeof RESULT_STATUSES)[number]

export type Result = {
  rule: string
  status: ResultStatus
  target: string
  at?: { symbol: string; file?: string; line?: number }
  message: string
  unproven?: Expr
  fix?: string
}

export type Summary = Record<ResultStatus, number> & { muted: number; rules: number }

export function summarize(results: Result[], muted: number): Summary {
  const summary: Summary = { pass: 0, violation: 0, stale: 0, unknown: 0, 'unapproved-edit': 0, muted, rules: 0 }
  const worst = new Map<string, ResultStatus>()
  for (const r of results) {
    const prev = worst.get(r.rule)
    if (!prev || RESULT_STATUSES.indexOf(r.status) > RESULT_STATUSES.indexOf(prev)) worst.set(r.rule, r.status)
  }
  for (const status of worst.values()) summary[status]++
  summary.rules = worst.size
  return summary
}

export function describeTarget(rule: Rule | ProposedRule): string {
  const t = rule.target
  if ('routes' in t) return `routes ${t.routes}`
  if ('symbol' in t) return t.symbol
  return t.store === 'postgres' ? `pg:${t.table}` : `${t.store}:${t.path}`
}
```

`summarize` counts each rule once, by its worst status in the order of `RESULT_STATUSES`.

`packages/core/src/check/types.ts`:
```ts
import type { Expr } from '../expr.js'
import type { FactIndex } from '../fact-index.js'
import type { Vocabulary } from '../logic.js'
import type { Result } from '../results.js'

export type CheckContext = { index: FactIndex; vocab: Vocabulary }
export type Violation = { message: string; at?: Result['at']; unproven?: Expr; fix?: string }
export type CheckOutcome = { stale: string } | { violations: Violation[] }
```

- [ ] **Step 4: Implement the access and data-access checkers**

`packages/core/src/check/access.ts`:
```ts
import { formatExpr } from '../format.js'
import { implies } from '../logic.js'
import type { AccessRule, ProposedRule } from '../rules.js'
import type { CheckContext, CheckOutcome, Violation } from './types.js'

type Access = Extract<AccessRule | ProposedRule, { type: 'access' }>

export function checkAccess(rule: Access, { index, vocab }: CheckContext): CheckOutcome {
  if ('symbol' in rule.target) {
    const id = rule.target.symbol
    if (!index.hasId(id)) return { stale: `symbol ${id} not found` }
    const result = implies({ and: index.guardsAt(id).map(g => g.requires) }, rule.requires, vocab)
    if (result.ok) return { violations: [] }
    const missing = formatExpr(result.unproven)
    return { violations: [{ message: `${id} does not check ${missing}`, at: index.at(id), unproven: result.unproven, fix: `Check ${missing} before ${id} does any work.` }] }
  }
  const routes = index.routesMatching(rule.target.routes)
  if (routes.length === 0) return { stale: `no routes match ${rule.target.routes}` }
  const violations = routes.flatMap((route): Violation[] => {
    const result = implies({ and: index.guardChain(route).map(g => g.requires) }, rule.requires, vocab)
    if (result.ok) return []
    const missing = formatExpr(result.unproven)
    const name = `${route.method} ${route.path}`
    return [{
      message: `${name} does not check ${missing}`,
      at: index.at(route.handler),
      unproven: result.unproven,
      fix: `Add a check for ${missing} to ${name}, as middleware or before its first data access.`,
    }]
  })
  return { violations }
}
```

`packages/core/src/check/data-access.ts`:
```ts
import type { Expr } from '../expr.js'
import { formatExpr } from '../format.js'
import { implies, renameParams } from '../logic.js'
import { alignParams } from '../paths.js'
import type { DataAccessRule, ProposedRule } from '../rules.js'
import { describeTarget } from '../results.js'
import type { CheckContext, CheckOutcome, Violation } from './types.js'

type DataAccess = Extract<DataAccessRule | ProposedRule, { type: 'data-access' }>

export function checkDataAccess(rule: DataAccess, { index, vocab }: CheckContext): CheckOutcome {
  const t = rule.target
  const name = describeTarget(rule)
  if (t.store === 'postgres') {
    const table = index.table(t.table)
    if (!table) return { stale: `table ${t.table} not found` }
    if (!table.rlsEnabled) {
      return { violations: [{
        message: `Row level security is not enabled on ${table.name}, so no policy limits access`,
        at: index.at(table.id),
        fix: `ALTER TABLE ${table.name} ENABLE ROW LEVEL SECURITY; then add policies that require ${formatExpr(rule.requires)}.`,
      }] }
    }
  } else if (!index.targetExists(t)) {
    return { stale: `nothing matches ${name}` }
  }
  const violations = rule.ops.flatMap((op): Violation[] => {
    const conditions = index.policies(t, op).map(p => ({
      policy: p,
      condition: t.store === 'postgres' ? p.condition : renameParams(p.condition, alignParams(p.target, t.path)),
    }))
    const result = implies({ or: conditions.map(c => c.condition) } satisfies Expr, rule.requires, vocab)
    if (result.ok) return []
    const culprit = conditions.find(c => !implies(c.condition, rule.requires, vocab).ok)
    const missing = formatExpr(result.unproven)
    return [{
      message: `${op} on ${name} is allowed without ${missing}`,
      at: culprit ? index.at(culprit.policy.id) : undefined,
      unproven: result.unproven,
      fix: `Make every policy that allows ${op} on ${name} require ${missing}.`,
    }]
  })
  return { violations }
}
```

- [ ] **Step 5: Implement the visibility, flow and invariant checkers**

`packages/core/src/check/visibility.ts`:
```ts
import { TRUE } from '../expr.js'
import { formatExpr } from '../format.js'
import { implies } from '../logic.js'
import type { ProposedRule, VisibilityRule } from '../rules.js'
import { describeTarget } from '../results.js'
import type { CheckContext, CheckOutcome, Violation } from './types.js'

type Visibility = Extract<VisibilityRule | ProposedRule, { type: 'visibility' }>

export function checkVisibility(rule: Visibility, { index, vocab }: CheckContext): CheckOutcome {
  const name = describeTarget(rule)
  const reads = index.dataOps(rule.target, ['read', 'list'])
  if (reads.length === 0 && !index.targetExists(rule.target)) return { stale: `nothing matches ${name}` }
  const violations = reads
    .filter(op => !index.coveredBy(op.in, rule.via))
    .flatMap((op): Violation[] => {
      const result = implies(op.filters ?? TRUE, rule.requires, vocab)
      if (result.ok) return []
      const missing = formatExpr(result.unproven)
      const through = rule.via.length > 0 ? `, or route it through ${rule.via.join(' or ')}` : ''
      return [{
        message: `${op.op} of ${name} in ${op.in} does not filter by ${missing}`,
        at: { symbol: op.in, file: op.evidence?.file, line: op.evidence?.line },
        unproven: result.unproven,
        fix: `Add a filter for ${missing} to this query${through}.`,
      }]
    })
  return { violations }
}
```

`packages/core/src/check/flow.ts`:
```ts
import type { FlowRule, ProposedRule } from '../rules.js'
import { describeTarget } from '../results.js'
import type { CheckContext, CheckOutcome } from './types.js'

type Flow = Extract<FlowRule | ProposedRule, { type: 'flow' }>

export function checkFlow(rule: Flow, { index }: CheckContext): CheckOutcome {
  const name = describeTarget(rule)
  const ops = index.dataOps(rule.target, rule.ops)
  if (ops.length === 0 && !index.targetExists(rule.target)) return { stale: `nothing matches ${name}` }
  const via = rule.via.join(' or ')
  return {
    violations: ops.filter(op => !index.coveredBy(op.in, rule.via)).map(op => ({
      message: `${op.op} of ${name} in ${op.in} does not go through ${via}`,
      at: { symbol: op.in, file: op.evidence?.file, line: op.evidence?.line },
      fix: `Call ${via} instead of writing to ${name} directly.`,
    })),
  }
}
```

`packages/core/src/check/invariant.ts`:
```ts
import { mentionsOperand, renameParams } from '../logic.js'
import { alignParams, normalizeTable } from '../paths.js'
import type { InvariantRule, ProposedRule } from '../rules.js'
import type { Table } from '../facts.js'
import type { CheckContext, CheckOutcome, Violation } from './types.js'

type Invariant = Extract<InvariantRule | ProposedRule, { type: 'invariant' }>

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i])
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every(x => b.includes(x))
const normalizeSql = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim().replace(/^\((.*)\)$/, '$1').trim()

export function checkInvariant(rule: Invariant, ctx: CheckContext): CheckOutcome {
  return rule.target.store === 'postgres' ? checkTable(rule, rule.target.table, ctx) : checkDocs(rule, ctx)
}

function checkTable(rule: Invariant, tableName: string, { index }: CheckContext): CheckOutcome {
  const table = index.table(tableName)
  if (!table) return { stale: `table ${tableName} not found` }
  const at = index.at(table.id)
  const fail = (message: string, fix: string): CheckOutcome => ({ violations: [{ message, at, fix }] })
  const cols = rule.columns.join(', ')
  switch (rule.kind) {
    case 'not-null': {
      const missing = rule.columns.filter(c => !table.columns.some(col => col.name === c))
      if (missing.length > 0) return fail(`${table.name} has no column ${missing.join(', ')}`, `Restore ${missing.join(', ')} on ${table.name}.`)
      const nullable = rule.columns.filter(c => table.columns.find(col => col.name === c)!.nullable)
      return nullable.length === 0 ? { violations: [] }
        : fail(`${table.name}.${nullable.join(', ')} allows NULL`, nullable.map(c => `ALTER TABLE ${table.name} ALTER COLUMN ${c} SET NOT NULL;`).join(' '))
    }
    case 'fk': {
      const ref = rule.references!
      const found = table.foreignKeys.some(fk => sameList(fk.columns, rule.columns)
        && normalizeTable(fk.references.table) === normalizeTable(ref.table) && sameList(fk.references.columns, ref.columns))
      return found ? { violations: [] }
        : fail(`${table.name}(${cols}) has no foreign key to ${ref.table}(${ref.columns.join(', ')})`,
          `ALTER TABLE ${table.name} ADD FOREIGN KEY (${cols}) REFERENCES ${ref.table}(${ref.columns.join(', ')});`)
    }
    case 'unique': {
      const found = [table.primaryKey, ...table.uniques].some(u => u.length > 0 && sameSet(u, rule.columns))
      return found ? { violations: [] } : fail(`${table.name}(${cols}) is not unique`, `ALTER TABLE ${table.name} ADD UNIQUE (${cols});`)
    }
    case 'check': {
      const found = table.checks.some(c => rule.expr
        ? normalizeSql(c.expr) === normalizeSql(rule.expr)
        : rule.columns.every(col => new RegExp(`\\b${col}\\b`).test(c.expr)))
      return found ? { violations: [] }
        : fail(`${table.name} has no CHECK ${rule.expr ? `(${rule.expr})` : `on ${cols}`}`, `ALTER TABLE ${table.name} ADD CHECK (${rule.expr ?? '…'});`)
    }
    case 'enum': {
      const values = rule.values!
      const bad = rule.columns.filter(c => {
        const e = table.enums.find(x => x.column === c)
        return !e || !sameSet(e.values, values)
      })
      return bad.length === 0 ? { violations: [] }
        : fail(`${table.name}.${bad.join(', ')} does not allow exactly ${values.join(', ')}`, `Make ${bad.join(', ')} an enum of ${values.join(', ')}.`)
    }
  }
}

function checkDocs(rule: Invariant, { index }: CheckContext): CheckOutcome {
  const t = rule.target
  if (t.store === 'postgres') return { violations: [] }
  if (!index.targetExists(t)) return { stale: `nothing matches ${t.store}:${t.path}` }
  const writes = [...index.policies(t, 'create'), ...index.policies(t, 'update')]
  const violations: Violation[] = writes.flatMap(p => {
    const condition = renameParams(p.condition, alignParams(p.target, t.path))
    const unchecked = rule.columns.filter(c => !mentionsOperand(condition, `incoming.${c}`))
    return unchecked.length === 0 ? [] : [{
      message: `A write rule for ${t.store}:${t.path} does not check ${unchecked.join(', ')}`,
      at: index.at(p.id),
      fix: `Check request.resource.data.${unchecked.join(', request.resource.data.')} in this rule.`,
    }]
  })
  return { violations: dedupe(violations) }
}

function dedupe(vs: Violation[]): Violation[] {
  const seen = new Set<string>()
  return vs.filter(v => (seen.has(v.at?.symbol ?? v.message) ? false : (seen.add(v.at?.symbol ?? v.message), true)))
}

export type { Table }
```

Note: `checkDocs` lists a policy once even when it covers both create and update.

- [ ] **Step 6: Implement `check/run.ts`**

```ts
import { FactIndex } from '../fact-index.js'
import type { Facts } from '../facts.js'
import { hashRule } from '../hash.js'
import { vocabularyMap, type ProposedRule, type Rule, type RulesFile } from '../rules.js'
import { describeTarget, type Result } from '../results.js'
import { checkAccess } from './access.js'
import { checkDataAccess } from './data-access.js'
import { checkFlow } from './flow.js'
import { checkInvariant } from './invariant.js'
import type { CheckContext, CheckOutcome } from './types.js'
import { checkVisibility } from './visibility.js'

export function evaluateRule(rule: Rule | ProposedRule, ctx: CheckContext): CheckOutcome {
  switch (rule.type) {
    case 'access': return checkAccess(rule, ctx)
    case 'data-access': return checkDataAccess(rule, ctx)
    case 'visibility': return checkVisibility(rule, ctx)
    case 'flow': return checkFlow(rule, ctx)
    case 'invariant': return checkInvariant(rule, ctx)
  }
}

export function checkRule(rule: Rule, ctx: CheckContext): Result[] {
  const target = describeTarget(rule)
  if (!rule.approved || rule.approved.hash !== hashRule(rule)) {
    return [{ rule: rule.id, status: 'unapproved-edit', target, message: `"${rule.text}" was changed without approval. Approve it with \`holdline approve ${rule.id}\`, or restore it.` }]
  }
  const outcome = evaluateRule(rule, ctx)
  const unreadable = rule.evidence.some(id => {
    const file = ctx.index.fileOf(id)
    return !!file && ctx.index.errorFiles().has(file)
  })
  if ('stale' in outcome) return [{ rule: rule.id, status: unreadable ? 'unknown' : 'stale', target, message: outcome.stale }]
  if (outcome.violations.length === 0) return [{ rule: rule.id, status: 'pass', target, message: rule.text }]
  return outcome.violations.map(v => ({ rule: rule.id, status: unreadable ? 'unknown' : 'violation', target, ...v }))
}

export function runChecks(facts: Facts, file: RulesFile, opts: { only?: string[] } = {}): { results: Result[]; muted: number } {
  const ctx: CheckContext = { index: new FactIndex(facts), vocab: vocabularyMap(file) }
  const results: Result[] = []
  let muted = 0
  for (const rule of file.rules) {
    if (opts.only && !opts.only.includes(rule.id)) continue
    if (rule.status === 'muted') { muted++; continue }
    if (rule.status === 'pending') continue
    results.push(...checkRule(rule, ctx))
  }
  return { results, muted }
}
```

Remove the trailing `export type { Table }` line in `invariant.ts` if typecheck flags the unused import; it exists only to keep the `Table` import used. Prefer deleting both the import and that line.

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/test/check.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/core
git commit -m "feat(core): add the five rule checkers and runChecks"
```

---

### Task 8: DB test-case format and generator

**Files:**
- Create: `packages/core/src/testcase.ts`, `packages/core/src/testgen.ts`
- Test: `packages/core/test/testgen.test.ts`

**Interfaces:**
- Consumes: `Rule`, `DataAccessRule` (Task 5), `Atom`, `Expr`, `Operand` (Task 2), `expand`, `flattenAnd`, `Vocabulary` (Task 3), `concretize` (Task 4), `formatAtom` (Task 2), `hashRule` (Task 5)
- Produces:
  - `ActorSchema`, `SeedSchema`, `TestCaseSchema`, `TestFileSchema`; types `TestCase`, `TestFile`
  - `parseTestFile(text: string, source?: string): TestFile`, `serializeTestFile(file: TestFile): string`
  - `generateTests(rule: Rule, vocab: Vocabulary): TestFile | undefined` (a `TestFile` for `data-access` rules; `undefined` for other types in Phase 0)
- Postgres `exists` doc format (frozen here, used by `analyzer-postgres`): `pg:<table>?<column>={<operand>}&<column>={<operand>}`, for example `pg:public.members?account_id={resource.account_id}&user_id={actor.uid}`.

- [ ] **Step 1: Write the failing tests**

`packages/core/test/testgen.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { hashRule } from '../src/hash.js'
import { RuleSchema } from '../src/rules.js'
import { parseTestFile, serializeTestFile } from '../src/testcase.js'
import { generateTests } from '../src/testgen.js'

const vocab = new Map()
const rule = (raw: Record<string, unknown>) => RuleSchema.parse({ id: 'R-001', text: 't', status: 'approved', ...raw })

describe('generateTests for firestore', () => {
  const r = rule({
    type: 'data-access',
    target: { store: 'firestore', path: '/accounts/{accountId}/dogs/{dogId}' },
    ops: ['read'],
    requires: { and: [
      { atom: { op: 'exists', doc: '/accounts/{param.accountId}/members/{actor.uid}' } },
      { atom: { op: 'isNull', operand: 'resource.deletedAt' } },
    ] },
  })
  const file = generateTests(r, vocab)!

  it('records the rule hash and store', () => {
    expect(file.rule).toBe('R-001')
    expect(file.generatedFrom).toBe(hashRule(r))
    expect(file.store).toBe('firestore')
  })
  it('makes one allow case and one deny case per atom', () => {
    expect(file.cases.map(c => [c.name, c.expect])).toEqual([
      ['read: allowed when every condition holds', 'allow'],
      ['read: denied without exists(/accounts/{param.accountId}/members/{actor.uid})', 'deny'],
      ['read: denied without resource.deletedAt is null', 'deny'],
    ])
  })
  it('seeds the satisfying world', () => {
    const allow = file.cases[0]!
    expect(allow.as).toEqual({ uid: 'user-1', claims: {} })
    expect(allow.do).toEqual({ op: 'read', path: '/accounts/accountId-1/dogs/dogId-1' })
    expect(allow.seed).toEqual([
      { path: '/accounts/accountId-1/dogs/dogId-1', data: { deletedAt: null } },
      { path: '/accounts/accountId-1/members/user-1', data: {} },
    ])
  })
  it('breaks one atom per deny case', () => {
    expect(file.cases[1]!.seed).toEqual([{ path: '/accounts/accountId-1/dogs/dogId-1', data: { deletedAt: null } }])
    expect(file.cases[2]!.seed[0]!.data).toEqual({ deletedAt: 'not-null' })
  })
  it('round-trips through YAML', () => {
    expect(parseTestFile(serializeTestFile(file))).toEqual(file)
  })
})

describe('generateTests for postgres', () => {
  it('builds rows, claims and pg exists seeds', () => {
    const r = rule({
      type: 'data-access',
      target: { store: 'postgres', table: 'dogs' },
      ops: ['read', 'update'],
      requires: { and: [
        { atom: { op: 'eq', left: 'actor.claim.team_id', right: 'resource.team_id' } },
        { atom: { op: 'exists', doc: 'pg:public.members?team_id={resource.team_id}&user_id={actor.uid}' } },
      ] },
    })
    const file = generateTests(r, vocab)!
    const allowRead = file.cases[0]!
    expect(allowRead.as).toEqual({ uid: 'user-1', claims: { team_id: 'value-1' } })
    expect(allowRead.seed).toEqual([
      { path: 'public.dogs', data: { team_id: 'value-1' } },
      { path: 'public.members', data: { team_id: 'value-1', user_id: 'user-1' } },
    ])
    expect(allowRead.do).toEqual({ op: 'read', path: 'public.dogs' })
    const denyClaim = file.cases[1]!
    expect(denyClaim.seed[0]!.data).toEqual({ team_id: 'other-value' })
    expect(file.cases.filter(c => c.do.op === 'update')[0]!.do.data).toEqual({ team_id: 'value-1' })
  })
})

describe('generateTests limits', () => {
  it('skips requirements it cannot build worlds for', () => {
    const r = rule({
      type: 'data-access',
      target: { store: 'firestore', path: '/dogs/{dogId}' },
      ops: ['read', 'list'],
      requires: { or: [{ atom: { op: 'authenticated' } }, { opaque: 'x' }] },
    })
    const file = generateTests(r, vocab)!
    expect(file.cases).toEqual([])
    expect(file.skipped[0]).toMatch(/only "and" of atoms/)
  })
  it('skips list when the requirement reads the stored record', () => {
    const r = rule({
      type: 'data-access',
      target: { store: 'firestore', path: '/dogs/{dogId}' },
      ops: ['list'],
      requires: { atom: { op: 'eq', left: 'actor.uid', right: 'resource.ownerId' } },
    })
    expect(generateTests(r, vocab)!.skipped).toEqual(['list: needs query filters to test; read cases cover the condition'])
  })
  it('returns undefined for other rule types', () => {
    expect(generateTests(rule({ type: 'access', target: { routes: 'GET /a' }, requires: { atom: { op: 'authenticated' } } }), vocab)).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/core/test/testgen.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement `testcase.ts`**

```ts
import YAML from 'yaml'
import { z } from 'zod'
import { DataStoreSchema, OpSchema } from './facts.js'

export const ActorSchema = z.strictObject({
  uid: z.string(),
  role: z.string().optional(),
  claims: z.record(z.string(), z.unknown()).default({}),
})

export const SeedSchema = z.strictObject({ path: z.string(), data: z.record(z.string(), z.unknown()) })

export const TestCaseSchema = z.strictObject({
  name: z.string(),
  as: ActorSchema.nullable(),
  seed: z.array(SeedSchema).default([]),
  do: z.strictObject({ op: OpSchema, path: z.string(), data: z.record(z.string(), z.unknown()).optional() }),
  expect: z.enum(['allow', 'deny']),
})

export const TestFileSchema = z.strictObject({
  rule: z.string(),
  generatedFrom: z.string(),
  store: DataStoreSchema,
  cases: z.array(TestCaseSchema),
  skipped: z.array(z.string()).default([]),
})

export type TestCase = z.output<typeof TestCaseSchema>
export type TestFile = z.output<typeof TestFileSchema>

export function parseTestFile(text: string, source = 'test file'): TestFile {
  const parsed = TestFileSchema.safeParse(YAML.parse(text))
  if (!parsed.success) throw new Error(`${source}: ${z.prettifyError(parsed.error)}`)
  return parsed.data
}

export function serializeTestFile(file: TestFile): string {
  return YAML.stringify(file, { lineWidth: 0 })
}
```

- [ ] **Step 4: Implement `testgen.ts`**

```ts
import type { Atom, Expr, Operand } from './expr.js'
import { formatAtom } from './format.js'
import { hashRule } from './hash.js'
import { expand, flattenAnd, type Vocabulary } from './logic.js'
import { concretize } from './paths.js'
import type { DataAccessRule, Rule } from './rules.js'
import type { TestCase, TestFile } from './testcase.js'
import type { Op } from './facts.js'

type Actor = { uid: string; role?: string; claims: Record<string, unknown> }
type World = {
  actor: Actor | null
  params: Record<string, string>
  resource: Record<string, unknown>
  incoming: Record<string, unknown>
  docs: { path: string; data: Record<string, unknown> }[]
}

class Unsupported extends Error {}

export function generateTests(rule: Rule, vocab: Vocabulary): TestFile | undefined {
  if (rule.type !== 'data-access') return undefined
  const base = { rule: rule.id, generatedFrom: hashRule(rule), store: rule.target.store, cases: [] as TestCase[], skipped: [] as string[] }
  const parts = flattenAnd(expand(rule.requires, vocab))
  if (!parts.every((p): p is { atom: Atom } => 'atom' in p)) {
    return { ...base, skipped: ['the requirement must be only "and" of atoms to generate cases; check it statically'] }
  }
  const atoms = parts.map(p => p.atom)
  try {
    const satisfied = satisfy(atoms, rule)
    for (const op of rule.ops) {
      if (op === 'list' && Object.keys(satisfied.resource).length > 0) {
        base.skipped.push('list: needs query filters to test; read cases cover the condition')
        continue
      }
      base.cases.push(toCase(`${op}: allowed when every condition holds`, satisfied, rule, op, 'allow'))
      atoms.forEach((a, i) => {
        base.cases.push(toCase(`${op}: denied without ${formatAtom(a)}`, breakAtom(atoms, i, rule), rule, op, 'deny'))
      })
    }
  } catch (e) {
    if (!(e instanceof Unsupported)) throw e
    return { ...base, cases: [], skipped: [e.message] }
  }
  return base
}

function targetPath(rule: DataAccessRule): string {
  return rule.target.store === 'postgres' ? rule.target.table : rule.target.path
}

function freshWorld(rule: DataAccessRule): World {
  const params: Record<string, string> = {}
  if (rule.target.store !== 'postgres') concretize(rule.target.path, name => (params[name] = `${name}-1`))
  return { actor: { uid: 'user-1', claims: {} }, params, resource: {}, incoming: {}, docs: [] }
}

function satisfy(atoms: Atom[], rule: DataAccessRule, skip = -1): World {
  const w = freshWorld(rule)
  let counter = 0
  const order = atoms.map((a, i) => ({ a, i })).sort((x, y) => Number(x.a.op === 'exists') - Number(y.a.op === 'exists'))
  for (const { a, i } of order) {
    if (i === skip) continue
    switch (a.op) {
      case 'authenticated': break
      case 'isNull': set(w, a.operand, null); break
      case 'in': {
        const v = literalValue(a.right)
        if (!Array.isArray(v) || v.length === 0) throw new Unsupported(`cannot satisfy ${formatAtom(a)}`)
        set(w, a.left, v[0]); break
      }
      case 'eq': {
        const l = read(w, a.left)
        const r = read(w, a.right)
        if (l.fixed) set(w, a.right, l.value)
        else if (r.fixed) set(w, a.left, r.value)
        else { const v = `value-${++counter}`; set(w, a.left, v); set(w, a.right, v) }
        break
      }
      case 'exists': w.docs.push(resolveDoc(w, a.doc)); break
      default: throw new Unsupported(`${a.op} conditions are not generated yet (${formatAtom(a)}); check them statically`)
    }
  }
  return w
}

function breakAtom(atoms: Atom[], index: number, rule: DataAccessRule): World {
  const a = atoms[index]!
  if (a.op === 'exists') return satisfy(atoms, rule, index)
  const w = satisfy(atoms, rule)
  switch (a.op) {
    case 'authenticated': w.actor = null; break
    case 'isNull': set(w, a.operand, 'not-null'); break
    case 'in': set(w, a.left, 'not-allowed'); break
    case 'eq': {
      // Prefer breaking the stored or incoming record; fall back to the actor's claims or role.
      const sides = [a.left, a.right]
      const side = sides.find(o => typeof o === 'string' && /^(resource|incoming)\./.test(o)) ?? sides.find(settable)
      if (side) set(w, side, 'other-value')
      else if (w.actor) w.actor.uid = 'user-2'
      break
    }
  }
  return w
}

function toCase(name: string, w: World, rule: DataAccessRule, op: Op, expect: 'allow' | 'deny'): TestCase {
  const path = rule.target.store === 'postgres' ? storePath(rule) : concretize(targetPath(rule), p => w.params[p] ?? `${p}-1`)
  const record = { ...w.resource }
  const seed = [...(op === 'create' ? [] : [{ path: storePath(rule), data: record }]), ...w.docs]
  const data = op === 'create' || op === 'update' ? { ...record, ...w.incoming } : undefined
  const listPath = path.split('/').slice(0, -1).join('/')
  return {
    name,
    as: w.actor ? { ...w.actor, claims: { ...w.actor.claims } } : null,
    seed: rule.target.store === 'postgres' ? seed : seed.map(s => (s.path === storePath(rule) ? { ...s, path } : s)),
    do: { op, path: op === 'list' && rule.target.store !== 'postgres' ? listPath : path, ...(data ? { data } : {}) },
    expect,
  }
}

function storePath(rule: DataAccessRule): string {
  return rule.target.store === 'postgres' ? rule.target.table.includes('.') ? rule.target.table : `public.${rule.target.table}` : targetPath(rule)
}

function literalValue(o: Operand): unknown {
  return typeof o === 'string' ? undefined : o.literal
}

function settable(o: Operand): boolean {
  return typeof o === 'string' && /^(resource|incoming|actor\.claim|actor\.role)/.test(o)
}

function read(w: World, o: Operand): { fixed: boolean; value: unknown } {
  if (typeof o !== 'string') return { fixed: true, value: o.literal }
  if (o === 'actor.uid') return { fixed: true, value: w.actor?.uid }
  if (o.startsWith('param.')) return { fixed: true, value: w.params[o.slice(6)] ?? `${o.slice(6)}-1` }
  return { fixed: false, value: undefined }
}

function set(w: World, o: Operand, value: unknown): void {
  if (typeof o !== 'string') return
  if (o.startsWith('resource.')) w.resource[o.slice(9)] = value
  else if (o.startsWith('incoming.')) w.incoming[o.slice(9)] = value
  else if (o.startsWith('actor.claim.') && w.actor) w.actor.claims[o.slice(12)] = value
  else if (o === 'actor.role' && w.actor) w.actor.role = String(value)
  else throw new Unsupported(`cannot set ${o} to ${JSON.stringify(value)}`)
}

function resolveDoc(w: World, doc: string): { path: string; data: Record<string, unknown> } {
  const fill = (operand: string) => String(read(w, operand).fixed ? read(w, operand).value : valueOf(w, operand))
  if (doc.startsWith('pg:')) {
    const [table, query = ''] = doc.slice(3).split('?')
    const data: Record<string, unknown> = {}
    for (const pair of query.split('&').filter(Boolean)) {
      const [col, ref] = pair.split('=')
      data[col!] = fill(ref!.replace(/^\{|\}$/g, ''))
    }
    return { path: table!, data }
  }
  return { path: doc.replace(/\{([^}]+)\}/g, (_, operand: string) => fill(operand)), data: {} }
}

function valueOf(w: World, operand: string): unknown {
  if (operand.startsWith('resource.')) return w.resource[operand.slice(9)]
  if (operand.startsWith('incoming.')) return w.incoming[operand.slice(9)]
  if (operand.startsWith('actor.claim.')) return w.actor?.claims[operand.slice(12)]
  if (operand === 'actor.role') return w.actor?.role
  throw new Unsupported(`cannot read ${operand}`)
}

export type { Expr }
```

Delete the trailing `export type { Expr }` and the unused `Expr` import if typecheck flags them.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/test/testgen.test.ts && pnpm typecheck`
Expected: PASS. If a seed ordering assertion fails, keep the order "target record first, then `exists` docs in requirement order", which is what the tests assert; adjust the implementation, not the test.

- [ ] **Step 6: Commit**

```bash
git add packages/core
git commit -m "feat(core): add DB test-case format and deterministic generator for data-access rules"
```

---

### Task 9: Proposals, pending changes and approval

**Files:**
- Create: `packages/core/src/proposals.ts`, `packages/core/src/pending.ts`
- Test: `packages/core/test/proposals.test.ts`

**Interfaces:**
- Consumes: `ProposedRuleSchema`, `VocabularyEntrySchema`, `RuleSchema`, `validateRuleSemantics`, `vocabularyMap`, `nextRuleId`, `RulesFile` (Task 5), `hashRule` (Task 5), `evaluateRule` (Task 7), `FactIndex` (Task 6), `collectRefs` (Task 3), `canonicalJson` (Task 2)
- Produces:
  - `ProposalBatchSchema` (for JSON Schema export), `class ProposalError extends Error`
  - `type Classification = 'holds' | 'broken' | 'rejected'`
  - `type RuleOutcome = { classification: Classification; rule?: ProposedRule; raw: unknown; reason?: string; violations?: string[] }`
  - `type VocabularyOutcome = { accepted: boolean; entry?: VocabularyEntry; raw: unknown; reason?: string }`
  - `type ProposalReport = { rules: RuleOutcome[]; vocabulary: VocabularyOutcome[]; dropped: number }`
  - `validateProposals(input: unknown, facts: Facts, file: RulesFile, opts?: { limit?: number }): ProposalReport`
  - `PendingFileSchema`, `type PendingRule = { key: string; classification: 'holds' | 'broken'; violations: string[]; rule: ProposedRule }`, `type PendingFile`
  - `emptyPending(): PendingFile`, `parsePendingFile(text: string): PendingFile`, `serializePendingFile(p: PendingFile): string`
  - `addToPending(pending: PendingFile, report: ProposalReport): { pending: PendingFile; added: PendingRule[] }`
  - `approve(file: RulesFile, pending: PendingFile, keys: string[] | 'all', approval: { by: string; at: string }): { file: RulesFile; pending: PendingFile; approved: { key: string; id: string }[] }`
  - `reject(pending: PendingFile, keys: string[]): PendingFile`
  - `mute(file: RulesFile, id: string, m: { by: string; at: string; reason: string }): RulesFile`

- [ ] **Step 1: Write the failing tests**

`packages/core/test/proposals.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { runChecks } from '../src/check/run.js'
import { parseFacts } from '../src/facts.js'
import { addToPending, approve, emptyPending, mute, parsePendingFile, reject, serializePendingFile } from '../src/pending.js'
import { ProposalError, validateProposals } from '../src/proposals.js'
import { emptyRulesFile } from '../src/rules.js'

const facts = parseFacts({
  version: 1,
  symbols: [{ id: 'h:transfer', kind: 'function', lang: 'ts' }, { id: 'h:archive', kind: 'function', lang: 'ts' }],
  routes: [
    { id: 'route:POST /dogs/:id/transfer', method: 'POST', path: '/dogs/:id/transfer', handler: 'h:transfer', framework: 'express' },
    { id: 'route:POST /dogs/:id/archive', method: 'POST', path: '/dogs/:id/archive', handler: 'h:archive', framework: 'express' },
  ],
  guards: [{ at: 'h:transfer', requires: { ref: 'staff' } }],
})
const staffVocab = { id: 'staff', text: 'Caller is staff', expr: { atom: { op: 'in', left: 'actor.role', right: { literal: ['admin'] } } } }
const transferRule = { text: 'Only staff transfer dogs', type: 'access', target: { routes: 'POST /dogs/*/transfer' }, requires: { ref: 'staff' }, evidence: ['h:transfer'] }
const archiveRule = { text: 'Only staff archive dogs', type: 'access', target: { routes: 'POST /dogs/*/archive' }, requires: { ref: 'staff' }, evidence: ['h:archive'] }

describe('validateProposals', () => {
  it('classifies holds, broken and rejected', () => {
    const report = validateProposals({
      vocabulary: [staffVocab],
      rules: [
        transferRule,
        archiveRule,
        { ...transferRule, text: 'Duplicate wording' },
        { text: 'Cats', type: 'access', target: { routes: 'GET /cats' }, requires: { ref: 'staff' } },
        { text: 'Bad evidence', type: 'access', target: { routes: 'POST /dogs/*/transfer' }, requires: { ref: 'staff' }, evidence: ['h:nope'] },
        { text: 'Unknown predicate', type: 'access', target: { routes: 'POST /dogs/*/transfer' }, requires: { ref: 'ghost' } },
        { type: 'access' },
      ],
    }, facts, emptyRulesFile())
    expect(report.vocabulary.map(v => v.accepted)).toEqual([true])
    const byText = Object.fromEntries(report.rules.map(r => [(r.rule?.text ?? 'invalid'), r]))
    expect(byText['Only staff archive dogs']!.classification).toBe('broken')
    expect(byText['Only staff archive dogs']!.violations![0]).toMatch(/archive does not check staff/)
    expect(byText['Only staff transfer dogs']!.classification).toBe('holds')
    expect(byText['Duplicate wording']!.reason).toMatch(/duplicate/)
    expect(byText['Cats']!.reason).toMatch(/target not found/)
    expect(byText['Bad evidence']!.reason).toMatch(/evidence not found: h:nope/)
    expect(byText['Unknown predicate']!.reason).toMatch(/unknown predicate ghost/)
    expect(byText['invalid']!.classification).toBe('rejected')
  })
  it('ranks broken first and keeps the top N', () => {
    const report = validateProposals({ vocabulary: [staffVocab], rules: [transferRule, archiveRule] }, facts, emptyRulesFile(), { limit: 1 })
    const kept = report.rules.filter(r => r.classification !== 'rejected')
    expect(kept.map(r => r.rule!.text)).toEqual(['Only staff archive dogs'])
    expect(report.dropped).toBe(1)
  })
  it('throws ProposalError for input that is not a proposal batch', () => {
    expect(() => validateProposals([1, 2], facts, emptyRulesFile())).toThrow(ProposalError)
  })
})

describe('pending and approval', () => {
  const report = validateProposals({ vocabulary: [staffVocab], rules: [transferRule, archiveRule] }, facts, emptyRulesFile())
  const { pending, added } = addToPending(emptyPending(), report)

  it('assigns pending keys and round-trips', () => {
    expect(added.map(a => a.key)).toEqual(['P-1', 'P-2'])
    expect(parsePendingFile(serializePendingFile(pending))).toEqual(pending)
  })
  it('approves rules with ids, hashes and their vocabulary', () => {
    const out = approve(emptyRulesFile(), pending, ['P-2'], { by: 'almog', at: '2026-10-21' })
    expect(out.approved).toEqual([{ key: 'P-2', id: 'R-001' }])
    expect(out.file.vocabulary.map(v => v.id)).toEqual(['staff'])
    expect(out.pending.rules.map(r => r.key)).toEqual(['P-1'])
    expect(out.pending.vocabulary).toEqual([])
    const results = runChecks(facts, out.file).results
    expect(results.map(r => r.status)).toEqual(['pass'])
  })
  it('re-approves an edited rule by its R id', () => {
    const first = approve(emptyRulesFile(), pending, 'all', { by: 'almog', at: '2026-10-21' })
    const edited = { ...first.file, rules: first.file.rules.map(r => (r.id === 'R-001' ? { ...r, text: 'Only staff may transfer a dog' } : r)) }
    expect(runChecks(facts, edited).results.find(r => r.rule === 'R-001')!.status).toBe('unapproved-edit')
    const again = approve(edited, first.pending, ['R-001'], { by: 'almog', at: '2026-10-22' })
    expect(runChecks(facts, again.file).results.find(r => r.rule === 'R-001')!.status).not.toBe('unapproved-edit')
  })
  it('rejects unknown keys, and reject removes pending rules', () => {
    expect(() => approve(emptyRulesFile(), pending, ['P-9'], { by: 'a', at: 'b' })).toThrow(/P-9/)
    expect(reject(pending, ['P-1']).rules.map(r => r.key)).toEqual(['P-2'])
  })
  it('mute records who, when and why', () => {
    const { file } = approve(emptyRulesFile(), pending, 'all', { by: 'almog', at: '2026-10-21' })
    const muted = mute(file, 'R-001', { by: 'almog', at: '2026-10-22', reason: 'migrating' })
    expect(muted.rules[0]).toMatchObject({ status: 'muted', muted: { reason: 'migrating' } })
    expect(() => mute(file, 'R-404', { by: 'a', at: 'b', reason: 'c' })).toThrow(/R-404/)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/core/test/proposals.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement `proposals.ts`**

```ts
import { z } from 'zod'
import { canonicalJson } from './canonical.js'
import { evaluateRule } from './check/run.js'
import { FactIndex } from './fact-index.js'
import type { Facts } from './facts.js'
import { collectRefs } from './logic.js'
import {
  ProposedRuleSchema, VocabularyEntrySchema, validateRuleSemantics, vocabularyMap,
  type ProposedRule, type Rule, type RulesFile, type VocabularyEntry,
} from './rules.js'

export const ProposalBatchSchema = z.strictObject({
  vocabulary: z.array(VocabularyEntrySchema).default([]),
  rules: z.array(ProposedRuleSchema).default([]),
})

export class ProposalError extends Error {}

export type Classification = 'holds' | 'broken' | 'rejected'
export type RuleOutcome = { classification: Classification; rule?: ProposedRule; raw: unknown; reason?: string; violations?: string[] }
export type VocabularyOutcome = { accepted: boolean; entry?: VocabularyEntry; raw: unknown; reason?: string }
export type ProposalReport = { rules: RuleOutcome[]; vocabulary: VocabularyOutcome[]; dropped: number }

const RawBatch = z.object({ vocabulary: z.array(z.unknown()).default([]), rules: z.array(z.unknown()).default([]) })

export function ruleKey(rule: ProposedRule | Rule): string {
  const { text: _t, evidence: _e, enforce: _f, ...rest } = rule as Record<string, unknown>
  for (const k of ['id', 'status', 'approved', 'muted']) delete rest[k]
  return canonicalJson(rest)
}

export function validateProposals(input: unknown, facts: Facts, file: RulesFile, opts: { limit?: number } = {}): ProposalReport {
  const batch = RawBatch.safeParse(input)
  if (!batch.success) throw new ProposalError(`proposals must be an object with "vocabulary" and "rules" arrays: ${z.prettifyError(batch.error)}`)

  const knownVocab = new Set(file.vocabulary.map(v => v.id))
  const vocabulary: VocabularyOutcome[] = batch.data.vocabulary.map(raw => {
    const parsed = VocabularyEntrySchema.safeParse(raw)
    if (!parsed.success) return { accepted: false, raw, reason: z.prettifyError(parsed.error) }
    if (knownVocab.has(parsed.data.id)) return { accepted: false, raw, entry: parsed.data, reason: `vocabulary id ${parsed.data.id} already exists` }
    knownVocab.add(parsed.data.id)
    return { accepted: true, raw, entry: parsed.data }
  })
  const accepted = vocabulary.filter(v => v.accepted).map(v => v.entry!)
  const vocab = vocabularyMap(file, accepted)
  const index = new FactIndex(facts)
  const existing = new Map(file.rules.map(r => [ruleKey(r), r.id]))
  const seen = new Set<string>()

  const outcomes: RuleOutcome[] = batch.data.rules.map(raw => {
    const parsed = ProposedRuleSchema.safeParse(raw)
    if (!parsed.success) return { classification: 'rejected', raw, reason: z.prettifyError(parsed.error) }
    const rule = parsed.data
    const reject = (reason: string): RuleOutcome => ({ classification: 'rejected', raw, rule, reason })
    const semantic = validateRuleSemantics(rule)
    if (semantic.length > 0) return reject(semantic.join('; '))
    const refs = 'requires' in rule ? collectRefs(rule.requires) : []
    const unknownRef = refs.find(r => !vocab.has(r))
    if (unknownRef) return reject(`unknown predicate ${unknownRef}; propose it in "vocabulary"`)
    const missing = rule.evidence.filter(id => !index.hasId(id))
    if (missing.length > 0) return reject(`evidence not found: ${missing.join(', ')}`)
    const key = ruleKey(rule)
    if (existing.has(key)) return reject(`duplicate of ${existing.get(key)}`)
    if (seen.has(key)) return reject('duplicate of another proposal in this batch')
    seen.add(key)
    const outcome = evaluateRule(rule, { index, vocab })
    if ('stale' in outcome) return reject(`target not found: ${outcome.stale}`)
    if (outcome.violations.length > 0) {
      return { classification: 'broken', raw, rule, violations: outcome.violations.map(v => v.message) }
    }
    return { classification: 'holds', raw, rule }
  })

  const limit = opts.limit ?? 25
  const kept = outcomes
    .filter(o => o.classification !== 'rejected')
    .sort((a, b) => Number(b.classification === 'broken') - Number(a.classification === 'broken')
      || b.rule!.evidence.length - a.rule!.evidence.length)
  return {
    vocabulary,
    rules: [...kept.slice(0, limit), ...outcomes.filter(o => o.classification === 'rejected')],
    dropped: Math.max(0, kept.length - limit),
  }
}
```

Note: `rules` comes back in ranked order (kept proposals first, then rejected ones), and the sort is stable, so equal-ranked proposals keep the agent's order. Pending keys follow this order.

- [ ] **Step 4: Implement `pending.ts`**

```ts
import YAML from 'yaml'
import { z } from 'zod'
import { hashRule } from './hash.js'
import { collectRefs } from './logic.js'
import type { ProposalReport } from './proposals.js'
import { ProposedRuleSchema, RuleSchema, VocabularyEntrySchema, nextRuleId, type ProposedRule, type Rule, type RulesFile } from './rules.js'

const PendingRuleSchema = z.strictObject({
  key: z.string().regex(/^P-\d+$/),
  classification: z.enum(['holds', 'broken']),
  violations: z.array(z.string()).default([]),
  rule: ProposedRuleSchema,
})

export const PendingFileSchema = z.strictObject({
  version: z.literal(1),
  vocabulary: z.array(VocabularyEntrySchema).default([]),
  rules: z.array(PendingRuleSchema).default([]),
})

export type PendingRule = z.output<typeof PendingRuleSchema>
export type PendingFile = z.output<typeof PendingFileSchema>

export function emptyPending(): PendingFile {
  return { version: 1, vocabulary: [], rules: [] }
}

export function parsePendingFile(text: string): PendingFile {
  const parsed = PendingFileSchema.safeParse(YAML.parse(text) ?? { version: 1 })
  if (!parsed.success) throw new Error(`.holdline/pending.yaml: ${z.prettifyError(parsed.error)}`)
  return parsed.data
}

export function serializePendingFile(p: PendingFile): string {
  return YAML.stringify(p, { lineWidth: 0 })
}

export function addToPending(pending: PendingFile, report: ProposalReport): { pending: PendingFile; added: PendingRule[] } {
  let n = pending.rules.reduce((m, r) => Math.max(m, Number(r.key.slice(2))), 0)
  const added: PendingRule[] = report.rules
    .filter(o => o.classification !== 'rejected')
    .map(o => ({ key: `P-${++n}`, classification: o.classification as 'holds' | 'broken', violations: o.violations ?? [], rule: o.rule! }))
  const vocabIds = new Set(pending.vocabulary.map(v => v.id))
  const vocabulary = [...pending.vocabulary, ...report.vocabulary.filter(v => v.accepted && !vocabIds.has(v.entry!.id)).map(v => v.entry!)]
  return { pending: { ...pending, vocabulary, rules: [...pending.rules, ...added] }, added }
}

export function approve(
  file: RulesFile, pending: PendingFile, keys: string[] | 'all', approval: { by: string; at: string },
): { file: RulesFile; pending: PendingFile; approved: { key: string; id: string }[] } {
  const wanted = keys === 'all' ? pending.rules.map(r => r.key) : keys
  const unknown = wanted.filter(k => !pending.rules.some(r => r.key === k) && !file.rules.some(r => r.id === k))
  if (unknown.length > 0) throw new Error(`nothing pending or approved with key ${unknown.join(', ')}`)

  let next: RulesFile = { ...file, rules: [...file.rules], vocabulary: [...file.vocabulary] }
  const approved: { key: string; id: string }[] = []
  const stamp = (rule: Rule): Rule => ({ ...rule, status: 'approved', muted: undefined, approved: { ...approval, hash: hashRule(rule) } })

  for (const key of wanted) {
    const existingIndex = next.rules.findIndex(r => r.id === key)
    if (existingIndex >= 0) {
      next.rules[existingIndex] = stamp(next.rules[existingIndex]!)
      approved.push({ key, id: key })
      continue
    }
    const p = pending.rules.find(r => r.key === key)!
    const id = nextRuleId(next)
    next.rules.push(stamp(RuleSchema.parse({ ...p.rule, id, status: 'approved' })))
    approved.push({ key, id })
  }

  const needed = keys === 'all' ? new Set(pending.vocabulary.map(v => v.id)) : vocabularyNeeded(next.rules, pending)
  next = { ...next, vocabulary: [...next.vocabulary, ...pending.vocabulary.filter(v => needed.has(v.id))] }
  const done = new Set(approved.map(a => a.key))
  return {
    file: next,
    pending: { ...pending, rules: pending.rules.filter(r => !done.has(r.key)), vocabulary: pending.vocabulary.filter(v => !needed.has(v.id)) },
    approved,
  }
}

function vocabularyNeeded(rules: Rule[], pending: PendingFile): Set<string> {
  const byId = new Map(pending.vocabulary.map(v => [v.id, v]))
  const needed = new Set<string>()
  const visit = (ids: string[]) => {
    for (const id of ids) {
      if (needed.has(id) || !byId.has(id)) continue
      needed.add(id)
      visit(collectRefs(byId.get(id)!.expr))
    }
  }
  for (const rule of rules) if ('requires' in rule) visit(collectRefs(rule.requires))
  return needed
}

export function reject(pending: PendingFile, keys: string[]): PendingFile {
  const unknown = keys.filter(k => !pending.rules.some(r => r.key === k))
  if (unknown.length > 0) throw new Error(`nothing pending with key ${unknown.join(', ')}`)
  return { ...pending, rules: pending.rules.filter(r => !keys.includes(r.key)) }
}

export function mute(file: RulesFile, id: string, m: { by: string; at: string; reason: string }): RulesFile {
  if (!file.rules.some(r => r.id === id)) throw new Error(`no rule ${id}`)
  return { ...file, rules: file.rules.map(r => (r.id === id ? { ...r, status: 'muted', muted: m } : r)) }
}

export type { ProposedRule }
```

Delete the trailing `export type { ProposedRule }` and the unused import if typecheck flags them.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/test/proposals.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core
git commit -m "feat(core): validate agent proposals and manage pending rules and approvals"
```

---

### Task 10: Inference prompt

**Files:**
- Create: `packages/core/src/prompt.ts`
- Test: `packages/core/test/prompt.test.ts`

**Interfaces:**
- Consumes: `Facts` (Task 4), `RulesFile` (Task 5), `formatExpr` (Task 2), `ProposalBatchSchema` (Task 9)
- Produces:
  - `proposalJsonSchema(): object` (JSON Schema of `ProposalBatchSchema` in input mode)
  - `condenseFacts(facts: Facts, opts?: { area?: string }): { title: string; lines: string[] }[]`
  - `buildInferPrompt(facts: Facts, file: RulesFile, opts?: { area?: string; budgetTokens?: number }): string`

- [ ] **Step 1: Write the failing tests**

`packages/core/test/prompt.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { parseFacts } from '../src/facts.js'
import { buildInferPrompt, condenseFacts, proposalJsonSchema } from '../src/prompt.js'
import { emptyRulesFile } from '../src/rules.js'

const facts = parseFacts({
  version: 1,
  symbols: [
    { id: 'ts:src/dogs#transfer', kind: 'function', lang: 'ts', location: { file: 'src/dogs.ts', line: 4 } },
    { id: 'ts:lib/x#y', kind: 'function', lang: 'ts', location: { file: 'lib/x.ts', line: 1 } },
  ],
  routes: [{ id: 'route:POST /dogs/:id/transfer', method: 'POST', path: '/dogs/:id/transfer', handler: 'ts:src/dogs#transfer', middleware: ['ts:src/mw#auth'], framework: 'express' }],
  guards: [{ at: 'route:POST /dogs/:id/transfer', requires: { atom: { op: 'in', left: 'actor.role', right: { literal: ['admin'] } } } }],
  dataOps: [{ in: 'ts:src/dogs#transfer', store: 'postgres', target: 'public.dogs', op: 'update', evidence: { file: 'src/dogs.ts', line: 9 } }],
  tables: [{ id: 'pg:public.dogs', name: 'public.dogs', columns: [{ name: 'team_id', type: 'uuid', nullable: false }], foreignKeys: [{ columns: ['team_id'], references: { table: 'public.teams', columns: ['id'] } }] }],
  policies: [{ id: 'firestore:/dogs/{d}#read', store: 'firestore', target: '/dogs/{d}', ops: ['read'], condition: { atom: { op: 'authenticated' } } }],
})

describe('condenseFacts', () => {
  it('summarizes routes, data access, tables and policies', () => {
    const text = condenseFacts(facts).map(s => `${s.title}\n${s.lines.join('\n')}`).join('\n')
    expect(text).toContain('POST /dogs/:id/transfer → ts:src/dogs#transfer; middleware ts:src/mw#auth; checks actor.role in ["admin"]')
    expect(text).toContain('public.dogs: update in ts:src/dogs#transfer')
    expect(text).toContain('team_id uuid not null → public.teams(id)')
    expect(text).toContain('firestore /dogs/{d}: read if authenticated')
  })
  it('filters by area', () => {
    const lines = condenseFacts(facts, { area: 'lib/' }).flatMap(s => s.lines)
    expect(lines.some(l => l.includes('transfer'))).toBe(false)
  })
})

describe('buildInferPrompt', () => {
  it('includes instructions, the schema and the facts', () => {
    const prompt = buildInferPrompt(facts, emptyRulesFile())
    expect(prompt).toContain('Return only JSON')
    expect(prompt).toContain('"vocabulary"')
    expect(prompt).toContain('POST /dogs/:id/transfer')
  })
  it('truncates to the budget and says how to narrow', () => {
    const prompt = buildInferPrompt(facts, emptyRulesFile(), { budgetTokens: 900 })
    expect(prompt).toMatch(/more not shown; use --area/)
  })
  it('exports a JSON schema', () => {
    expect(JSON.stringify(proposalJsonSchema())).toContain('"rules"')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/core/test/prompt.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`packages/core/src/prompt.ts`:
```ts
import { z } from 'zod'
import type { Facts } from './facts.js'
import { formatExpr } from './format.js'
import { ProposalBatchSchema } from './proposals.js'
import type { RulesFile } from './rules.js'

export function proposalJsonSchema(): object {
  return z.toJSONSchema(ProposalBatchSchema, { io: 'input' }) as object
}

const INSTRUCTIONS = `# Holdline: propose this codebase's business rules

You are reading a summary of a codebase produced by Holdline's analyzers. Propose the business
rules a careful senior engineer would want enforced on every future change: who may do what,
which records each user may read or write, which records must never be returned, which writes
must go through which service, and which data invariants must hold.

Guidelines:
- Propose 10 to 25 rules. Fewer, important rules beat many trivial ones.
- Write "text" in plain language a product owner can approve.
- Every rule needs "evidence": ids from the facts below that show the rule.
- Rule types: access (routes or symbols require a condition), data-access (database or Firestore
  policies require a condition), visibility (reads must filter), flow (writes must go through a
  symbol), invariant (schema constraints).
- When the code checks something through a helper (for example isAccountMember() or
  requireRole("admin")), add a "vocabulary" entry for it and use { "ref": "<id>" } in rules.
- Propose rules the code seems to intend even if the code breaks them; Holdline checks every
  proposal and shows broken ones to the user as questions.
- Do not repeat existing rules.
`

export function condenseFacts(facts: Facts, opts: { area?: string } = {}): { title: string; lines: string[] }[] {
  const fileOf = new Map(facts.symbols.map(s => [s.id, s.location?.file]))
  const inArea = (file: string | undefined) => !opts.area || (!!file && file.startsWith(opts.area))
  const guardsAt = (id: string) => facts.guards.filter(g => g.at === id).map(g => formatExpr(g.requires))

  const routes = facts.routes.filter(r => inArea(fileOf.get(r.handler))).map(r => {
    const checks = [r.id, ...r.middleware, r.handler].flatMap(guardsAt)
    const mw = r.middleware.length > 0 ? `; middleware ${r.middleware.join(', ')}` : ''
    return `${r.method} ${r.path} → ${r.handler}${mw}${checks.length > 0 ? `; checks ${checks.join(' and ')}` : '; no checks found'}`
  })

  const byTarget = new Map<string, string[]>()
  for (const op of facts.dataOps.filter(o => inArea(o.evidence?.file ?? fileOf.get(o.in)))) {
    const filter = op.filters ? ` (filters: ${formatExpr(op.filters)})` : ''
    byTarget.set(op.target, [...(byTarget.get(op.target) ?? []), `${op.op} in ${op.in}${filter}`])
  }
  const dataAccess = [...byTarget].map(([target, ops]) => `${target}: ${ops.join('; ')}`)

  const tables = facts.tables.filter(t => inArea(t.location?.file)).map(t => {
    const cols = t.columns.map(c => {
      const fk = t.foreignKeys.find(f => f.columns.length === 1 && f.columns[0] === c.name)
      const en = t.enums.find(e => e.column === c.name)
      return `${c.name} ${c.type}${c.nullable ? '' : ' not null'}${fk ? ` → ${fk.references.table}(${fk.references.columns.join(', ')})` : ''}${en ? ` in (${en.values.join(', ')})` : ''}`
    })
    const extra = [
      ...t.uniques.map(u => `unique(${u.join(', ')})`),
      ...t.checks.map(c => `check(${c.expr})`),
      `RLS ${t.rlsEnabled ? 'on' : 'off'}`,
    ]
    return `${t.name} [${t.id}]: ${[...cols, ...extra].join(', ')}`
  })

  const policies = facts.policies.filter(p => inArea(p.evidence?.file)).map(p =>
    `${p.store} ${p.target}: ${p.ops.join(', ')} if ${formatExpr(p.condition)} [${p.id}]`)
  const collections = facts.collections.map(c => `${c.path}${c.fields.length > 0 ? `: ${c.fields.join(', ')}` : ''}`)
  const ids = facts.symbols.filter(s => inArea(s.location?.file)).map(s => s.id)

  return [
    { title: '## Routes', lines: routes },
    { title: '## Data access', lines: dataAccess },
    { title: '## Tables', lines: tables },
    { title: '## Policies', lines: policies },
    { title: '## Collections', lines: collections },
    { title: '## Symbol ids (for evidence)', lines: ids },
  ].filter(s => s.lines.length > 0)
}

export function buildInferPrompt(facts: Facts, file: RulesFile, opts: { area?: string; budgetTokens?: number } = {}): string {
  const budgetChars = (opts.budgetTokens ?? 30_000) * 4
  const existing = file.rules.map(r => `- ${r.id} (${r.type}): ${r.text}`)
  const vocab = file.vocabulary.map(v => `- ${v.id}: ${v.text} = ${formatExpr(v.expr)}`)
  const header = [
    INSTRUCTIONS,
    '## Output',
    'Return only JSON matching this JSON Schema, with no prose around it:',
    '```json', JSON.stringify(proposalJsonSchema()), '```',
    existing.length > 0 ? `## Existing rules (do not repeat)\n${existing.join('\n')}` : '',
    vocab.length > 0 ? `## Existing vocabulary (reuse these ids)\n${vocab.join('\n')}` : '',
    '# Facts',
  ].filter(Boolean).join('\n')

  const out = [header]
  let used = header.length
  for (const section of condenseFacts(facts, opts)) {
    out.push(section.title)
    used += section.title.length + 1
    let shown = 0
    for (const line of section.lines) {
      if (used + line.length + 1 > budgetChars) break
      out.push(line)
      used += line.length + 1
      shown++
    }
    if (shown < section.lines.length) out.push(`… ${section.lines.length - shown} more not shown; use --area <path> to narrow`)
  }
  return out.join('\n')
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/test/prompt.test.ts && pnpm typecheck`
Expected: PASS. If `z.toJSONSchema` throws on the recursive `ExprSchema`, switch `ExprSchema` in `expr.ts` to zod 4's getter-based recursion (`get and() { return z.array(ExprSchema) }`) and rerun every core test.

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): build the inference prompt from condensed facts"
```

---

### Task 11: Analyzer contract, scan and file cache

**Files:**
- Create: `packages/core/src/analyzer.ts`, `packages/core/src/cache.ts`, `packages/core/src/scan.ts`
- Modify: `packages/core/src/index.ts` (public exports for everything so far)
- Test: `packages/core/test/scan.test.ts`

**Interfaces:**
- Consumes: `FactsInput`, `Facts`, `parseFacts`, `mergeFacts`, `emptyFacts` (Task 4), `sha256Hex` (Task 2)
- Produces:
  - `type AnalyzerOutput = Omit<FactsInput, 'version' | 'analyzers'>`
  - `interface AnalyzerContext { root: string; files: readonly string[]; cache: FileCache }`
  - `interface Analyzer { name: string; version: string; detect(root: string, files: readonly string[]): boolean | Promise<boolean>; analyze(ctx: AnalyzerContext): Promise<AnalyzerOutput> }`
  - `class FileCache { constructor(root: string); get<T>(analyzer: string, version: string, content: string): Promise<T | undefined>; set(analyzer: string, version: string, content: string, value: unknown): Promise<void> }`
  - `listFiles(root: string): Promise<string[]>` (relative paths, sorted)
  - `scan(root: string, analyzers: readonly Analyzer[]): Promise<{ facts: Facts; ran: string[] }>`
  - `factsCachePath(root: string): string` (`<root>/.holdline/cache/facts.json`)
  - Everything from Tasks 2 to 11 exported from `packages/core/src/index.ts`

- [ ] **Step 1: Write the failing tests**

`packages/core/test/scan.test.ts`:
```ts
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Analyzer } from '../src/analyzer.js'
import { FileCache } from '../src/cache.js'
import { listFiles, scan } from '../src/scan.js'

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holdline-scan-'))
  await mkdir(join(root, 'src'), { recursive: true })
  await mkdir(join(root, 'node_modules/x'), { recursive: true })
  await writeFile(join(root, 'src/a.ts'), 'export const a = 1')
  await writeFile(join(root, 'node_modules/x/index.js'), '')
  return root
}

describe('listFiles', () => {
  it('lists project files and skips dependencies and Holdline state', async () => {
    const root = await fixture()
    await mkdir(join(root, '.holdline/cache'), { recursive: true })
    await writeFile(join(root, '.holdline/cache/facts.json'), '{}')
    expect(await listFiles(root)).toEqual(['src/a.ts'])
  })
})

describe('scan', () => {
  it('runs detected analyzers and merges their facts', async () => {
    const root = await fixture()
    const ts: Analyzer = {
      name: 'fake-ts', version: '1',
      detect: (_r, files) => files.some(f => f.endsWith('.ts')),
      analyze: async ctx => ({ symbols: ctx.files.map(f => ({ id: `ts:${f}`, kind: 'function', lang: 'ts' })) }),
    }
    const py: Analyzer = { name: 'fake-py', version: '1', detect: () => false, analyze: async () => ({}) }
    const out = await scan(root, [ts, py])
    expect(out.ran).toEqual(['fake-ts'])
    expect(out.facts.analyzers).toEqual([{ name: 'fake-ts', version: '1' }])
    expect(out.facts.symbols.map(s => s.id)).toEqual(['ts:src/a.ts'])
  })
  it('turns an analyzer crash into an error diagnostic', async () => {
    const root = await fixture()
    const bad: Analyzer = { name: 'bad', version: '1', detect: () => true, analyze: async () => { throw new Error('boom') } }
    const out = await scan(root, [bad])
    expect(out.facts.diagnostics).toEqual([{ analyzer: 'bad', file: '', message: 'analyzer failed: boom', severity: 'error' }])
  })
  it('turns invalid analyzer output into an error diagnostic', async () => {
    const root = await fixture()
    const bad: Analyzer = { name: 'bad', version: '1', detect: () => true, analyze: async () => ({ routes: [{ nope: 1 }] }) as never }
    const out = await scan(root, [bad])
    expect(out.facts.diagnostics[0]!.message).toMatch(/invalid facts/)
  })
})

describe('FileCache', () => {
  it('stores values by analyzer, version and content', async () => {
    const root = await fixture()
    const cache = new FileCache(root)
    expect(await cache.get('ts', '1', 'abc')).toBeUndefined()
    await cache.set('ts', '1', 'abc', { n: 1 })
    expect(await cache.get('ts', '1', 'abc')).toEqual({ n: 1 })
    expect(await cache.get('ts', '2', 'abc')).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/core/test/scan.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`packages/core/src/analyzer.ts`:
```ts
import type { FileCache } from './cache.js'
import type { FactsInput } from './facts.js'

export type AnalyzerOutput = Omit<FactsInput, 'version' | 'analyzers'>

export interface AnalyzerContext {
  root: string
  files: readonly string[]
  cache: FileCache
}

export interface Analyzer {
  name: string
  version: string
  detect(root: string, files: readonly string[]): boolean | Promise<boolean>
  analyze(ctx: AnalyzerContext): Promise<AnalyzerOutput>
}
```

`packages/core/src/cache.ts`:
```ts
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { sha256Hex } from './canonical.js'

export class FileCache {
  constructor(private readonly root: string) {}

  private path(analyzer: string, version: string, content: string): string {
    return join(this.root, '.holdline/cache/files', analyzer, `${sha256Hex(`${version}\0${content}`)}.json`)
  }

  async get<T>(analyzer: string, version: string, content: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(this.path(analyzer, version, content), 'utf8')) as T
    } catch {
      return undefined
    }
  }

  async set(analyzer: string, version: string, content: string, value: unknown): Promise<void> {
    const p = this.path(analyzer, version, content)
    await mkdir(dirname(p), { recursive: true })
    await writeFile(p, JSON.stringify(value))
  }
}
```

`packages/core/src/scan.ts`:
```ts
import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { promisify } from 'node:util'
import type { Analyzer } from './analyzer.js'
import { FileCache } from './cache.js'
import { FactsError, emptyFacts, mergeFacts, parseFacts, type Facts } from './facts.js'

const SKIP = new Set(['node_modules', '.git', '.holdline', 'dist', 'build', '.venv', 'vendor', '.next', '.svelte-kit'])

export function factsCachePath(root: string): string {
  return join(root, '.holdline/cache/facts.json')
}

export async function listFiles(root: string): Promise<string[]> {
  try {
    const { stdout } = await promisify(execFile)('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, maxBuffer: 64 * 1024 * 1024 })
    const files = stdout.split('\n').filter(f => f && !f.split('/').some(part => SKIP.has(part)))
    if (files.length > 0) return files.sort()
  } catch {
    // not a git repository: walk the tree
  }
  const out: string[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile()) out.push(relative(root, full))
    }
  }
  await walk(root)
  return out.sort()
}

export async function scan(root: string, analyzers: readonly Analyzer[]): Promise<{ facts: Facts; ran: string[] }> {
  const files = await listFiles(root)
  const cache = new FileCache(root)
  const parts: Facts[] = []
  const ran: string[] = []
  for (const analyzer of analyzers) {
    if (!(await analyzer.detect(root, files))) continue
    ran.push(analyzer.name)
    const diagnostic = (message: string) => ({ ...emptyFacts(), diagnostics: [{ analyzer: analyzer.name, file: '', message, severity: 'error' as const }] })
    try {
      const output = await analyzer.analyze({ root, files, cache })
      parts.push(parseFacts({ version: 1, ...output, analyzers: [{ name: analyzer.name, version: analyzer.version }] }, analyzer.name))
    } catch (e) {
      parts.push(e instanceof FactsError ? diagnostic(`invalid facts: ${e.message}`) : diagnostic(`analyzer failed: ${(e as Error).message}`))
    }
  }
  return { facts: mergeFacts(parts), ran }
}
```

`packages/core/src/index.ts` (replace the Task 1 placeholder):
```ts
export const HOLDLINE_FACTS_VERSION = 1
export * from './analyzer.js'
export * from './cache.js'
export * from './canonical.js'
export * from './check/run.js'
export * from './check/types.js'
export * from './expr.js'
export * from './fact-index.js'
export * from './facts.js'
export * from './format.js'
export * from './hash.js'
export * from './logic.js'
export * from './paths.js'
export * from './pending.js'
export * from './prompt.js'
export * from './proposals.js'
export * from './results.js'
export * from './rules.js'
export * from './scan.js'
export * from './testcase.js'
export * from './testgen.js'
```

- [ ] **Step 4: Run all core tests and typecheck**

Run: `pnpm vitest run packages/core && pnpm typecheck`
Expected: PASS for every core test file.

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): add analyzer contract, scan orchestration and file cache"
```

---

### Task 12: CLI foundation: main, workspace, check, explain, mute

**Files:**
- Create: `packages/cli/src/bin.ts`, `packages/cli/src/main.ts`, `packages/cli/src/io.ts`, `packages/cli/src/workspace.ts`, `packages/cli/src/analyzers.ts`, `packages/cli/src/format/human.ts`, `packages/cli/src/format/agent.ts`, `packages/cli/src/format/json.ts`, `packages/cli/src/commands/check.ts`, `packages/cli/src/commands/explain.ts`, `packages/cli/src/commands/mute.ts`
- Test: `packages/cli/test/check.test.ts`, `packages/cli/test/helpers/project.ts`

**Interfaces:**
- Consumes: everything exported from `@holdline/core`
- Produces:
  - `type Io = { cwd: string; env: Record<string, string | undefined>; stdout(text: string): void; stderr(text: string): void; stdin?: NodeJS.ReadableStream; now?: () => Date }`
  - `main(argv: string[], io: Io): Promise<number>` (argv without `node` and script, e.g. `['check', '--format', 'json']`)
  - `class UsageError extends Error`
  - Workspace: `rulesPath(root)`, `pendingPath(root)`, `testsDir(root)`, `loadRules(root): Promise<RulesFile>`, `saveRules(root, file)`, `loadPending(root)`, `savePending(root, p)`, `loadFacts(root, factsFile?: string): Promise<Facts>`, `approver(io: Io): string`, `today(io: Io): string`
  - `analyzers: Analyzer[]` (empty in Phase 0; analyzer tracks append to it)
  - Formatters: `formatHuman(results, summary): string`, `formatAgent(results, summary): string`, `formatJson(results, summary): string`
  - Test helper `makeProject(files: Record<string, string>): Promise<string>` and `runCli(argv: string[], opts?: { cwd?: string; stdin?: string }): Promise<{ code: number; stdout: string; stderr: string }>`

- [ ] **Step 1: Write the test helper and failing tests**

`packages/cli/test/helpers/project.ts`:
```ts
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { main } from '../../src/main.js'

export async function makeProject(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holdline-cli-'))
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }
  return root
}

export async function runCli(argv: string[], opts: { cwd: string; stdin?: string }): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = ''
  let stderr = ''
  const code = await main(argv, {
    cwd: opts.cwd,
    env: { HOLDLINE_USER: 'tester' },
    stdout: t => { stdout += t },
    stderr: t => { stderr += t },
    stdin: opts.stdin === undefined ? undefined : Readable.from([opts.stdin]),
    now: () => new Date('2026-10-21T12:00:00Z'),
  })
  return { code, stdout, stderr }
}
```

`packages/cli/test/check.test.ts`:
```ts
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { RuleSchema, hashRule, serializeRulesFile, type RulesFile } from '@holdline/core'
import { describe, expect, it } from 'vitest'
import { makeProject, runCli } from './helpers/project.js'

const auth = { atom: { op: 'authenticated' } }
const admin = { atom: { op: 'in', left: 'actor.role', right: { literal: ['admin'] } } }

function rulesFile(requires: unknown): string {
  const rule = RuleSchema.parse({ id: 'R-001', text: 'Only admins transfer dogs', type: 'access', target: { routes: 'POST /dogs/*/transfer' }, requires, evidence: ['h:transfer'], status: 'approved' })
  const file: RulesFile = { version: 1, vocabulary: [], rules: [{ ...rule, approved: { by: 't', at: '2026-10-21', hash: hashRule(rule) } }] }
  return serializeRulesFile(file)
}

const facts = JSON.stringify({
  version: 1,
  symbols: [{ id: 'h:transfer', kind: 'function', lang: 'ts', location: { file: 'src/dogs.ts', line: 40 } }],
  routes: [{ id: 'route:POST /dogs/:id/transfer', method: 'POST', path: '/dogs/:id/transfer', handler: 'h:transfer', framework: 'express' }],
  guards: [{ at: 'h:transfer', requires: auth }],
})

describe('holdline check', () => {
  it('exits 0 when every rule passes', async () => {
    const root = await makeProject({ 'holdline.rules': rulesFile(auth), 'facts.json': facts })
    const out = await runCli(['check', '--facts', 'facts.json'], { cwd: root })
    expect(out.code).toBe(0)
    expect(out.stdout).toContain('✓ 1 rule passes')
  })
  it('exits 1 and explains the violation in human format', async () => {
    const root = await makeProject({ 'holdline.rules': rulesFile(admin), 'facts.json': facts })
    const out = await runCli(['check', '--facts', 'facts.json'], { cwd: root })
    expect(out.code).toBe(1)
    expect(out.stdout).toContain('✗ R-001 Only admins transfer dogs')
    expect(out.stdout).toContain('POST /dogs/:id/transfer does not check actor.role in ["admin"]')
    expect(out.stdout).toContain('src/dogs.ts:40')
  })
  it('prints agent feedback', async () => {
    const root = await makeProject({ 'holdline.rules': rulesFile(admin), 'facts.json': facts })
    const out = await runCli(['check', '--facts', 'facts.json', '--format', 'agent'], { cwd: root })
    expect(out.stdout).toContain('Holdline: 1 approved rule is broken.')
    expect(out.stdout).toContain('Do not edit holdline.rules')
  })
  it('prints JSON', async () => {
    const root = await makeProject({ 'holdline.rules': rulesFile(admin), 'facts.json': facts })
    const out = await runCli(['check', '--facts', 'facts.json', '--format', 'json'], { cwd: root })
    const parsed = JSON.parse(out.stdout)
    expect(parsed.summary.violation).toBe(1)
    expect(parsed.results[0].rule).toBe('R-001')
  })
  it('treats stale as failure only with --strict', async () => {
    const stale = rulesFile(auth).replace('POST /dogs/*/transfer', 'POST /cats/*/transfer')
    const root = await makeProject({ 'holdline.rules': stale, 'facts.json': facts })
    expect((await runCli(['check', '--facts', 'facts.json'], { cwd: root })).code).toBe(0)
    expect((await runCli(['check', '--facts', 'facts.json', '--strict'], { cwd: root })).code).toBe(1)
  })
  it('exits 2 on a malformed rules file and 2 on bad facts', async () => {
    const bad = await makeProject({ 'holdline.rules': 'rules: [', 'facts.json': facts })
    const out = await runCli(['check', '--facts', 'facts.json'], { cwd: bad })
    expect(out.code).toBe(2)
    expect(out.stderr).toContain('invalid YAML')
    const badFacts = await makeProject({ 'holdline.rules': rulesFile(auth), 'facts.json': '{"version":9}' })
    expect((await runCli(['check', '--facts', 'facts.json'], { cwd: badFacts })).code).toBe(2)
  })
  it('exits 2 on an unknown command', async () => {
    const root = await makeProject({})
    expect((await runCli(['frobnicate'], { cwd: root })).code).toBe(2)
  })
})

describe('holdline explain and mute', () => {
  it('explains a rule with its status and evidence', async () => {
    const root = await makeProject({ 'holdline.rules': rulesFile(admin), 'facts.json': facts })
    const out = await runCli(['explain', 'R-001', '--facts', 'facts.json'], { cwd: root })
    expect(out.code).toBe(0)
    expect(out.stdout).toContain('R-001 Only admins transfer dogs')
    expect(out.stdout).toContain('approved by t on 2026-10-21')
    expect(out.stdout).toContain('evidence: h:transfer (src/dogs.ts:40)')
    expect(out.stdout).toContain('violation')
  })
  it('mutes a rule with a reason', async () => {
    const root = await makeProject({ 'holdline.rules': rulesFile(admin), 'facts.json': facts })
    expect((await runCli(['mute', 'R-001'], { cwd: root })).code).toBe(2)
    const out = await runCli(['mute', 'R-001', '--reason', 'migrating auth'], { cwd: root })
    expect(out.code).toBe(0)
    const saved = await readFile(join(root, 'holdline.rules'), 'utf8')
    expect(saved).toContain('reason: migrating auth')
    expect(saved).toContain('by: tester')
    expect((await runCli(['check', '--facts', 'facts.json'], { cwd: root })).code).toBe(0)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/cli/test/check.test.ts`
Expected: FAIL, cannot find `../../src/main.js`.

- [ ] **Step 3: Implement `io.ts`, `analyzers.ts` and `workspace.ts`**

`packages/cli/src/io.ts`:
```ts
export type Io = {
  cwd: string
  env: Record<string, string | undefined>
  stdout(text: string): void
  stderr(text: string): void
  stdin?: NodeJS.ReadableStream
  now?: () => Date
}

export class UsageError extends Error {}
```

`packages/cli/src/analyzers.ts`:
```ts
import type { Analyzer } from '@holdline/core'

// Phase 1 and 2 analyzer packages register here.
export const analyzers: Analyzer[] = []
```

`packages/cli/src/workspace.ts`:
```ts
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import {
  emptyPending, emptyRulesFile, factsCachePath, parseFacts, parsePendingFile, parseRulesFile, scan,
  serializePendingFile, serializeRulesFile, type Facts, type PendingFile, type RulesFile,
} from '@holdline/core'
import { analyzers } from './analyzers.js'
import { UsageError, type Io } from './io.js'

export const rulesPath = (root: string) => join(root, 'holdline.rules')
export const pendingPath = (root: string) => join(root, '.holdline/pending.yaml')
export const testsDir = (root: string) => join(root, '.holdline/tests')

async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw e
  }
}

export async function writeFileEnsured(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

export async function loadRules(root: string): Promise<RulesFile> {
  const text = await readIfExists(rulesPath(root))
  return text === undefined ? emptyRulesFile() : parseRulesFile(text)
}

export const saveRules = (root: string, file: RulesFile) => writeFileEnsured(rulesPath(root), serializeRulesFile(file))

export async function loadPending(root: string): Promise<PendingFile> {
  const text = await readIfExists(pendingPath(root))
  return text === undefined ? emptyPending() : parsePendingFile(text)
}

export const savePending = (root: string, p: PendingFile) => writeFileEnsured(pendingPath(root), serializePendingFile(p))

export async function loadFacts(root: string, factsFile?: string): Promise<Facts> {
  if (factsFile) {
    const path = isAbsolute(factsFile) ? factsFile : join(root, factsFile)
    const text = await readIfExists(path)
    if (text === undefined) throw new UsageError(`facts file not found: ${factsFile}`)
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch (e) {
      throw new UsageError(`${factsFile}: invalid JSON: ${(e as Error).message}`)
    }
    return parseFacts(json, factsFile)
  }
  const { facts } = await scan(root, analyzers)
  await writeFileEnsured(factsCachePath(root), JSON.stringify(facts, null, 2))
  return facts
}

export function approver(io: Io): string {
  if (io.env.HOLDLINE_USER) return io.env.HOLDLINE_USER
  try {
    const name = execFileSync('git', ['config', 'user.name'], { cwd: io.cwd, encoding: 'utf8' }).trim()
    if (name) return name
  } catch {
    // no git identity
  }
  return io.env.USER ?? 'unknown'
}

export const today = (io: Io) => (io.now?.() ?? new Date()).toISOString().slice(0, 10)
```

- [ ] **Step 4: Implement the formatters**

`packages/cli/src/format/human.ts`:
```ts
import { formatExpr, type Result, type Summary } from '@holdline/core'

const MARK: Record<Result['status'], string> = { pass: '✓', violation: '✗', stale: '!', unknown: '?', 'unapproved-edit': '✗' }

export function where(r: Result): string {
  if (!r.at) return ''
  return r.at.file ? `${r.at.file}${r.at.line ? `:${r.at.line}` : ''}` : r.at.symbol
}

export function formatHuman(results: Result[], summary: Summary, texts: Map<string, string>): string {
  const lines: string[] = []
  for (const r of results.filter(x => x.status !== 'pass')) {
    lines.push(`${MARK[r.status]} ${r.rule} ${texts.get(r.rule) ?? ''}  [${r.status}]`)
    lines.push(`    ${r.message}`)
    if (where(r)) lines.push(`    at ${where(r)}`)
    if (r.unproven) lines.push(`    missing: ${formatExpr(r.unproven)}`)
    if (r.fix) lines.push(`    fix: ${r.fix}`)
  }
  const failing = summary.rules - summary.pass
  if (failing === 0) {
    lines.push(`✓ ${summary.pass} ${summary.pass === 1 ? 'rule passes' : 'rules pass'}${summary.muted ? ` (${summary.muted} muted)` : ''}`)
  } else {
    lines.push(`${summary.rules} rules: ${summary.pass} pass, ${summary.violation} violation, ${summary.stale} stale, ${summary.unknown} unknown, ${summary['unapproved-edit']} unapproved edit, ${summary.muted} muted`)
  }
  return `${lines.join('\n')}\n`
}
```

`packages/cli/src/format/agent.ts`:
```ts
import { formatExpr, type Result, type Summary } from '@holdline/core'
import { where } from './human.js'

export function formatAgent(results: Result[], summary: Summary, texts: Map<string, string>): string {
  const failing = results.filter(r => r.status === 'violation' || r.status === 'unapproved-edit')
  if (failing.length === 0) return `Holdline: all ${summary.pass} approved rules pass.\n`
  const rules = new Set(failing.map(r => r.rule)).size
  const lines = [
    `Holdline: ${rules} approved ${rules === 1 ? 'rule is' : 'rules are'} broken. Fix the code so the rules hold again. Do not edit holdline.rules.`,
  ]
  for (const r of failing) {
    const loc = where(r) ? ` at ${where(r)}` : ''
    const missing = r.unproven ? ` Missing: ${formatExpr(r.unproven)}.` : ''
    const fix = r.fix ? ` Fix: ${r.fix}` : ''
    lines.push(`- ${r.rule} "${texts.get(r.rule) ?? ''}"${loc}: ${r.message}.${missing}${fix}`)
  }
  lines.push('If this behavior change is intended, stop and ask the user to approve a rule change (holdline propose, then holdline approve).')
  return `${lines.join('\n')}\n`
}
```

`packages/cli/src/format/json.ts`:
```ts
import type { Result, Summary } from '@holdline/core'

export function formatJson(results: Result[], summary: Summary): string {
  return `${JSON.stringify({ summary, results }, null, 2)}\n`
}
```

- [ ] **Step 5: Implement the commands**

`packages/cli/src/commands/check.ts`:
```ts
import { runChecks, summarize } from '@holdline/core'
import { formatAgent } from '../format/agent.js'
import { formatHuman } from '../format/human.js'
import { formatJson } from '../format/json.js'
import { UsageError, type Io } from '../io.js'
import { loadFacts, loadRules } from '../workspace.js'

export type CheckOptions = { facts?: string; format: string; strict?: boolean; rule?: string[] }

export async function checkCommand(opts: CheckOptions, io: Io): Promise<number> {
  if (!['human', 'agent', 'json'].includes(opts.format)) throw new UsageError(`unknown format ${opts.format}: use human, agent or json`)
  const file = await loadRules(io.cwd)
  const facts = await loadFacts(io.cwd, opts.facts)
  const { results, muted } = runChecks(facts, file, { only: opts.rule })
  const summary = summarize(results, muted)
  const texts = new Map(file.rules.map(r => [r.id, r.text]))
  const out = opts.format === 'json' ? formatJson(results, summary)
    : opts.format === 'agent' ? formatAgent(results, summary, texts)
    : formatHuman(results, summary, texts)
  io.stdout(out)
  const failed = summary.violation + summary['unapproved-edit'] > 0
  const strictFailed = !!opts.strict && summary.stale + summary.unknown > 0
  return failed || strictFailed ? 1 : 0
}
```

`packages/cli/src/commands/explain.ts`:
```ts
import { FactIndex, checkRule, formatExpr, hashRule, vocabularyMap } from '@holdline/core'
import YAML from 'yaml'
import { UsageError, type Io } from '../io.js'
import { loadFacts, loadRules } from '../workspace.js'
import { where } from '../format/human.js'

export async function explainCommand(id: string, opts: { facts?: string }, io: Io): Promise<number> {
  const file = await loadRules(io.cwd)
  const rule = file.rules.find(r => r.id === id)
  if (!rule) throw new UsageError(`no rule ${id}`)
  const facts = await loadFacts(io.cwd, opts.facts)
  const index = new FactIndex(facts)
  const lines = [`${rule.id} ${rule.text}`, `type: ${rule.type}`]
  if ('requires' in rule) lines.push(`requires: ${formatExpr(rule.requires)}`)
  if (rule.status === 'muted' && rule.muted) lines.push(`muted by ${rule.muted.by} on ${rule.muted.at}: ${rule.muted.reason}`)
  if (rule.approved) {
    const edited = rule.approved.hash !== hashRule(rule) ? ' (edited since approval)' : ''
    lines.push(`approved by ${rule.approved.by} on ${rule.approved.at}${edited}`)
  } else {
    lines.push('not approved')
  }
  for (const ev of rule.evidence) {
    const at = index.at(ev)
    lines.push(`evidence: ${ev}${at.file ? ` (${at.file}${at.line ? `:${at.line}` : ''})` : ''}`)
  }
  for (const r of checkRule(rule, { index, vocab: vocabularyMap(file) })) {
    lines.push(`${r.status}: ${r.message}${where(r) ? ` at ${where(r)}` : ''}`)
  }
  lines.push('', YAML.stringify(rule, { lineWidth: 0 }).trimEnd())
  io.stdout(`${lines.join('\n')}\n`)
  return 0
}
```

`packages/cli/src/commands/mute.ts`:
```ts
import { mute } from '@holdline/core'
import { UsageError, type Io } from '../io.js'
import { approver, loadRules, saveRules, today } from '../workspace.js'

export async function muteCommand(id: string, opts: { reason?: string }, io: Io): Promise<number> {
  if (!opts.reason) throw new UsageError('mute needs --reason "<why>"')
  const file = await loadRules(io.cwd)
  if (!file.rules.some(r => r.id === id)) throw new UsageError(`no rule ${id}`)
  await saveRules(io.cwd, mute(file, id, { by: approver(io), at: today(io), reason: opts.reason }))
  io.stdout(`Muted ${id}: ${opts.reason}\n`)
  return 0
}
```

- [ ] **Step 6: Implement `main.ts` and `bin.ts`**

`packages/cli/src/main.ts`:
```ts
import { FactsError, ProposalError, RulesFileError } from '@holdline/core'
import { Command, CommanderError } from 'commander'
import { checkCommand } from './commands/check.js'
import { explainCommand } from './commands/explain.js'
import { muteCommand } from './commands/mute.js'
import { UsageError, type Io } from './io.js'

export type { Io } from './io.js'

export async function main(argv: string[], io: Io): Promise<number> {
  let code = 0
  const program = new Command('holdline')
    .description('Find, approve and enforce the business rules in your codebase')
    .exitOverride()
    .configureOutput({ writeOut: t => io.stdout(t), writeErr: t => io.stderr(t) })
    .showHelpAfterError()

  const run = (fn: () => Promise<number>) => async () => { code = await fn() }

  program.command('check')
    .description('Check approved rules against the code')
    .option('--facts <file>', 'use a facts file instead of scanning')
    .option('--format <format>', 'human, agent or json', 'human')
    .option('--strict', 'also fail on stale or unknown rules')
    .option('--rule <ids...>', 'only these rules')
    .action((opts) => run(() => checkCommand(opts, io))())

  program.command('explain <id>')
    .description('Show a rule, its evidence and its current status')
    .option('--facts <file>', 'use a facts file instead of scanning')
    .action((id: string, opts) => run(() => explainCommand(id, opts, io))())

  program.command('mute <id>')
    .description('Turn a rule off, recording why')
    .option('--reason <reason>', 'why the rule is muted')
    .action((id: string, opts) => run(() => muteCommand(id, opts, io))())

  try {
    await program.parseAsync(argv, { from: 'user' })
    return code
  } catch (e) {
    if (e instanceof CommanderError) return e.exitCode === 0 ? 0 : 2
    if (e instanceof UsageError || e instanceof RulesFileError || e instanceof FactsError || e instanceof ProposalError) {
      io.stderr(`holdline: ${e.message}\n`)
      return 2
    }
    io.stderr(`holdline: internal error: ${(e as Error).stack ?? String(e)}\n`)
    return 3
  }
}
```

Note: commander calls `.action` handlers and awaits them under `parseAsync` when the handler returns a promise. The `run(...)()` wrapper returns that promise so errors reach the `catch`.

`packages/cli/src/bin.ts`:
```ts
import { main } from './main.js'

const code = await main(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  stdout: t => process.stdout.write(t),
  stderr: t => process.stderr.write(t),
  stdin: process.stdin,
})
process.exitCode = code
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm vitest run packages/cli && pnpm typecheck`
Expected: PASS.

- [ ] **Step 8: Smoke-test the binary**

Run: `pnpm holdline --help`
Expected: usage text listing `check`, `explain`, `mute`; exit 0.

- [ ] **Step 9: Commit**

```bash
git add packages/cli
git commit -m "feat(cli): add check, explain and mute commands with human, agent and json output"
```

---

### Task 13: CLI: scan, infer, propose, approve, reject, review

**Files:**
- Create: `packages/cli/src/commands/scan.ts`, `packages/cli/src/commands/infer.ts`, `packages/cli/src/commands/propose.ts`, `packages/cli/src/commands/approve.ts`, `packages/cli/src/commands/review.ts`
- Modify: `packages/cli/src/main.ts` (register the commands)
- Test: `packages/cli/test/flow.test.ts`

**Interfaces:**
- Consumes: workspace helpers and `Io` (Task 12); `scan`, `buildInferPrompt`, `validateProposals`, `addToPending`, `approve`, `reject`, `generateTests`, `serializeTestFile`, `vocabularyMap` from core
- Produces: commands `scan`, `infer --prompt [--area] [--budget] [--facts]`, `propose <file|-> [--facts] [--limit]`, `approve [keys...] [--all]`, `reject <keys...>`, `review` (reads `a`, `r`, `s`, `q` answers line by line from stdin)
- Side effects: `approve` writes `.holdline/tests/<rule-id>.yaml` for each newly approved rule that `generateTests` supports.

- [ ] **Step 1: Write the failing tests**

`packages/cli/test/flow.test.ts`:
```ts
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeProject, runCli } from './helpers/project.js'

const facts = JSON.stringify({
  version: 1,
  symbols: [
    { id: 'h:transfer', kind: 'function', lang: 'ts', location: { file: 'src/dogs.ts', line: 40 } },
    { id: 'h:archive', kind: 'function', lang: 'ts', location: { file: 'src/dogs.ts', line: 60 } },
  ],
  routes: [
    { id: 'route:POST /dogs/:id/transfer', method: 'POST', path: '/dogs/:id/transfer', handler: 'h:transfer', framework: 'express' },
    { id: 'route:POST /dogs/:id/archive', method: 'POST', path: '/dogs/:id/archive', handler: 'h:archive', framework: 'express' },
  ],
  guards: [{ at: 'h:transfer', requires: { ref: 'staff' } }],
  policies: [{ id: 'firestore:/dogs/{d}#read', store: 'firestore', target: '/dogs/{d}', ops: ['read'], condition: { atom: { op: 'authenticated' } }, evidence: { file: 'firestore.rules', line: 5 } }],
})

const proposals = JSON.stringify({
  vocabulary: [{ id: 'staff', text: 'Caller is staff', expr: { atom: { op: 'in', left: 'actor.role', right: { literal: ['admin'] } } } }],
  rules: [
    { text: 'Only staff transfer dogs', type: 'access', target: { routes: 'POST /dogs/*/transfer' }, requires: { ref: 'staff' }, evidence: ['h:transfer'] },
    { text: 'Only staff archive dogs', type: 'access', target: { routes: 'POST /dogs/*/archive' }, requires: { ref: 'staff' }, evidence: ['h:archive'] },
    { text: 'Signed-in users read dogs', type: 'data-access', target: { store: 'firestore', path: '/dogs/{dogId}' }, ops: ['read'], requires: { atom: { op: 'authenticated' } }, evidence: ['firestore:/dogs/{d}#read'] },
    { text: 'Cats', type: 'access', target: { routes: 'GET /cats' }, requires: { atom: { op: 'authenticated' } } },
  ],
})

describe('inference flow', () => {
  it('infer --prompt prints the prompt and requires --prompt', async () => {
    const root = await makeProject({ 'facts.json': facts })
    const out = await runCli(['infer', '--prompt', '--facts', 'facts.json'], { cwd: root })
    expect(out.code).toBe(0)
    expect(out.stdout).toContain('POST /dogs/:id/transfer')
    expect((await runCli(['infer', '--facts', 'facts.json'], { cwd: root })).code).toBe(2)
  })

  it('propose → approve → check, with generated tests', async () => {
    const root = await makeProject({ 'facts.json': facts, 'proposals.json': proposals })
    const proposed = await runCli(['propose', 'proposals.json', '--facts', 'facts.json'], { cwd: root })
    expect(proposed.code).toBe(0)
    expect(proposed.stdout).toContain('P-1 broken  Only staff archive dogs')
    expect(proposed.stdout).toContain('rejected  Cats: target not found')

    const approved = await runCli(['approve', '--all'], { cwd: root })
    expect(approved.code).toBe(0)
    expect(approved.stdout).toContain('P-1 → R-001')
    const rules = await readFile(join(root, 'holdline.rules'), 'utf8')
    expect(rules).toContain('by: tester')
    expect(rules).toContain('id: staff')
    expect(await readdir(join(root, '.holdline/tests'))).toEqual(['R-003.yaml'])

    const check = await runCli(['check', '--facts', 'facts.json'], { cwd: root })
    expect(check.code).toBe(1)
    expect(check.stdout).toContain('POST /dogs/:id/archive does not check staff')
  })

  it('propose reads stdin with "-" and reports invalid JSON as a usage error', async () => {
    const root = await makeProject({ 'facts.json': facts })
    expect((await runCli(['propose', '-', '--facts', 'facts.json'], { cwd: root, stdin: proposals })).code).toBe(0)
    expect((await runCli(['propose', '-', '--facts', 'facts.json'], { cwd: root, stdin: 'not json' })).code).toBe(2)
  })

  it('reject removes pending rules', async () => {
    const root = await makeProject({ 'facts.json': facts, 'proposals.json': proposals })
    await runCli(['propose', 'proposals.json', '--facts', 'facts.json'], { cwd: root })
    expect((await runCli(['reject', 'P-1'], { cwd: root })).code).toBe(0)
    const out = await runCli(['approve', 'P-1'], { cwd: root })
    expect(out.code).toBe(2)
  })

  it('review approves, rejects and skips from answers on stdin', async () => {
    const root = await makeProject({ 'facts.json': facts, 'proposals.json': proposals })
    await runCli(['propose', 'proposals.json', '--facts', 'facts.json'], { cwd: root })
    const out = await runCli(['review'], { cwd: root, stdin: 'a\nr\ns\n' })
    expect(out.code).toBe(0)
    expect(out.stdout).toContain('Approved P-1 as R-001')
    expect(out.stdout).toContain('Rejected P-2')
    const pending = await readFile(join(root, '.holdline/pending.yaml'), 'utf8')
    expect(pending).toContain('key: P-3')
  })

  it('scan with no analyzers writes empty facts and says so', async () => {
    const root = await makeProject({ 'src/a.ts': 'export {}' })
    const out = await runCli(['scan'], { cwd: root })
    expect(out.code).toBe(0)
    expect(out.stdout).toContain('No analyzer recognized this project')
    expect(JSON.parse(await readFile(join(root, '.holdline/cache/facts.json'), 'utf8')).version).toBe(1)
  })
})
```

The expected pending order is: `P-1` broken archive rule, `P-2` transfer rule (holds, one evidence), `P-3` data-access rule (holds, one evidence). Broken ranks first; ties keep the agent's order. After `approve --all` the ids follow pending order: `R-001` archive, `R-002` transfer, `R-003` data-access (the only one with generated tests).

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/cli/test/flow.test.ts`
Expected: FAIL, unknown commands exit 2.

- [ ] **Step 3: Implement the commands**

`packages/cli/src/commands/scan.ts`:
```ts
import { factsCachePath, scan } from '@holdline/core'
import { relative } from 'node:path'
import { analyzers } from '../analyzers.js'
import type { Io } from '../io.js'
import { writeFileEnsured } from '../workspace.js'

export async function scanCommand(io: Io): Promise<number> {
  const { facts, ran } = await scan(io.cwd, analyzers)
  const path = factsCachePath(io.cwd)
  await writeFileEnsured(path, JSON.stringify(facts, null, 2))
  if (ran.length === 0) {
    io.stdout(`No analyzer recognized this project. Wrote empty facts to ${relative(io.cwd, path)}.\n`)
    return 0
  }
  const errors = facts.diagnostics.filter(d => d.severity === 'error').length
  io.stdout(`Scanned with ${ran.join(', ')}: ${facts.routes.length} routes, ${facts.dataOps.length} data operations, ${facts.tables.length} tables, ${facts.policies.length} policies${errors ? `, ${errors} errors` : ''}.\n`)
  return errors > 0 ? 3 : 0
}
```

`packages/cli/src/commands/infer.ts`:
```ts
import { buildInferPrompt } from '@holdline/core'
import { UsageError, type Io } from '../io.js'
import { loadFacts, loadRules } from '../workspace.js'

export async function inferCommand(opts: { prompt?: boolean; area?: string; budget?: string; facts?: string }, io: Io): Promise<number> {
  if (!opts.prompt) throw new UsageError('holdline infer only prints a prompt for your agent: run `holdline infer --prompt`')
  const budget = opts.budget ? Number(opts.budget) : undefined
  if (budget !== undefined && !(budget > 0)) throw new UsageError('--budget must be a positive number of tokens')
  const facts = await loadFacts(io.cwd, opts.facts)
  io.stdout(`${buildInferPrompt(facts, await loadRules(io.cwd), { area: opts.area, budgetTokens: budget })}\n`)
  return 0
}
```

`packages/cli/src/commands/propose.ts`:
```ts
import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { addToPending, validateProposals } from '@holdline/core'
import { UsageError, type Io } from '../io.js'
import { loadFacts, loadPending, loadRules, savePending } from '../workspace.js'

async function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  let text = ''
  for await (const chunk of stream) text += String(chunk)
  return text
}

export async function proposeCommand(source: string, opts: { facts?: string; limit?: string }, io: Io): Promise<number> {
  let text: string
  if (source === '-') {
    if (!io.stdin) throw new UsageError('no stdin to read proposals from')
    text = await readStream(io.stdin)
  } else {
    text = await readFile(isAbsolute(source) ? source : join(io.cwd, source), 'utf8')
  }
  let json: unknown
  try {
    json = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''))
  } catch (e) {
    throw new UsageError(`proposals are not valid JSON: ${(e as Error).message}`)
  }
  const file = await loadRules(io.cwd)
  const facts = await loadFacts(io.cwd, opts.facts)
  const report = validateProposals(json, facts, file, { limit: opts.limit ? Number(opts.limit) : undefined })
  const { pending, added } = addToPending(await loadPending(io.cwd), report)
  await savePending(io.cwd, pending)

  const lines: string[] = []
  for (const p of added) {
    lines.push(`${p.key} ${p.classification === 'broken' ? 'broken' : 'holds '}  ${p.rule.text}`)
    for (const v of p.violations) lines.push(`      ${v}`)
  }
  for (const r of report.rules.filter(o => o.classification === 'rejected')) {
    lines.push(`rejected  ${r.rule?.text ?? 'invalid proposal'}: ${r.reason}`)
  }
  for (const v of report.vocabulary.filter(x => !x.accepted)) lines.push(`rejected vocabulary: ${v.reason}`)
  if (report.dropped > 0) lines.push(`${report.dropped} lower-ranked proposals dropped (limit ${opts.limit ?? 25})`)
  lines.push(`Review with \`holdline review\`, or \`holdline approve <keys>\` / \`holdline approve --all\`.`)
  io.stdout(`${lines.join('\n')}\n`)
  return 0
}
```

`packages/cli/src/commands/approve.ts`:
```ts
import { join } from 'node:path'
import { approve, generateTests, reject, serializeTestFile, vocabularyMap, type RulesFile } from '@holdline/core'
import { UsageError, type Io } from '../io.js'
import { approver, loadPending, loadRules, savePending, saveRules, testsDir, today, writeFileEnsured } from '../workspace.js'

export async function writeTests(root: string, file: RulesFile, ids: string[]): Promise<void> {
  const vocab = vocabularyMap(file)
  for (const id of ids) {
    const rule = file.rules.find(r => r.id === id)
    const tests = rule ? generateTests(rule, vocab) : undefined
    if (tests) await writeFileEnsured(join(testsDir(root), `${id}.yaml`), serializeTestFile(tests))
  }
}

export async function approveCommand(keys: string[], opts: { all?: boolean }, io: Io): Promise<number> {
  if (!opts.all && keys.length === 0) throw new UsageError('approve needs keys (P-1, R-003) or --all')
  const pending = await loadPending(io.cwd)
  let result
  try {
    result = approve(await loadRules(io.cwd), pending, opts.all ? 'all' : keys, { by: approver(io), at: today(io) })
  } catch (e) {
    throw new UsageError((e as Error).message)
  }
  await saveRules(io.cwd, result.file)
  await savePending(io.cwd, result.pending)
  await writeTests(io.cwd, result.file, result.approved.map(a => a.id))
  io.stdout(`${result.approved.map(a => (a.key === a.id ? `${a.id} re-approved` : `${a.key} → ${a.id}`)).join('\n')}\n`)
  return 0
}

export async function rejectCommand(keys: string[], io: Io): Promise<number> {
  try {
    await savePending(io.cwd, reject(await loadPending(io.cwd), keys))
  } catch (e) {
    throw new UsageError((e as Error).message)
  }
  io.stdout(`Rejected ${keys.join(', ')}\n`)
  return 0
}
```

`packages/cli/src/commands/review.ts`:
```ts
import { createInterface } from 'node:readline'
import { approve, reject } from '@holdline/core'
import { UsageError, type Io } from '../io.js'
import { approver, loadPending, loadRules, savePending, saveRules, today } from '../workspace.js'
import { writeTests } from './approve.js'

export async function reviewCommand(io: Io): Promise<number> {
  if (!io.stdin) throw new UsageError('review needs an interactive terminal')
  let pending = await loadPending(io.cwd)
  let file = await loadRules(io.cwd)
  if (pending.rules.length === 0) {
    io.stdout('Nothing to review. Propose rules first: holdline infer --prompt | <your agent> > proposals.json && holdline propose proposals.json\n')
    return 0
  }
  const answers = createInterface({ input: io.stdin, terminal: false })[Symbol.asyncIterator]()
  const approvedIds: string[] = []
  for (const p of [...pending.rules]) {
    io.stdout(`\n${p.key} ${p.classification === 'broken' ? '? looks broken today' : '✓ holds today'}\n  ${p.rule.text}\n`)
    for (const v of p.violations) io.stdout(`  ${v}\n`)
    if (p.rule.evidence.length > 0) io.stdout(`  evidence: ${p.rule.evidence.join(', ')}\n`)
    io.stdout('[a]pprove  [r]eject  [s]kip  [q]uit > ')
    const next = await answers.next()
    const answer = next.done ? 'q' : String(next.value).trim().toLowerCase()
    if (answer === 'q') break
    if (answer === 'a') {
      const out = approve(file, pending, [p.key], { by: approver(io), at: today(io) })
      file = out.file
      pending = out.pending
      approvedIds.push(out.approved[0]!.id)
      io.stdout(`Approved ${p.key} as ${out.approved[0]!.id}\n`)
    } else if (answer === 'r') {
      pending = reject(pending, [p.key])
      io.stdout(`Rejected ${p.key}\n`)
    }
  }
  await saveRules(io.cwd, file)
  await savePending(io.cwd, pending)
  await writeTests(io.cwd, file, approvedIds)
  return 0
}
```

- [ ] **Step 4: Register the commands in `main.ts`**

Add the imports:
```ts
import { approveCommand, rejectCommand } from './commands/approve.js'
import { inferCommand } from './commands/infer.js'
import { proposeCommand } from './commands/propose.js'
import { reviewCommand } from './commands/review.js'
import { scanCommand } from './commands/scan.js'
```

Add after the `mute` command registration:
```ts
  program.command('scan')
    .description('Run the analyzers and update .holdline/cache/facts.json')
    .action(() => run(() => scanCommand(io))())

  program.command('infer')
    .description('Print the prompt your agent uses to propose rules')
    .option('--prompt', 'print the prompt')
    .option('--area <path>', 'only facts under this path')
    .option('--budget <tokens>', 'prompt size budget in tokens (default 30000)')
    .option('--facts <file>', 'use a facts file instead of scanning')
    .action((opts) => run(() => inferCommand(opts, io))())

  program.command('propose <file>')
    .description('Validate rule proposals (JSON file, or - for stdin) and stage them for review')
    .option('--facts <file>', 'use a facts file instead of scanning')
    .option('--limit <n>', 'keep at most this many proposals (default 25)')
    .action((source: string, opts) => run(() => proposeCommand(source, opts, io))())

  program.command('review')
    .description('Approve or reject staged proposals one by one')
    .action(() => run(() => reviewCommand(io))())

  program.command('approve [keys...]')
    .description('Approve staged proposals (P-1) or re-approve edited rules (R-003)')
    .option('--all', 'approve everything staged')
    .action((keys: string[], opts) => run(() => approveCommand(keys, opts, io))())

  program.command('reject <keys...>')
    .description('Drop staged proposals')
    .action((keys: string[]) => run(() => rejectCommand(keys, io))())
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run packages/cli && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli
git commit -m "feat(cli): add scan, infer, propose, review, approve and reject"
```

---

### Task 14: Golden app `golden-ts-postgres` and the Phase 0 acceptance test

**Files:**
- Create: `examples/golden-ts-postgres/README.md`, `examples/golden-ts-postgres/package.json`, `examples/golden-ts-postgres/prisma/schema.prisma`, `examples/golden-ts-postgres/prisma/migrations/0001_init/migration.sql`
- Create: `examples/golden-ts-postgres/src/server.ts`, `src/middleware/auth.ts`, `src/routes/dogs.ts`, `src/routes/teams.ts`, `src/routes/admin.ts`, `src/repositories/dogs.ts`, `src/repositories/teams.ts`, `src/repositories/users.ts`, `src/services/transfer.ts`, `src/db.ts`
- Create: `examples/golden-ts-postgres/expected-rules.yaml`, `examples/golden-ts-postgres/fixtures/facts.json`, `examples/golden-ts-postgres/fixtures/breakages/R-001.json` … `R-012.json`
- Create: `scripts/approve-fixture.ts`
- Test: `packages/cli/test/golden.test.ts`, `packages/cli/test/helpers/json-patch.ts`

**Interfaces:**
- Consumes: `main` via `runCli` (Task 12), `parseRulesFile`, `serializeRulesFile`, `hashRule` (core)
- Produces: the golden app layout every later analyzer track reuses: `expected-rules.yaml` (approved rules), `fixtures/facts.json` (the facts a correct analyzer must produce for this app), `fixtures/breakages/R-xxx.json` (`{ rule, description, patch }` where `patch` is RFC 6902 `add`/`remove`/`replace` ops against `facts.json`)

- [ ] **Step 1: Write the app source**

`examples/golden-ts-postgres/package.json` (not part of the pnpm workspace; never installed in CI):
```json
{
  "name": "golden-ts-postgres",
  "private": true,
  "type": "module",
  "dependencies": { "@prisma/client": "^6.0.0", "express": "^5.0.0" },
  "devDependencies": { "prisma": "^6.0.0" }
}
```

`examples/golden-ts-postgres/prisma/migrations/0001_init/migration.sql`:
```sql
CREATE TYPE "user_role" AS ENUM ('admin', 'trainer', 'member');

CREATE TABLE "teams" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "deleted_at" TIMESTAMPTZ
);

CREATE TABLE "users" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "email" TEXT NOT NULL UNIQUE,
  "role" "user_role" NOT NULL DEFAULT 'member',
  "team_id" UUID REFERENCES "teams"("id")
);

CREATE TABLE "dogs" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "team_id" UUID NOT NULL REFERENCES "teams"("id"),
  "owner_id" UUID REFERENCES "users"("id"),
  "deleted_at" TIMESTAMPTZ
);

CREATE TABLE "transfers" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "dog_id" UUID NOT NULL REFERENCES "dogs"("id"),
  "from_team_id" UUID NOT NULL,
  "to_team_id" UUID NOT NULL,
  "by_user_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

`examples/golden-ts-postgres/prisma/schema.prisma`:
```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum UserRole {
  admin
  trainer
  member

  @@map("user_role")
}

model Team {
  id        String    @id @default(uuid()) @db.Uuid
  name      String
  deletedAt DateTime? @map("deleted_at")
  dogs      Dog[]
  users     User[]

  @@map("teams")
}

model User {
  id     String   @id @default(uuid()) @db.Uuid
  email  String   @unique
  role   UserRole @default(member)
  teamId String?  @map("team_id") @db.Uuid
  team   Team?    @relation(fields: [teamId], references: [id])
  dogs   Dog[]

  @@map("users")
}

model Dog {
  id        String     @id @default(uuid()) @db.Uuid
  name      String
  teamId    String     @map("team_id") @db.Uuid
  ownerId   String?    @map("owner_id") @db.Uuid
  deletedAt DateTime?  @map("deleted_at")
  team      Team       @relation(fields: [teamId], references: [id])
  owner     User?      @relation(fields: [ownerId], references: [id])
  transfers Transfer[]

  @@map("dogs")
}

model Transfer {
  id         String   @id @default(uuid()) @db.Uuid
  dogId      String   @map("dog_id") @db.Uuid
  fromTeamId String   @map("from_team_id") @db.Uuid
  toTeamId   String   @map("to_team_id") @db.Uuid
  byUserId   String   @map("by_user_id") @db.Uuid
  createdAt  DateTime @default(now()) @map("created_at")
  dog        Dog      @relation(fields: [dogId], references: [id])

  @@map("transfers")
}
```

`examples/golden-ts-postgres/src/db.ts`:
```ts
import { PrismaClient } from '@prisma/client'

export const db = new PrismaClient()
```

`examples/golden-ts-postgres/src/middleware/auth.ts`:
```ts
import type { NextFunction, Request, Response } from 'express'

export type Actor = { uid: string; role: 'admin' | 'trainer' | 'member'; teamId: string }

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const actor = (req as Request & { actor?: Actor }).actor
  if (!actor) return res.status(401).json({ error: 'sign in required' })
  next()
}

export function requireRole(...roles: Actor['role'][]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const actor = (req as Request & { actor?: Actor }).actor
    if (!actor || !roles.includes(actor.role)) return res.status(403).json({ error: 'forbidden' })
    next()
  }
}

export const actorOf = (req: Request) => (req as Request & { actor: Actor }).actor
```

`examples/golden-ts-postgres/src/repositories/dogs.ts`:
```ts
import { db } from '../db.js'

export class DogRepository {
  list(teamId: string) {
    return db.dog.findMany({ where: { teamId, deletedAt: null } })
  }

  findById(id: string) {
    return db.dog.findFirst({ where: { id, deletedAt: null } })
  }

  create(data: { name: string; teamId: string; ownerId?: string }) {
    return db.dog.create({ data })
  }

  update(id: string, data: { name?: string; teamId?: string }) {
    return db.dog.update({ where: { id }, data })
  }

  softDelete(id: string) {
    return db.dog.update({ where: { id }, data: { deletedAt: new Date() } })
  }
}

export const dogs = new DogRepository()
```

`examples/golden-ts-postgres/src/repositories/teams.ts`:
```ts
import { db } from '../db.js'

export class TeamRepository {
  list() {
    return db.team.findMany({ where: { deletedAt: null } })
  }

  softDelete(id: string) {
    return db.team.update({ where: { id }, data: { deletedAt: new Date() } })
  }
}

export const teams = new TeamRepository()
```

`examples/golden-ts-postgres/src/repositories/users.ts`:
```ts
import { db } from '../db.js'

export class UserRepository {
  list() {
    return db.user.findMany()
  }
}

export const users = new UserRepository()
```

`examples/golden-ts-postgres/src/services/transfer.ts`:
```ts
import { db } from '../db.js'
import { dogs } from '../repositories/dogs.js'

export class TransferService {
  async transfer(dogId: string, toTeamId: string, byUserId: string) {
    const dog = await dogs.findById(dogId)
    if (!dog) throw new Error('dog not found')
    await dogs.update(dogId, { teamId: toTeamId })
    return db.transfer.create({ data: { dogId, fromTeamId: dog.teamId, toTeamId, byUserId } })
  }
}

export const transfers = new TransferService()
```

`examples/golden-ts-postgres/src/routes/dogs.ts`:
```ts
import { Router } from 'express'
import { actorOf, requireAuth, requireRole } from '../middleware/auth.js'
import { dogs } from '../repositories/dogs.js'
import { transfers } from '../services/transfer.js'

export const dogRoutes = Router()

dogRoutes.get('/dogs', requireAuth, async function listDogs(req, res) {
  res.json(await dogs.list(actorOf(req).teamId))
})

dogRoutes.get('/dogs/:id', requireAuth, async function getDog(req, res) {
  res.json(await dogs.findById(req.params.id))
})

dogRoutes.post('/dogs', requireAuth, requireRole('trainer', 'admin'), async function createDog(req, res) {
  res.status(201).json(await dogs.create({ ...req.body, teamId: actorOf(req).teamId }))
})

dogRoutes.post('/dogs/:id/transfer', requireAuth, requireRole('admin'), async function transferDog(req, res) {
  res.json(await transfers.transfer(req.params.id, req.body.toTeamId, actorOf(req).uid))
})

dogRoutes.delete('/dogs/:id', requireAuth, requireRole('admin'), async function deleteDog(req, res) {
  res.json(await dogs.softDelete(req.params.id))
})
```

`examples/golden-ts-postgres/src/routes/teams.ts`:
```ts
import { Router } from 'express'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { teams } from '../repositories/teams.js'

export const teamRoutes = Router()

teamRoutes.get('/teams', requireAuth, async function listTeams(_req, res) {
  res.json(await teams.list())
})

teamRoutes.delete('/teams/:id', requireAuth, requireRole('admin'), async function deleteTeam(req, res) {
  res.json(await teams.softDelete(req.params.id))
})
```

`examples/golden-ts-postgres/src/routes/admin.ts`:
```ts
import { Router } from 'express'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { users } from '../repositories/users.js'

export const adminRoutes = Router()

adminRoutes.get('/admin/users', requireAuth, requireRole('admin'), async function listUsers(_req, res) {
  res.json(await users.list())
})
```

`examples/golden-ts-postgres/src/server.ts`:
```ts
import express from 'express'
import { adminRoutes } from './routes/admin.js'
import { dogRoutes } from './routes/dogs.js'
import { teamRoutes } from './routes/teams.js'

const app = express()
app.use(express.json())
app.use(dogRoutes, teamRoutes, adminRoutes)
app.listen(3000)
```

`examples/golden-ts-postgres/README.md`:
```markdown
# golden-ts-postgres

A small Express + Prisma app with 12 known business rules. It is Holdline's acceptance fixture
for TypeScript and Postgres.

| File | What |
|---|---|
| `expected-rules.yaml` | The approved rules a careful engineer would write for this app |
| `fixtures/facts.json` | The facts a correct analyzer must produce for this app (hand-written in Phase 0) |
| `fixtures/breakages/R-xxx.json` | One change per rule, as a JSON Patch against `facts.json`, that breaks exactly that rule |

Phase 0 checks `expected-rules.yaml` against `facts.json` and every breakage. In Phase 1 and 2,
`analyzer-postgres` and `analyzer-ts` must produce facts equivalent to `facts.json`, and each
breakage gains a code patch. After editing `expected-rules.yaml`, run
`pnpm tsx scripts/approve-fixture.ts examples/golden-ts-postgres/expected-rules.yaml`.
```

- [ ] **Step 2: Write `fixtures/facts.json`**

After writing the source files, set every `line` below to the line where the symbol is declared in your files (the values below match the files exactly as written above).

```json
{
  "version": 1,
  "analyzers": [{ "name": "hand-written", "version": "0" }],
  "symbols": [
    { "id": "ts:src/middleware/auth#requireAuth", "kind": "function", "lang": "ts", "location": { "file": "src/middleware/auth.ts", "line": 5 } },
    { "id": "ts:src/middleware/auth#requireRole", "kind": "function", "lang": "ts", "location": { "file": "src/middleware/auth.ts", "line": 11 } },
    { "id": "ts:src/routes/dogs#listDogs", "kind": "function", "lang": "ts", "location": { "file": "src/routes/dogs.ts", "line": 8 } },
    { "id": "ts:src/routes/dogs#getDog", "kind": "function", "lang": "ts", "location": { "file": "src/routes/dogs.ts", "line": 12 } },
    { "id": "ts:src/routes/dogs#createDog", "kind": "function", "lang": "ts", "location": { "file": "src/routes/dogs.ts", "line": 16 } },
    { "id": "ts:src/routes/dogs#transferDog", "kind": "function", "lang": "ts", "location": { "file": "src/routes/dogs.ts", "line": 20 } },
    { "id": "ts:src/routes/dogs#deleteDog", "kind": "function", "lang": "ts", "location": { "file": "src/routes/dogs.ts", "line": 24 } },
    { "id": "ts:src/routes/teams#listTeams", "kind": "function", "lang": "ts", "location": { "file": "src/routes/teams.ts", "line": 7 } },
    { "id": "ts:src/routes/teams#deleteTeam", "kind": "function", "lang": "ts", "location": { "file": "src/routes/teams.ts", "line": 11 } },
    { "id": "ts:src/routes/admin#listUsers", "kind": "function", "lang": "ts", "location": { "file": "src/routes/admin.ts", "line": 7 } },
    { "id": "ts:src/repositories/dogs#DogRepository", "kind": "class", "lang": "ts", "location": { "file": "src/repositories/dogs.ts", "line": 3 } },
    { "id": "ts:src/repositories/dogs#DogRepository.list", "kind": "method", "lang": "ts", "location": { "file": "src/repositories/dogs.ts", "line": 4 } },
    { "id": "ts:src/repositories/dogs#DogRepository.findById", "kind": "method", "lang": "ts", "location": { "file": "src/repositories/dogs.ts", "line": 8 } },
    { "id": "ts:src/repositories/dogs#DogRepository.create", "kind": "method", "lang": "ts", "location": { "file": "src/repositories/dogs.ts", "line": 12 } },
    { "id": "ts:src/repositories/dogs#DogRepository.update", "kind": "method", "lang": "ts", "location": { "file": "src/repositories/dogs.ts", "line": 16 } },
    { "id": "ts:src/repositories/dogs#DogRepository.softDelete", "kind": "method", "lang": "ts", "location": { "file": "src/repositories/dogs.ts", "line": 20 } },
    { "id": "ts:src/repositories/teams#TeamRepository.list", "kind": "method", "lang": "ts", "location": { "file": "src/repositories/teams.ts", "line": 4 } },
    { "id": "ts:src/repositories/teams#TeamRepository.softDelete", "kind": "method", "lang": "ts", "location": { "file": "src/repositories/teams.ts", "line": 8 } },
    { "id": "ts:src/repositories/users#UserRepository.list", "kind": "method", "lang": "ts", "location": { "file": "src/repositories/users.ts", "line": 4 } },
    { "id": "ts:src/services/transfer#TransferService.transfer", "kind": "method", "lang": "ts", "location": { "file": "src/services/transfer.ts", "line": 5 } }
  ],
  "routes": [
    { "id": "route:GET /dogs", "method": "GET", "path": "/dogs", "handler": "ts:src/routes/dogs#listDogs", "middleware": ["ts:src/middleware/auth#requireAuth"], "framework": "express" },
    { "id": "route:GET /dogs/:id", "method": "GET", "path": "/dogs/:id", "handler": "ts:src/routes/dogs#getDog", "middleware": ["ts:src/middleware/auth#requireAuth"], "framework": "express" },
    { "id": "route:POST /dogs", "method": "POST", "path": "/dogs", "handler": "ts:src/routes/dogs#createDog", "middleware": ["ts:src/middleware/auth#requireAuth", "ts:src/middleware/auth#requireRole"], "framework": "express" },
    { "id": "route:POST /dogs/:id/transfer", "method": "POST", "path": "/dogs/:id/transfer", "handler": "ts:src/routes/dogs#transferDog", "middleware": ["ts:src/middleware/auth#requireAuth", "ts:src/middleware/auth#requireRole"], "framework": "express" },
    { "id": "route:DELETE /dogs/:id", "method": "DELETE", "path": "/dogs/:id", "handler": "ts:src/routes/dogs#deleteDog", "middleware": ["ts:src/middleware/auth#requireAuth", "ts:src/middleware/auth#requireRole"], "framework": "express" },
    { "id": "route:GET /teams", "method": "GET", "path": "/teams", "handler": "ts:src/routes/teams#listTeams", "middleware": ["ts:src/middleware/auth#requireAuth"], "framework": "express" },
    { "id": "route:DELETE /teams/:id", "method": "DELETE", "path": "/teams/:id", "handler": "ts:src/routes/teams#deleteTeam", "middleware": ["ts:src/middleware/auth#requireAuth", "ts:src/middleware/auth#requireRole"], "framework": "express" },
    { "id": "route:GET /admin/users", "method": "GET", "path": "/admin/users", "handler": "ts:src/routes/admin#listUsers", "middleware": ["ts:src/middleware/auth#requireAuth", "ts:src/middleware/auth#requireRole"], "framework": "express" }
  ],
  "guards": [
    { "at": "ts:src/middleware/auth#requireAuth", "requires": { "atom": { "op": "authenticated" } }, "evidence": { "file": "src/middleware/auth.ts", "line": 7 } },
    { "at": "route:POST /dogs", "requires": { "atom": { "op": "in", "left": "actor.role", "right": { "literal": ["trainer", "admin"] } } }, "evidence": { "file": "src/routes/dogs.ts", "line": 16 } },
    { "at": "route:POST /dogs/:id/transfer", "requires": { "atom": { "op": "in", "left": "actor.role", "right": { "literal": ["admin"] } } }, "evidence": { "file": "src/routes/dogs.ts", "line": 20 } },
    { "at": "route:DELETE /dogs/:id", "requires": { "atom": { "op": "in", "left": "actor.role", "right": { "literal": ["admin"] } } }, "evidence": { "file": "src/routes/dogs.ts", "line": 24 } },
    { "at": "route:DELETE /teams/:id", "requires": { "atom": { "op": "in", "left": "actor.role", "right": { "literal": ["admin"] } } }, "evidence": { "file": "src/routes/teams.ts", "line": 11 } },
    { "at": "route:GET /admin/users", "requires": { "atom": { "op": "in", "left": "actor.role", "right": { "literal": ["admin"] } } }, "evidence": { "file": "src/routes/admin.ts", "line": 7 } }
  ],
  "dataOps": [
    { "in": "ts:src/repositories/dogs#DogRepository.list", "store": "postgres", "target": "public.dogs", "op": "list", "filters": { "and": [{ "atom": { "op": "eq", "left": "resource.team_id", "right": "actor.claim.team_id" } }, { "atom": { "op": "isNull", "operand": "resource.deleted_at" } }] }, "evidence": { "file": "src/repositories/dogs.ts", "line": 5 } },
    { "in": "ts:src/repositories/dogs#DogRepository.findById", "store": "postgres", "target": "public.dogs", "op": "read", "filters": { "and": [{ "atom": { "op": "eq", "left": "resource.id", "right": "param.id" } }, { "atom": { "op": "isNull", "operand": "resource.deleted_at" } }] }, "evidence": { "file": "src/repositories/dogs.ts", "line": 9 } },
    { "in": "ts:src/repositories/dogs#DogRepository.create", "store": "postgres", "target": "public.dogs", "op": "create", "evidence": { "file": "src/repositories/dogs.ts", "line": 13 } },
    { "in": "ts:src/repositories/dogs#DogRepository.update", "store": "postgres", "target": "public.dogs", "op": "update", "evidence": { "file": "src/repositories/dogs.ts", "line": 17 } },
    { "in": "ts:src/repositories/dogs#DogRepository.softDelete", "store": "postgres", "target": "public.dogs", "op": "update", "evidence": { "file": "src/repositories/dogs.ts", "line": 21 } },
    { "in": "ts:src/repositories/teams#TeamRepository.list", "store": "postgres", "target": "public.teams", "op": "list", "filters": { "atom": { "op": "isNull", "operand": "resource.deleted_at" } }, "evidence": { "file": "src/repositories/teams.ts", "line": 5 } },
    { "in": "ts:src/repositories/teams#TeamRepository.softDelete", "store": "postgres", "target": "public.teams", "op": "update", "evidence": { "file": "src/repositories/teams.ts", "line": 9 } },
    { "in": "ts:src/repositories/users#UserRepository.list", "store": "postgres", "target": "public.users", "op": "list", "evidence": { "file": "src/repositories/users.ts", "line": 5 } },
    { "in": "ts:src/services/transfer#TransferService.transfer", "store": "postgres", "target": "public.transfers", "op": "create", "evidence": { "file": "src/services/transfer.ts", "line": 9 } }
  ],
  "calls": [
    ["ts:src/routes/dogs#listDogs", "ts:src/repositories/dogs#DogRepository.list"],
    ["ts:src/routes/dogs#getDog", "ts:src/repositories/dogs#DogRepository.findById"],
    ["ts:src/routes/dogs#createDog", "ts:src/repositories/dogs#DogRepository.create"],
    ["ts:src/routes/dogs#transferDog", "ts:src/services/transfer#TransferService.transfer"],
    ["ts:src/services/transfer#TransferService.transfer", "ts:src/repositories/dogs#DogRepository.findById"],
    ["ts:src/services/transfer#TransferService.transfer", "ts:src/repositories/dogs#DogRepository.update"],
    ["ts:src/routes/dogs#deleteDog", "ts:src/repositories/dogs#DogRepository.softDelete"],
    ["ts:src/routes/teams#listTeams", "ts:src/repositories/teams#TeamRepository.list"],
    ["ts:src/routes/teams#deleteTeam", "ts:src/repositories/teams#TeamRepository.softDelete"],
    ["ts:src/routes/admin#listUsers", "ts:src/repositories/users#UserRepository.list"]
  ],
  "tables": [
    { "id": "pg:public.users", "name": "public.users", "columns": [
        { "name": "id", "type": "uuid", "nullable": false, "default": "gen_random_uuid()" },
        { "name": "email", "type": "text", "nullable": false },
        { "name": "role", "type": "user_role", "nullable": false, "default": "'member'" },
        { "name": "team_id", "type": "uuid", "nullable": true }
      ],
      "primaryKey": ["id"], "uniques": [["email"]],
      "foreignKeys": [{ "columns": ["team_id"], "references": { "table": "public.teams", "columns": ["id"] } }],
      "enums": [{ "column": "role", "values": ["admin", "trainer", "member"] }],
      "location": { "file": "prisma/migrations/0001_init/migration.sql", "line": 9 } },
    { "id": "pg:public.teams", "name": "public.teams", "columns": [
        { "name": "id", "type": "uuid", "nullable": false, "default": "gen_random_uuid()" },
        { "name": "name", "type": "text", "nullable": false },
        { "name": "deleted_at", "type": "timestamptz", "nullable": true }
      ],
      "primaryKey": ["id"],
      "location": { "file": "prisma/migrations/0001_init/migration.sql", "line": 3 } },
    { "id": "pg:public.dogs", "name": "public.dogs", "columns": [
        { "name": "id", "type": "uuid", "nullable": false, "default": "gen_random_uuid()" },
        { "name": "name", "type": "text", "nullable": false },
        { "name": "team_id", "type": "uuid", "nullable": false },
        { "name": "owner_id", "type": "uuid", "nullable": true },
        { "name": "deleted_at", "type": "timestamptz", "nullable": true }
      ],
      "primaryKey": ["id"],
      "foreignKeys": [
        { "columns": ["team_id"], "references": { "table": "public.teams", "columns": ["id"] } },
        { "columns": ["owner_id"], "references": { "table": "public.users", "columns": ["id"] } }
      ],
      "location": { "file": "prisma/migrations/0001_init/migration.sql", "line": 16 } },
    { "id": "pg:public.transfers", "name": "public.transfers", "columns": [
        { "name": "id", "type": "uuid", "nullable": false, "default": "gen_random_uuid()" },
        { "name": "dog_id", "type": "uuid", "nullable": false },
        { "name": "from_team_id", "type": "uuid", "nullable": false },
        { "name": "to_team_id", "type": "uuid", "nullable": false },
        { "name": "by_user_id", "type": "uuid", "nullable": false },
        { "name": "created_at", "type": "timestamptz", "nullable": false, "default": "now()" }
      ],
      "primaryKey": ["id"],
      "foreignKeys": [{ "columns": ["dog_id"], "references": { "table": "public.dogs", "columns": ["id"] } }],
      "location": { "file": "prisma/migrations/0001_init/migration.sql", "line": 24 } }
  ]
}
```

Array positions matter for the breakage patches: routes `[0]` GET /dogs, `[1]` GET /dogs/:id, `[2]` POST /dogs, `[3]` transfer, `[4]` DELETE /dogs/:id, `[5]` GET /teams, `[6]` DELETE /teams/:id, `[7]` GET /admin/users; guards `[0]` requireAuth, `[1]` POST /dogs, `[2]` transfer, `[3]` DELETE /dogs, `[4]` DELETE /teams, `[5]` admin; dataOps `[0]` dog list, `[1]` findById, `[2]` create, `[3]` update, `[4]` softDelete, `[5]` team list, `[6]` team softDelete, `[7]` user list, `[8]` transfer create; tables `[0]` users, `[1]` teams, `[2]` dogs, `[3]` transfers.

- [ ] **Step 3: Write `expected-rules.yaml`**

```yaml
version: 1
vocabulary: []
rules:
  - id: R-001
    text: Only admins can transfer dogs between teams
    type: access
    target: { routes: "POST /dogs/*/transfer" }
    requires: { atom: { op: in, left: actor.role, right: { literal: [admin] } } }
    evidence: ["route:POST /dogs/:id/transfer"]
    status: approved
    approved: { by: golden, at: "2026-10-21", hash: "" }
  - id: R-002
    text: Only trainers and admins can add dogs
    type: access
    target: { routes: "POST /dogs" }
    requires: { atom: { op: in, left: actor.role, right: { literal: [trainer, admin] } } }
    evidence: ["route:POST /dogs"]
    status: approved
    approved: { by: golden, at: "2026-10-21", hash: "" }
  - id: R-003
    text: Every admin page is for admins only
    type: access
    target: { routes: "* /admin/**" }
    requires: { atom: { op: in, left: actor.role, right: { literal: [admin] } } }
    evidence: ["route:GET /admin/users"]
    status: approved
    approved: { by: golden, at: "2026-10-21", hash: "" }
  - id: R-004
    text: Every dog endpoint requires sign-in
    type: access
    target: { routes: "* /dogs/**" }
    requires: { atom: { op: authenticated } }
    evidence: ["ts:src/middleware/auth#requireAuth"]
    status: approved
    approved: { by: golden, at: "2026-10-21", hash: "" }
  - id: R-005
    text: Deleted dogs are never returned
    type: visibility
    target: { store: postgres, table: dogs }
    requires: { atom: { op: isNull, operand: resource.deleted_at } }
    evidence: ["ts:src/repositories/dogs#DogRepository.list", "ts:src/repositories/dogs#DogRepository.findById"]
    status: approved
    approved: { by: golden, at: "2026-10-21", hash: "" }
  - id: R-006
    text: Deleted teams are never returned
    type: visibility
    target: { store: postgres, table: teams }
    requires: { atom: { op: isNull, operand: resource.deleted_at } }
    evidence: ["ts:src/repositories/teams#TeamRepository.list"]
    status: approved
    approved: { by: golden, at: "2026-10-21", hash: "" }
  - id: R-007
    text: Transfer records are only written by the transfer service
    type: flow
    target: { store: postgres, table: transfers }
    ops: [create, update, delete]
    via: ["ts:src/services/transfer#TransferService.transfer"]
    evidence: ["ts:src/services/transfer#TransferService.transfer"]
    status: approved
    approved: { by: golden, at: "2026-10-21", hash: "" }
  - id: R-008
    text: Dogs are only changed through the dog repository
    type: flow
    target: { store: postgres, table: dogs }
    ops: [update, delete]
    via: ["ts:src/repositories/dogs#DogRepository"]
    evidence: ["ts:src/repositories/dogs#DogRepository"]
    status: approved
    approved: { by: golden, at: "2026-10-21", hash: "" }
  - id: R-009
    text: Every dog belongs to a team
    type: invariant
    target: { store: postgres, table: dogs }
    kind: not-null
    columns: [team_id]
    evidence: ["pg:public.dogs"]
    status: approved
    approved: { by: golden, at: "2026-10-21", hash: "" }
  - id: R-010
    text: A dog's team must exist
    type: invariant
    target: { store: postgres, table: dogs }
    kind: fk
    columns: [team_id]
    references: { table: public.teams, columns: [id] }
    evidence: ["pg:public.dogs"]
    status: approved
    approved: { by: golden, at: "2026-10-21", hash: "" }
  - id: R-011
    text: A user's role is admin, trainer or member
    type: invariant
    target: { store: postgres, table: users }
    kind: enum
    columns: [role]
    values: [admin, trainer, member]
    evidence: ["pg:public.users"]
    status: approved
    approved: { by: golden, at: "2026-10-21", hash: "" }
  - id: R-012
    text: No two users share an email address
    type: invariant
    target: { store: postgres, table: users }
    kind: unique
    columns: [email]
    evidence: ["pg:public.users"]
    status: approved
    approved: { by: golden, at: "2026-10-21", hash: "" }
```

- [ ] **Step 4: Write `scripts/approve-fixture.ts` and fill the hashes**

```ts
// Dev-only: stamps every approved rule in a fixture rules file with its current hash.
import { readFile, writeFile } from 'node:fs/promises'
import { hashRule, parseRulesFile, serializeRulesFile } from '@holdline/core'

const path = process.argv[2]
if (!path) {
  console.error('usage: tsx scripts/approve-fixture.ts <rules.yaml>')
  process.exit(2)
}
const file = parseRulesFile(await readFile(path, 'utf8'), path)
const rules = file.rules.map(r => (r.status === 'approved' && r.approved ? { ...r, approved: { ...r.approved, hash: hashRule(r) } } : r))
await writeFile(path, serializeRulesFile({ ...file, rules }))
console.log(`stamped ${rules.filter(r => r.status === 'approved').length} rules in ${path}`)
```

`@holdline/core` resolves from the repo root because the root `package.json` must list it. Add `"@holdline/core": "workspace:*"` to the root `devDependencies` and run `pnpm install`.

Run: `pnpm tsx scripts/approve-fixture.ts examples/golden-ts-postgres/expected-rules.yaml`
Expected: `stamped 12 rules in examples/golden-ts-postgres/expected-rules.yaml`.

- [ ] **Step 5: Write the breakages**

Each file in `examples/golden-ts-postgres/fixtures/breakages/`:

`R-001.json`:
```json
{ "rule": "R-001", "description": "Transfer route loses its admin check", "patch": [{ "op": "remove", "path": "/guards/2" }] }
```
`R-002.json`:
```json
{ "rule": "R-002", "description": "Members may now add dogs", "patch": [{ "op": "replace", "path": "/guards/1/requires/atom/right", "value": { "literal": ["trainer", "admin", "member"] } }] }
```
`R-003.json`:
```json
{ "rule": "R-003", "description": "New admin route without an admin check", "patch": [{ "op": "add", "path": "/routes/-", "value": { "id": "route:GET /admin/stats", "method": "GET", "path": "/admin/stats", "handler": "ts:src/routes/admin#stats", "middleware": ["ts:src/middleware/auth#requireAuth"], "framework": "express" } }] }
```
`R-004.json`:
```json
{ "rule": "R-004", "description": "GET /dogs/:id loses requireAuth", "patch": [{ "op": "replace", "path": "/routes/1/middleware", "value": [] }] }
```
`R-005.json`:
```json
{ "rule": "R-005", "description": "findById stops filtering deleted dogs", "patch": [{ "op": "replace", "path": "/dataOps/1/filters", "value": { "atom": { "op": "eq", "left": "resource.id", "right": "param.id" } } }] }
```
`R-006.json`:
```json
{ "rule": "R-006", "description": "Team list stops filtering deleted teams", "patch": [{ "op": "remove", "path": "/dataOps/5/filters" }] }
```
`R-007.json`:
```json
{ "rule": "R-007", "description": "Bulk import writes transfer records directly", "patch": [{ "op": "add", "path": "/dataOps/-", "value": { "in": "ts:src/routes/dogs#bulkImport", "store": "postgres", "target": "public.transfers", "op": "create" } }] }
```
`R-008.json`:
```json
{ "rule": "R-008", "description": "A PATCH handler updates dogs without the repository", "patch": [{ "op": "add", "path": "/dataOps/-", "value": { "in": "ts:src/routes/dogs#patchDog", "store": "postgres", "target": "public.dogs", "op": "update" } }] }
```
`R-009.json`:
```json
{ "rule": "R-009", "description": "dogs.team_id becomes nullable", "patch": [{ "op": "replace", "path": "/tables/2/columns/2/nullable", "value": true }] }
```
`R-010.json`:
```json
{ "rule": "R-010", "description": "dogs.team_id loses its foreign key", "patch": [{ "op": "remove", "path": "/tables/2/foreignKeys/0" }] }
```
`R-011.json`:
```json
{ "rule": "R-011", "description": "A new owner role appears", "patch": [{ "op": "replace", "path": "/tables/0/enums/0/values", "value": ["admin", "trainer", "member", "owner"] }] }
```
`R-012.json`:
```json
{ "rule": "R-012", "description": "users.email loses its unique constraint", "patch": [{ "op": "replace", "path": "/tables/0/uniques", "value": [] }] }
```

- [ ] **Step 6: Write the JSON Patch helper and the acceptance test**

`packages/cli/test/helpers/json-patch.ts`:
```ts
type PatchOp = { op: 'add' | 'remove' | 'replace'; path: string; value?: unknown }

export function applyPatch<T>(doc: T, ops: PatchOp[]): T {
  const out = structuredClone(doc) as unknown
  for (const { op, path, value } of ops) {
    const keys = path.split('/').slice(1).map(k => k.replace(/~1/g, '/').replace(/~0/g, '~'))
    const last = keys.pop()!
    let parent = out as Record<string, unknown> | unknown[]
    for (const k of keys) parent = (parent as Record<string, unknown>)[k] as Record<string, unknown> | unknown[]
    if (Array.isArray(parent)) {
      const i = last === '-' ? parent.length : Number(last)
      if (op === 'add') parent.splice(i, 0, value)
      else if (op === 'remove') parent.splice(i, 1)
      else parent[i] = value
    } else if (op === 'remove') {
      delete parent[last]
    } else {
      parent[last] = value
    }
  }
  return out as T
}
```

`packages/cli/test/golden.test.ts`:
```ts
import { copyFile, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { applyPatch } from './helpers/json-patch.js'
import { makeProject, runCli } from './helpers/project.js'

const golden = fileURLToPath(new URL('../../../examples/golden-ts-postgres/', import.meta.url))

async function goldenProject(): Promise<string> {
  const root = await makeProject({})
  await copyFile(join(golden, 'expected-rules.yaml'), join(root, 'holdline.rules'))
  await copyFile(join(golden, 'fixtures/facts.json'), join(root, 'facts.json'))
  return root
}

describe('golden-ts-postgres', () => {
  it('passes every expected rule on the clean facts', async () => {
    const root = await goldenProject()
    const out = await runCli(['check', '--facts', 'facts.json', '--format', 'json', '--strict'], { cwd: root })
    const parsed = JSON.parse(out.stdout)
    expect(parsed.results.filter((r: { status: string }) => r.status !== 'pass')).toEqual([])
    expect(parsed.summary.pass).toBe(12)
    expect(out.code).toBe(0)
  })

  const breakages = await readdir(join(golden, 'fixtures/breakages'))
  it('has one breakage per rule', () => {
    expect(breakages.sort()).toEqual(Array.from({ length: 12 }, (_, i) => `R-${String(i + 1).padStart(3, '0')}.json`))
  })

  for (const name of breakages.sort()) {
    it(`catches breakage ${name}`, async () => {
      const breakage = JSON.parse(await readFile(join(golden, 'fixtures/breakages', name), 'utf8'))
      const root = await goldenProject()
      const facts = JSON.parse(await readFile(join(root, 'facts.json'), 'utf8'))
      await writeFile(join(root, 'facts.json'), JSON.stringify(applyPatch(facts, breakage.patch)))
      const out = await runCli(['check', '--facts', 'facts.json', '--format', 'json'], { cwd: root })
      const failing = JSON.parse(out.stdout).results.filter((r: { status: string }) => r.status !== 'pass')
      expect(out.code).toBe(1)
      expect([...new Set(failing.map((r: { rule: string }) => r.rule))]).toEqual([breakage.rule])
      expect(failing.every((r: { status: string }) => r.status === 'violation')).toBe(true)
    })
  }
})
```

Vitest 5 supports top-level `await` in test files, which `breakages` relies on.

- [ ] **Step 7: Run the acceptance test**

Run: `pnpm vitest run packages/cli/test/golden.test.ts`
Expected: 14 tests pass (clean run, breakage count, 12 breakages). If a breakage trips a second rule, fix the fixture (not the checker) unless the checker is wrong per spec §7.2; record any checker change in the spec's "As built".

- [ ] **Step 8: Run everything**

Run: `pnpm typecheck && pnpm test`
Expected: all tests pass.

- [ ] **Step 9: Commit**

```bash
git add examples scripts packages/cli/test package.json pnpm-lock.yaml
git commit -m "test: add golden-ts-postgres app with 12 rules, breakages and acceptance test"
```

---

### Task 15: Phase 0 gate and evergreen docs

**Files:**
- Create: `docs/reference/rules-file.md`, `docs/reference/facts.md`
- Modify: `CLAUDE.md` (link the reference docs)

**Interfaces:**
- Consumes: everything above.
- Produces: the reference docs Phase 1 to 3 tracks build against.

- [ ] **Step 1: Write `docs/reference/facts.md`**

Document, from the code as built: every fact type with its fields (copy field lists from `facts.ts`), the symbol id conventions (§5.1), the operand and atom forms (§5.3) including the Postgres `exists` doc format `pg:<table>?<column>={<operand>}&…`, how `{x=**}` path patterns work, the `via` class-prefix rule (`ts:x#Repo` covers `ts:x#Repo.update`), the rule that only `exists` on the actor and actor-to-literal `eq`/`in` atoms imply `authenticated` (so analyzers for stores that deny anonymous callers, such as Firestore rules and RLS, must emit an explicit `authenticated` atom), and the analyzer contract (`Analyzer`, `AnalyzerOutput`, how crashes become diagnostics). Use `examples/golden-ts-postgres/fixtures/facts.json` as the worked example.

- [ ] **Step 2: Write `docs/reference/rules-file.md`**

Document `holdline.rules`: the file layout, every rule type with an example and its static check (§7.2), the vocabulary and recognizers, approval hashes and `unapproved-edit`, muting, default `enforce` values, and the `.holdline/tests/*.yaml` test-case format. Use `examples/golden-ts-postgres/expected-rules.yaml` as the worked example.

- [ ] **Step 3: Link them from `CLAUDE.md`**

Add under "Contracts (frozen)":
```markdown
Reference docs (keep true when a contract changes): [docs/reference/facts.md](docs/reference/facts.md),
[docs/reference/rules-file.md](docs/reference/rules-file.md).
```

- [ ] **Step 4: Verify the gate**

Run: `pnpm typecheck && pnpm test`
Expected: every test passes, including `golden.test.ts`.

The gate: fact and rule schemas are in the frozen contract files; `holdline check` runs end to end on hand-written facts and catches all 12 golden breakages.

- [ ] **Step 5: Commit**

```bash
git add docs CLAUDE.md
git commit -m "docs: add fact graph and rules file reference"
```
