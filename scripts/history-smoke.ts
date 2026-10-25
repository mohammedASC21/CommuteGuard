import { randomUUID } from 'node:crypto';
import { createHistoryBackend } from '../src/lib/history/backend.js';
import { DEFAULT_COMMUTE } from '../src/lib/commute/types.js';
import { commuteScope } from '../src/lib/history/scope.js';
import { SupabaseObservationHistory } from '../src/lib/history/supabase-history.js';

async function main() {
  if (!process.argv.includes('--live') || createHistoryBackend(process.env).backend !== 'SUPABASE') {
    console.error('LIVE_DATABASE_SMOKE_NOT_RUN: requires --live, server Supabase configuration and applied migration.');
    process.exitCode = 1; return;
  }
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const url = process.env.SUPABASE_URL!;
  const scope = commuteScope(DEFAULT_COMMUTE, `test_${randomUUID()}`);
  const options = { url, secretKey: key, scope, redactions: [process.env.MTA_BUS_TIME_API_KEY ?? ''] };
  let attempted = false;
  try {
    const completedAt = new Date().toISOString();
    const acquisitionId = randomUUID();
    const a = new SupabaseObservationHistory(options);
    attempted = true;
    await a.add({ acquisitionId, completedAt, errors: ['ACQUISITION_FAILURE'] });
    const b = new SupabaseObservationHistory(options);
    const frames = await b.getRecent(completedAt);
    if (frames.length !== 1 || frames[0]?.acquisitionId !== acquisitionId) throw new Error();
    console.log('LIVE_DATABASE_CROSS_INSTANCE: PASS (isolated synthetic test scope; no MTA calls)');
  } finally {
    if (attempted) {
      // Only the newly generated test scope can be removed; the active commute scope is untouched.
      const endpoint = new URL('/rest/v1/commute_observation_frames', url);
      endpoint.searchParams.set('scope_id', `eq.${scope}`);
      const headers: Record<string, string> = { apikey: key };
      if (!key.startsWith('sb_secret_')) headers.Authorization = `Bearer ${key}`;
      const response = await fetch(endpoint, { method: 'DELETE', headers, signal: AbortSignal.timeout(10000), redirect: 'error' });
      if (!response.ok) throw new Error();
      console.log('LIVE_DATABASE_TEST_CLEANUP: PASS');
    }
  }
}
main().catch(() => { console.error('LIVE_DATABASE_SMOKE_FAILED: sensitive details omitted; check migration/configuration.'); process.exitCode = 1; });
