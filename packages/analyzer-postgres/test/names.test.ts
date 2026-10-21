import { parseFacts, type Expr, type Policy } from '@holdline/core'
import { describe, expect, it, vi } from 'vitest'
import { analyzeMigrations } from '../src/facts.js'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

// Operands and exists docs hold names as `[A-Za-z0-9_]+` segments (core's OPERAND_PATTERN); any other column,
// table or schema name makes the condition opaque instead of producing facts core rejects.
const SQL = `
create schema "my-app";
create table public.docs (id uuid primary key, "owner-id" uuid, créé uuid, org_id uuid);
alter table public.docs enable row level security;
create table public.members (org_id uuid, "user-id" uuid, user_id uuid);
create table public."odd-members" (org_id uuid, user_id uuid);
create table "my-app".members (org_id uuid, user_id uuid);
create policy quoted on public.docs for select using ("owner-id" = auth.uid());
create policy accented on public.docs for delete using (créé = auth.uid());
create policy inner_column on public.docs for insert with check (exists (select 1 from members m where m.org_id = docs.org_id and m."user-id" = auth.uid()));
create policy inner_table on public.docs for update using (exists (select 1 from "odd-members" m where m.org_id = docs.org_id and m.user_id = auth.uid()));
create policy inner_schema on public.docs for update using (org_id in (select m.org_id from "my-app".members m where m.user_id = auth.uid()));
`

function hasOpaque(e: Expr): boolean {
  if ('and' in e) return e.and.some(hasOpaque)
  if ('or' in e) return e.or.some(hasOpaque)
  if ('not' in e) return hasOpaque(e.not)
  return 'opaque' in e
}

describe('names outside [A-Za-z0-9_]', () => {
  it('give opaque conditions, and the output passes parseFacts', async () => {
    const out = await analyzeMigrations([{ path: 'm.sql', sql: SQL }], 'supabase')
    expect(out.diagnostics ?? []).toEqual([])
    const policies = out.policies as Policy[]
    expect(policies.map(p => p.id.split(':').at(-1))).toEqual(['accented', 'inner_column', 'inner_schema', 'inner_table', 'quoted', 'quoted'])
    for (const p of policies) expect(hasOpaque(p.condition), `${p.id} ${JSON.stringify(p.condition)}`).toBe(true)
    expect(() => parseFacts({ version: 1, ...out, analyzers: [{ name: 'postgres', version: '0.1.0' }] }, 'postgres')).not.toThrow()
  })
})
