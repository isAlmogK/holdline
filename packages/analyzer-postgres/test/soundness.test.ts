import type { Expr, Op, Policy } from '@holdline/core'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { factsFromDatabase } from '../src/facts.js'
import { runMigrations, type MigrationRun } from '../src/migrate.js'
import { evaluate } from './helpers/model.js'
import { sqlAllows } from './helpers/sql-allows.js'
import { samples, U1 } from './helpers/worlds.js'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

// Spec 9: in every sampled world, if real Postgres allows the request, the analyzer's condition is true.

const SCHEMA = `
create role editors; grant editors to authenticated with inherit true;
create role visitors; grant visitors to anon with inherit true;
create table public.members (org_id uuid not null, user_id uuid not null, role text not null);
create table public.docs (id uuid primary key, org_id uuid, owner_id uuid, status text, n int, deleted_at timestamptz);
alter table public.docs enable row level security;
create function public.is_member(o uuid) returns boolean language sql stable security definer
  as $$ select exists (select 1 from public.members m where m.org_id = o and m.user_id = (select auth.uid())) $$;
`

let run: MigrationRun
beforeAll(async () => {
  run = await runMigrations([{ path: 'schema.sql', sql: SCHEMA }], 'supabase')
  if (run.failure) throw new Error(run.failure.message)
})
afterAll(async () => { await run?.db.close() }) // undefined when beforeAll failed

function hasOpaque(e: Expr): boolean {
  if ('and' in e) return e.and.some(hasOpaque)
  if ('or' in e) return e.or.some(hasOpaque)
  if ('not' in e) return hasOpaque(e.not)
  return 'opaque' in e || 'ref' in e
}

// Creates the policies, reads them back through the analyzer, and returns the OR of the op's policy conditions.
async function withPolicies<T>(policiesSql: string, op: Op, body: (condition: Expr) => Promise<T>): Promise<T> {
  await run.db.exec(policiesSql)
  try {
    const facts = await factsFromDatabase(run.db, 'supabase', [])
    const condition: Expr = { or: (facts.policies as Policy[]).filter(p => p.target === 'public.docs' && p.ops.includes(op)).map(p => p.condition) }
    return await body(condition)
  } finally {
    const names = (await run.db.query<{ polname: string }>(`select polname from pg_policy where polrelid = 'public.docs'::regclass`)).rows
    for (const { polname } of names) await run.db.exec(`drop policy "${polname}" on public.docs`)
  }
}

// Update needs a caller, a USING row and a WITH CHECK row to line up, so it gets more worlds.
const COUNT: Record<Op, number> = { read: 150, list: 150, create: 150, delete: 150, update: 400 }

// anonKey: some world allowed by the SQL is an anonymous caller carrying the anon key's claims.
async function checkSound(policiesSql: string, op: Op, seed: number, opts: { anonKey?: boolean } = {}): Promise<void> {
  await withPolicies(policiesSql, op, async condition => {
    expect(hasOpaque(condition), JSON.stringify(condition)).toBe(false)
    let allowed = 0
    let denied = 0
    let anonKeyAllowed = 0
    for (const s of samples(COUNT[op], seed)) {
      const sql = await sqlAllows(run.db, s, op)
      if (sql) allowed++; else denied++
      if (sql && !s.world.actor && s.jwt) anonKeyAllowed++
      if (sql) expect(evaluate(condition, s.world), `SQL allowed but Expr false: ${JSON.stringify({ s, condition })}`).toBe(true)
    }
    expect(allowed, 'no world was allowed').toBeGreaterThan(0)
    expect(denied, 'no world was denied').toBeGreaterThan(0)
    if (opts.anonKey) expect(anonKeyAllowed, 'no anon-key world was allowed').toBeGreaterThan(0)
  })
}

const select = (using: string, to = 'anon, authenticated', name = 'p') =>
  `create policy ${name} on public.docs for select to ${to} using (${using});`
// UPDATE and DELETE with a WHERE clause also apply SELECT policies; this one lets every row be seen.
const SEE_ALL = 'create policy see on public.docs for select using (true);'

