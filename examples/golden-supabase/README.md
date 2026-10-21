# golden-supabase

Holdline's acceptance app for Postgres with Supabase row level security. A Next.js app whose data
access is governed by RLS policies in `supabase/migrations/`.

| File | What |
|---|---|
| `supabase/migrations/*.sql` | The schema and RLS policies Holdline reads |
| `expected-rules.yaml` | The approved rules a careful engineer would write for this app |
| `breakages/R-xxx.patch` | One unified diff per rule, against this folder, that breaks exactly that rule |

The `user_role` claim (R-004) is assumed to come from a Supabase custom access-token hook. The Next.js app
is never built or installed: Holdline reads only the migrations.

The acceptance test (`packages/cli/test/golden-patch.test.ts`) copies this folder, applies each
patch, runs `holdline scan` and `holdline check`, and expects exactly that rule to fail.
After editing `expected-rules.yaml`, run
`pnpm tsx scripts/approve-fixture.ts examples/golden-supabase/expected-rules.yaml`.

| Rule | Type | What it shows | Breakage |
|---|---|---|---|
| R-001 | data-access | `IN (SELECT …)` membership as `exists` | membership check replaced by `auth.uid() IS NOT NULL` |
| R-002 | data-access | `USING` on update | owner check replaced by a membership check |
| R-003 | data-access | `WITH CHECK` with an inlined helper function | helper call dropped |
| R-004 | data-access | a custom JWT claim | claim check dropped |
| R-005 | data-access | `EXISTS` membership; RLS on | `ENABLE ROW LEVEL SECURITY` dropped |
| R-006 | data-access | `IS NULL` | `deleted_at is null` dropped |
| R-007 | data-access | `USING` reused as `WITH CHECK` | policy loosened to `true` |
| R-008 | invariant | not-null | `not null` dropped |
| R-009 | invariant | foreign key | `references` dropped |
| R-010 | invariant | enum | enum widened with `alter type … add value` |
| R-011 | invariant | unique | unique constraint dropped |
| R-012 | invariant | check | check relaxed to `amount >= 0` |
