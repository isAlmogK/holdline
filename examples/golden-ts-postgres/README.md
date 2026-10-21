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

## Fixture conventions

1. Filters reference the function's own parameters (`param.teamId`), not values from callers. Resolving a parameter back to the actor across calls is a later analyzer decision.
2. A `where` clause is a filter for every op, writes included (for example `update` filtered by `resource.id = param.id`).
3. Every class or function referenced by a rule or a call edge is a symbol.
4. `location.line` is the declaration line of the symbol (or `CREATE TABLE` line of the table).
