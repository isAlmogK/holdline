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
