// The roles a case acts as, and switching to the case's actor inside its transaction (spec 5.2 step 2).
import type { PGlite } from '@electric-sql/pglite'
import type { TestCase } from '@holdline/core'
import { quoteIdent, type Queryable } from './pg-schema.js'
import { isUuid, uuidV5 } from './values.js'

export type Dialect = 'supabase' | 'plain'

export const PLAIN_ROLE = 'holdline_actor'

// Schemas that hold the project's tables (not the platform's or the catalog's).
async function userSchemas(db: Queryable): Promise<string[]> {
  const r = await db.query<{ name: string }>(
    `select distinct n.nspname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where c.relkind in ('r', 'p') and n.nspname not in ('auth', 'storage', 'extensions', 'information_schema')
       and n.nspname not like 'pg\\_%' order by 1`,
  )
  return r.rows.map(x => x.name)
}

export async function prepareRoles(db: PGlite, dialect: Dialect): Promise<void> {
  if (dialect === 'plain') {
    await db.exec(`do $$ begin
      if not exists (select 1 from pg_roles where rolname = '${PLAIN_ROLE}') then create role ${PLAIN_ROLE} nologin; end if;
    end $$`)
  }
  const roles = dialect === 'supabase' ? 'anon, authenticated' : PLAIN_ROLE
  for (const schema of await userSchemas(db)) {
    const s = quoteIdent(schema)
    await db.exec(`grant usage on schema ${s} to ${roles};
      grant all on all tables in schema ${s} to ${roles};
      grant all on all sequences in schema ${s} to ${roles};`)
  }
}

// A claim whose string value was mapped to a UUID elsewhere in the case gets that UUID.
function mapClaim(value: unknown, uuids: Map<string, string>): unknown {
  if (typeof value === 'string') return uuids.get(value) ?? value
  if (Array.isArray(value)) return value.map(v => mapClaim(v, uuids))
  return value
}

export function claimsFor(as: NonNullable<TestCase['as']>, uuids: Map<string, string>): Record<string, unknown> {
  const claims = Object.fromEntries(Object.entries(as.claims).map(([k, v]) => [k, mapClaim(v, uuids)]))
  return { ...claims, sub: isUuid(as.uid) ? as.uid : uuidV5(as.uid), role: as.role ?? 'authenticated' }
}

// Call after the case's rows are mapped, so claims see every UUID the case assigned.
export async function actAs(tx: Queryable, dialect: Dialect, as: TestCase['as'], uuids: Map<string, string>): Promise<void> {
  const role = dialect === 'plain' ? PLAIN_ROLE : as ? 'authenticated' : 'anon'
  await tx.query(`set local role ${role}`)
  const claims = as ? claimsFor(as, uuids) : dialect === 'supabase' ? { role: 'anon' } : undefined
  if (claims) await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)])
}
