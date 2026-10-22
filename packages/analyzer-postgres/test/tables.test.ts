import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { runMigrations, type MigrationRun } from '../src/migrate.js'
import { checkExpr, readTables, shortDefault, shortType } from '../src/tables.js'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const SQL = `
create type public.member_role as enum ('owner', 'admin', 'member');
create table public.orgs (id uuid primary key default gen_random_uuid(), name varchar(40) not null default 'x');
create table public.members (
  org_id uuid not null references public.orgs (id),
  user_id uuid not null,
  role public.member_role not null default 'member',
  joined timestamp(3) with time zone,
  constraint members_org_user_key unique (org_id, user_id)
);
create unique index members_user_only on public.members (user_id) where role = 'owner';
create unique index members_joined on public.members (joined);
create table public.invoices (id int primary key, amount int not null check (amount > 0));
alter table public.invoices enable row level security;
`

let run: MigrationRun
beforeAll(async () => { run = await runMigrations([{ path: 'm.sql', sql: SQL }], 'supabase') })
afterAll(async () => { await run.db.close() })

describe('readTables', () => {
  it('reads columns, keys, uniques, checks, enums and RLS, without the shim schemas', async () => {
    const tables = await readTables(run.db, ['auth', 'storage', 'extensions'])
    expect(tables.map(t => t.id)).toEqual(['pg:public.invoices', 'pg:public.members', 'pg:public.orgs'])
    const [invoices, members, orgs] = tables
    expect(orgs).toEqual({
      id: 'pg:public.orgs', name: 'public.orgs',
      columns: [
        { name: 'id', type: 'uuid', nullable: false, default: 'gen_random_uuid()' },
        { name: 'name', type: 'varchar(40)', nullable: false, default: "'x'" },
      ],
      primaryKey: ['id'], foreignKeys: [], uniques: [], checks: [], enums: [], rlsEnabled: false,
    })
    expect(members!.columns[2]).toEqual({ name: 'role', type: 'member_role', nullable: false, default: "'member'" })
    expect(members!.columns[3]).toEqual({ name: 'joined', type: 'timestamptz(3)', nullable: true })
    expect(members!.foreignKeys).toEqual([{ columns: ['org_id'], references: { table: 'public.orgs', columns: ['id'] } }])
    // the partial unique index is not a uniqueness guarantee and is left out
    expect(members!.uniques).toEqual([['org_id', 'user_id'], ['joined']])
    expect(members!.enums).toEqual([{ column: 'role', values: ['owner', 'admin', 'member'] }])
    expect(invoices!.checks).toEqual([{ name: 'invoices_amount_check', expr: '(amount > 0)' }])
    expect(invoices!.rlsEnabled).toBe(true)
  })
})

describe('formatting', () => {
  it('shortens verbose types and keeps the rest', () => {
    expect(shortType('timestamp with time zone')).toBe('timestamptz')
    expect(shortType('timestamp(3) without time zone[]')).toBe('timestamp(3)[]')
    expect(shortType('time with time zone')).toBe('timetz')
    expect(shortType('character varying(20)')).toBe('varchar(20)')
    expect(shortType('character(1)')).toBe('char(1)')
    expect(shortType('integer')).toBe('integer')
    expect(shortType('numeric(12,2)')).toBe('numeric(12,2)')
  })
  it('drops the cast from a quoted literal default only', () => {
    expect(shortDefault("'member'::user_role")).toBe("'member'")
    expect(shortDefault("'it''s'::text")).toBe("'it''s'")
    expect(shortDefault('now()')).toBe('now()')
    expect(shortDefault("('a'::text || 'b'::text)")).toBe("('a'::text || 'b'::text)")
  })
  it('removes the outer CHECK and NOT VALID', () => {
    expect(checkExpr('CHECK ((amount > 0))')).toBe('(amount > 0)')
    expect(checkExpr('CHECK ((amount > 0)) NOT VALID')).toBe('(amount > 0)')
  })
})
