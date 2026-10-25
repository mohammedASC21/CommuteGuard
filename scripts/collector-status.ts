import { createHistoryBackend } from '../src/lib/history/backend.js';
import { SupabaseObservationHistory } from '../src/lib/history/supabase-history.js';
import { collectionSchedule, collectionStart, collectionWindow } from '../src/lib/collector/schedule.js';
async function main() {
  const schedule = collectionSchedule(process.env), binding = createHistoryBackend(process.env);
  const now = new Date().toISOString();
  const metadata = { backend: binding.backend, activeCommute: 'BX28 / 103617 / DIRECTION 1', timezone: schedule.timezone, days: schedule.days, departure: schedule.departure, collectionWindow: `${collectionStart(schedule)}–${schedule.departure}`, cadenceSeconds: schedule.intervalSeconds, insideWindow: collectionWindow(now, schedule).allowed, cronSecretConfigured: (process.env.COMMUTEGUARD_CRON_SECRET?.length ?? 0) >= 32, productionCronActive: 'NOT_INFERRED_FROM_LOCAL_CONFIGURATION' };
  if (binding.backend !== 'SUPABASE' || !(binding.store instanceof SupabaseObservationHistory)) throw new Error();
  const [status, frames] = await Promise.all([binding.store.collectionStatus(), binding.store.getRecent(now)]);
  console.log(JSON.stringify({ ...metadata, ...status, recentFrameCount: frames.length }, null, 2));
}
main().catch(() => { console.error('COLLECTOR_STATUS_UNAVAILABLE: check backend, connectivity and Phase 6 migration; sensitive details omitted.'); process.exitCode = 1; });
