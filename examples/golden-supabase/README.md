# golden-supabase

Holdline's acceptance app for Postgres with Supabase row level security. A Next.js app whose data
access is governed by RLS policies in `supabase/migrations/`.

| File | What |
|---|---|
| `supabase/migrations/*.sql` | The schema and RLS policies Holdline reads |
| `expected-rules.yaml` | The approved rules a careful engineer would write for this app |
| `breakages/R-xxx.patch` | One unified diff per rule, against this folder, that breaks exactly that rule |

The acceptance test (`packages/cli/test/golden-patch.test.ts`) copies this folder, applies each
patch, runs `holdline scan` and `holdline check`, and expects exactly that rule to fail. The
Postgres track (spec: docs/superpowers/specs/2026-10-21-data-layers-design.md, section 6.1) fills in
the app, rules and breakages.