describe('normalization is never stronger than the SQL', () => {
  const cases: [string, string, Op, { anonKey?: boolean }?][] = [
    ['auth.uid() = column', select('owner_id = auth.uid()'), 'read'],
    ['(select auth.uid())', select('(select auth.uid()) = owner_id'), 'read'],
    ['auth.uid()::text', select(`auth.uid()::text = '${U1}'`), 'read'],
    ['jwt claim', select("(auth.jwt() ->> 'user_role') = 'admin'"), 'read'],
    ['nested jwt claim', select("(auth.jwt() -> 'app_metadata' ->> 'tier') = 'gold'"), 'read'],
    ['auth.role()', select("auth.role() = 'authenticated'"), 'read'],
    ["auth.role() = 'anon'", select("auth.role() = 'anon' or status = 'a'"), 'read'],
    ['<>', select("status <> 'a'"), 'read'],
    ['<', select('n < 3'), 'read'],
    ['>', select('n > 3'), 'read'],
    ['IN list', select("status in ('a', 'b')"), 'read'],
    ['= ANY (ARRAY)', select('n = any (array[0, 5])'), 'read'],
    ['IS NULL', select('deleted_at is null'), 'read'],
    ['IS NOT NULL', select('deleted_at is not null'), 'read'],
    ['auth.uid() IS NOT NULL', select('auth.uid() is not null'), 'read'],
    ['auth.uid() IS NULL', select("auth.uid() is null or status = 'a'"), 'read'],
    ['AND OR NOT', select("not (owner_id = auth.uid()) or (status = 'a' and n > 3)"), 'read'],
    ['true', select('true', 'authenticated'), 'read'], // to authenticated, so anonymous callers are denied
    ['false', select('false') + select("status = 'a'", undefined, 'q'), 'read'],
    ['EXISTS', select('exists (select 1 from public.members m where m.org_id = docs.org_id and m.user_id = auth.uid())'), 'read'],
    ['IN (SELECT)', select('org_id in (select org_id from public.members where user_id = auth.uid())'), 'read'],
    ['helper function', select('public.is_member(org_id)'), 'read'],
    ['WITH CHECK on insert', 'create policy p on public.docs for insert to authenticated with check (owner_id = auth.uid() and public.is_member(org_id));', 'create'],
    ['USING and WITH CHECK on update', `${SEE_ALL} create policy p on public.docs for update to authenticated using (owner_id = auth.uid()) with check (status = 'a');`, 'update'],
    ['USING as WITH CHECK on update', `${SEE_ALL} create policy p on public.docs for update to authenticated using (owner_id = auth.uid());`, 'update'],
    ['update for authenticated and anon', `${SEE_ALL} create policy p on public.docs for update to authenticated using ((select auth.uid()) = owner_id);
      create policy q on public.docs for update to anon using (status = 'a');`, 'update'],
    ['two permissive update policies', `${SEE_ALL} create policy a on public.docs for update using (owner_id = auth.uid()) with check (status = 'draft');
      create policy b on public.docs for update using (status = 'submitted') with check (status = 'submitted');`, 'update'],
    ['delete', `${SEE_ALL} create policy p on public.docs for delete to authenticated using (owner_id = auth.uid());`, 'delete'],
    ['FOR ALL', 'create policy p on public.docs to authenticated using (owner_id = auth.uid());', 'update'],
    ['restrictive', select('true') + " create policy r on public.docs as restrictive for select using (status = 'a');", 'read'],
    ['restrictive for anon only', select('true') + " create policy r on public.docs as restrictive for select to anon using (status = 'a');", 'read'],
    ['restrictive for authenticated only', select('true') + " create policy r on public.docs as restrictive for select to authenticated using (owner_id = auth.uid());", 'read'],
    ['anon-only permissive', select("status = 'a'", 'anon') + select('owner_id = auth.uid()', 'authenticated', 'q'), 'read'],
    ["jwt role = 'anon'", select("(auth.jwt() ->> 'role') = 'anon' or status = 'a'"), 'read', { anonKey: true }],
    ["jwt role = 'authenticated'", select("(auth.jwt() ->> 'role') = 'authenticated'"), 'read'],
    ['auth.role() IN list', select("auth.role() in ('authenticated', 'service_role')"), 'read'],
    ['restrictive update', `${SEE_ALL} create policy p on public.docs for update using (true);
      create policy r on public.docs as restrictive for update using (owner_id = auth.uid()) with check (status = 'a');`, 'update'],
    ['restrictive insert', `create policy p on public.docs for insert with check (true);
      create policy r on public.docs as restrictive for insert to authenticated with check (owner_id = auth.uid());`, 'create', { anonKey: true }],
    ['anon-only permissive insert', `create policy p on public.docs for insert to anon with check (status = 'a');
      create policy q on public.docs for insert to authenticated with check (owner_id = auth.uid());`, 'create', { anonKey: true }],
    ['anon-only permissive delete', `${SEE_ALL} create policy p on public.docs for delete to anon using (status = 'a');
      create policy q on public.docs for delete to authenticated using (owner_id = auth.uid());`, 'delete', { anonKey: true }],
    ['jwt claim <>', select("(auth.jwt() ->> 'user_role') <> 'member'"), 'read'], // user_role is 'admin' or absent
    ['jwt claim IN list', select("(auth.jwt() -> 'app_metadata' ->> 'tier') in ('gold', 'silver')"), 'read'],
    ['column <> auth.uid()', select('owner_id <> auth.uid()'), 'read'],
    ['literal < column', select('3 < n'), 'read', { anonKey: true }],
    ['custom role granted to authenticated', select("owner_id = auth.uid() or status = 'a'", 'editors'), 'read'],
    ['custom role granted to anon', select("status = 'a'", 'visitors') + select('owner_id = auth.uid()', 'authenticated', 'q'), 'read', { anonKey: true }],
  ]
  cases.forEach(([name, sql, op, opts], i) => {
    it(name, async () => { await checkSound(sql, op, 1000 + i, opts) })
  })

  // Shapes the analyzer keeps opaque on purpose; the property would be vacuous, so check the opaque instead.
  const opaque: [string, string][] = [
    // Under NOT, the subquery may see fewer rows than the model assumes (RLS on the inner table).
    ['NOT EXISTS', 'not exists (select 1 from public.members m where m.org_id = docs.org_id and m.user_id = auth.uid())'],
    // An anonymous caller's role is 'anon', which no actor.role atom can be true for.
    ["auth.role() IN list with 'anon'", "auth.role() in ('anon', 'authenticated')"],
    // The role claim is 'anon' for an anonymous caller, so `<> 'anon'` is not "any actor".
    ['jwt role <>', "(auth.jwt() ->> 'role') <> 'anon'"],
  ]
  for (const [name, using] of opaque) {
    it(`${name} stays opaque`, async () => {
      await withPolicies(select(using), 'read', async condition => { expect(hasOpaque(condition), JSON.stringify(condition)).toBe(true) })
    })
  }
})
