import type { PGlite } from '@electric-sql/pglite'
import type { Op } from '@holdline/core'
import type { Row } from './model.js'
import { DOC, type Sample } from './worlds.js'

// The soundness test's tables: public.members and public.docs, the doc under test with id DOC.
const COLUMNS = ['id', 'org_id', 'owner_id', 'status', 'n', 'deleted_at'] as const
const values = (r: Row) => COLUMNS.map(c => r[c] ?? null)

// What real Postgres does for this sample and op, as the anon or authenticated role.
export async function sqlAllows(db: PGlite, { world: w, jwt }: Sample, op: Op): Promise<boolean> {
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
