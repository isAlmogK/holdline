import type { Expr, Op, Policy } from '@holdline/core'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { factsFromDatabase } from '../src/facts.js'
import { runMigrations, type MigrationRun } from '../src/migrate.js'
import { evaluate, type Row, type World } from './helpers/model.js'

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 })

// Spec 9: in every sampled world, if real Postgres allows the request, the analyzer's condition is true.

const U1 = '00000000-0000-0000-0000-0000000000a1'
const U2 = '00000000-0000-0000-0000-0000000000a2'
const O1 = '00000000-0000-0000-0000-0000000000b1'
const O2 = '00000000-0000-0000-0000-0000000000b2'
const DOC = '00000000-0000-0000-0000-0000000000c1'
// The claims Supabase's anon key carries: the model's anonymous caller (actor null) still has these in SQL.
const ANON_KEY = { role: 'anon', iss: 'supabase', ref: 'demo', iat: 1700000000, exp: 2000000000 }

const SCHEMA = `
create table public.members (org_id uuid not null, user_id uuid not null, role text not null);
create table public.docs (id uuid primary key, org_id uuid, owner_id uuid, status text, n int, deleted_at timestamptz);
alter table public.docs enable row level security;
create function public.is_member(o uuid) returns boolean language sql stable security definer
  as $$ select exists (select 1 from public.members m where m.org_id = o and m.user_id = (select auth.uid())) $$;
`

// A world for the model, and the claims SQL sees (the anon key's, or none, for an anonymous caller).
interface Sample { world: World; jwt: Record<string, unknown> | null }

// A small deterministic generator (mulberry32), so failures reproduce.
function rng(seed: number) {
  let s = seed >>> 0
  return <T>(xs: readonly T[]): T => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return xs[((t ^ (t >>> 14)) >>> 0) % xs.length]!
  }
}

function samples(count: number, seed: number): Sample[] {
  const pick = rng(seed)
  const doc = (): Row => ({
    id: DOC, org_id: pick([O1, O2, null]), owner_id: pick([U1, U2, null]),
    status: pick(['a', 'b', 'draft', 'submitted', null]), n: pick([0, 5, null]),
    deleted_at: pick([null, '2026-01-01T00:00:00+00:00']),
  })
  const membership = [{ org_id: O1, user_id: U1, role: 'admin' }, { org_id: O2, user_id: U2, role: 'member' }, { org_id: O1, user_id: U2, role: 'member' }]
  return Array.from({ length: count }, () => {
    const uid = pick([null, U1, U2])
    const extra = pick([{}, { user_role: 'admin' }, { app_metadata: { tier: 'gold' } }])
    const actor = uid === null ? null : { uid, claims: { sub: uid, role: 'authenticated', aud: 'authenticated', ...extra } }
    const world: World = {
      actor, resource: doc(), incoming: doc(),
      tables: { 'public.members': membership.filter(() => pick([true, false])) },
    }
    return { world, jwt: actor ? actor.claims : pick([null, ANON_KEY]) }
  })
}

let run: MigrationRun
beforeAll(async () => {
  run = await runMigrations([{ path: 'schema.sql', sql: SCHEMA }], 'supabase')
  if (run.failure) throw new Error(run.failure.message)
})
afterAll(async () => { await run.db.close() })

const COLUMNS = ['id', 'org_id', 'owner_id', 'status', 'n', 'deleted_at'] as const
const values = (r: Row) => COLUMNS.map(c => r[c] ?? null)

// What real Postgres does for this sample and op, as the anon or authenticated role.
async function sqlAllows({ world: w, jwt }: Sample, op: Op): Promise<boolean> {
  const db = run.db
  await db.exec('begin')
  try {
    for (const m of w.tables['public.members'] ?? []) {
      await db.query('insert into public.members values ($1, $2, $3)', [m.org_id, m.user_id, m.role])
    }
    if (op !== 'create') await db.query('insert into public.docs values ($1, $2, $3, $4, $5, $6)', values(w.resource!))
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [jwt ? JSON.stringify(jwt) : ''])
    await db.exec(`set local role ${w.actor ? 'authenticated' : 'anon'}`)
    try {
      if (op === 'read') return (await db.query('select 1 from public.docs where id = $1', [DOC])).rows.length === 1
      if (op === 'create') { await db.query('insert into public.docs values ($1, $2, $3, $4, $5, $6)', values(w.incoming!)); return true }
      if (op === 'update') {
        const [, ...rest] = values(w.incoming!)
        const r = await db.query('update public.docs set org_id = $2, owner_id = $3, status = $4, n = $5, deleted_at = $6 where id = $1', [DOC, ...rest])
        return r.affectedRows === 1
      }
      return (await db.query('delete from public.docs where id = $1', [DOC])).affectedRows === 1
    } catch (e) {
      if ((e as { code?: string }).code === '42501') return false // new row violates row-level security policy
      throw e
    }
  } finally {
    await db.exec('rollback')
  }
}

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

async function checkSound(policiesSql: string, op: Op, seed: number): Promise<void> {
  await withPolicies(policiesSql, op, async condition => {
    expect(hasOpaque(condition), JSON.stringify(condition)).toBe(false)
    let allowed = 0
    let denied = 0
    for (const s of samples(150, seed)) {
      const sql = await sqlAllows(s, op)
      if (sql) allowed++; else denied++
      if (sql) expect(evaluate(condition, s.world), `SQL allowed but Expr false: ${JSON.stringify({ s, condition })}`).toBe(true)
    }
    expect(allowed, 'no world was allowed').toBeGreaterThan(0)
    expect(denied, 'no world was denied').toBeGreaterThan(0)
  })
}

const select = (using: string, to = 'anon, authenticated', name = 'p') =>
  `create policy ${name} on public.docs for select to ${to} using (${using});`
// UPDATE and DELETE with a WHERE clause also apply SELECT policies; this one lets every row be seen.
const SEE_ALL = 'create policy see on public.docs for select using (true);'

describe('normalization is never stronger than the SQL', () => {
  const cases: [string, string, Op][] = [
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
  ]
  cases.forEach(([name, sql, op], i) => {
    it(name, async () => { await checkSound(sql, op, 1000 + i) })
  })

  // Under NOT, the subquery may see fewer rows than the model assumes (RLS on the inner table), so the
  // analyzer keeps NOT EXISTS opaque: the property would be vacuous, so check the opaque instead.
  it('NOT EXISTS stays opaque', async () => {
    const sql = select('not exists (select 1 from public.members m where m.org_id = docs.org_id and m.user_id = auth.uid())')
    await withPolicies(sql, 'read', async condition => { expect(hasOpaque(condition)).toBe(true) })
  })
})
