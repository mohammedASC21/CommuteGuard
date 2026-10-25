import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';

export async function migratedDb(directory?: string): Promise<PGlite> {
  const db = new PGlite(directory);
  await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
  await db.exec(await readFile(new URL('../../supabase/migrations/202610200001_observation_history.sql', import.meta.url), 'utf8'));
  return db;
}
/** Offline REST boundary backed by real migrated PostgreSQL, not a canned result. */
export function sqlRest(db: PGlite): typeof fetch {
  return async (input, init) => {
    const name = new URL(String(input)).pathname.split('/').at(-1);
    const p = JSON.parse(String(init?.body)) as Record<string, unknown>;
    try {
      let result: unknown;
      if (name === 'cg_append_frame') {
        await db.query('select public.cg_append_frame($1,$2,$3,$4::jsonb,$5)', [p.p_scope, p.p_acquisition_id, p.p_completed_at, JSON.stringify(p.p_frame), p.p_retention_seconds]);
        result = null;
      } else if (name === 'cg_recent_frames') {
        const r = await db.query<{ value: unknown }>('select public.cg_recent_frames($1,$2,$3,$4) as value', [p.p_scope, p.p_evaluated_at, p.p_window_seconds, p.p_limit]);
        result = r.rows[0]!.value;
      } else if (name === 'cg_prune_history') {
        const r = await db.query<{ value: unknown }>('select public.cg_prune_history($1,$2) as value', [p.p_scope, p.p_retention_seconds]);
        result = r.rows[0]!.value;
      } else if (name === 'cg_claim_collection') {
        const r = await db.query<{ value: unknown }>('select public.cg_claim_collection($1,$2,$3,$4) as value', [p.p_scope, p.p_slot, p.p_id, p.p_token]);
        result = r.rows[0]!.value;
      } else if (name === 'cg_complete_collection') {
        await db.query('select public.cg_complete_collection($1,$2,$3,$4::jsonb,$5,$6)', [p.p_scope, p.p_slot, p.p_token, JSON.stringify(p.p_frame), p.p_result, p.p_retention_seconds]);
        result = null;
      } else if (name === 'cg_collection_status') {
        const r = await db.query<{ value: unknown }>('select public.cg_collection_status($1) as value', [p.p_scope]);
        result = r.rows[0]!.value;
      } else return new Response(null, { status: 404 });
      return Response.json(result);
    } catch { return Response.json({ error: 'DATABASE_REJECTED' }, { status: 400 }); }
  };
}
