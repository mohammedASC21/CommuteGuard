/** Explicit local opt-in only. No production endpoint/window bypass exists. */
import { randomUUID } from 'node:crypto';
import { createHistoryBackend } from '../src/lib/history/backend.js';
import { SupabaseObservationHistory } from '../src/lib/history/supabase-history.js';
import { commuteScope } from '../src/lib/history/scope.js';
import { createMtaCommuteSource, DEFAULT_COMMUTE } from '../src/lib/commute/index.js';
import { collectionSchedule, collectionWindow } from '../src/lib/collector/schedule.js';
import { collectScheduled } from '../src/lib/collector/collector.js';
async function main() {
  if (!process.argv.includes('--live') || process.env.NODE_ENV === 'production') throw new Error();
  const binding = createHistoryBackend(process.env);
  if (!(binding.store instanceof SupabaseObservationHistory) || binding.backend !== 'SUPABASE' || !process.env.MTA_BUS_TIME_API_KEY || process.env.MTA_STOP_ID !== '103617' || process.env.MTA_DIRECTION_ID !== '1') throw new Error();
  const id = commuteScope(DEFAULT_COMMUTE, `collector_live_smoke_${randomUUID()}`);
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const isolated = new SupabaseObservationHistory({ url: process.env.SUPABASE_URL!, secretKey: key, scope: id, redactions: [process.env.MTA_BUS_TIME_API_KEY, process.env.COMMUTEGUARD_CRON_SECRET].filter((s): s is string => !!s) });
  // Probe the migration before any MTA call or test write.
  await isolated.collectionStatus();
  const now = new Date().toISOString();
  const local = collectionWindow(now, collectionSchedule());
  const [h, m] = local.localTime.split(':').map(Number); const minute = h! * 60 + m! + 2;
  if (minute >= 1440) throw new Error();
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'long' }).format(new Date(now)).toUpperCase();
  const schedule = collectionSchedule({ COMMUTE_DAYS: weekday, COMMUTE_DEPARTURE_TIME: `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}` });
  let cleanup = false;
  try {
    const result = await collectScheduled({ scope: id, history: isolated, source: createMtaCommuteSource({ apiKey: process.env.MTA_BUS_TIME_API_KEY, stopId: '103617', directionId: '1', routeId: DEFAULT_COMMUTE.target.routeId }), schedule, clock: () => new Date().toISOString() }, now);
    if (!result.collected) throw new Error();
    const replacement = new SupabaseObservationHistory({ url: process.env.SUPABASE_URL!, secretKey: key, scope: id });
    const frames = await replacement.getRecent(new Date().toISOString());
    if (frames.length !== 1 || frames[0]!.acquisitionId !== result.acquisitionId) throw new Error();
    const status = await replacement.collectionStatus();
    console.log(JSON.stringify({ liveSmoke: 'PASS', backend: 'SUPABASE', isolatedScope: true, productionWindowUnchanged: true, reason: result.reason, framesPersisted: frames.length, survivedStoreReplacement: true, lastResult: status.lastResult }));
  } finally {
    const headers: Record<string, string> = { apikey: key }; if (!key.startsWith('sb_secret_')) headers.Authorization = `Bearer ${key}`;
    for (const table of ['commute_observation_frames', 'commute_collection_state']) {
      const url = new URL(`/rest/v1/${table}`, new URL(process.env.SUPABASE_URL!).origin); url.searchParams.set('scope_id', `eq.${id}`);
      const response = await fetch(url, { method: 'DELETE', headers, signal: AbortSignal.timeout(10000), redirect: 'error' });
      if (!response.ok) throw new Error();
    }
    cleanup = (await isolated.getRecent(new Date().toISOString())).length === 0 && (await isolated.collectionStatus()).state === 'NONE';
    console.log(JSON.stringify({ isolatedTestCleanup: cleanup ? 'PASS' : 'FAIL' }));
    if (!cleanup) throw new Error();
  }
}
main().catch(() => { console.error('LIVE_COLLECTOR_SMOKE_UNAVAILABLE: requires --live, hosted Phase 6 migration, development credentials and network access; details omitted.'); process.exitCode = 1; });
