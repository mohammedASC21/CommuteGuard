import 'server-only';
import { createHistoryBackend } from '../lib/history/backend.js';
import { SupabaseObservationHistory } from '../lib/history/supabase-history.js';
import { createMtaCommuteSource, DEFAULT_COMMUTE } from '../lib/commute/index.js';
import { collectScheduled } from '../lib/collector/collector.js';
import { collectionSchedule } from '../lib/collector/schedule.js';
import { assertProductionCollectionEnvironment } from '../lib/deployment/config.js';
export async function runCollection(intendedAt: string) {
  assertProductionCollectionEnvironment(process.env);
  const binding = createHistoryBackend(process.env);
  if (binding.backend !== 'SUPABASE' || !(binding.store instanceof SupabaseObservationHistory)) throw new Error('PERSISTENT_COLLECTOR_REQUIRED');
  const apiKey = process.env.MTA_BUS_TIME_API_KEY;
  if (!apiKey || process.env.MTA_STOP_ID !== '103617' || process.env.MTA_DIRECTION_ID !== '1') throw new Error('INVALID_ACTIVE_COMMUTE');
  return collectScheduled({ scope: binding.scope, history: binding.store, schedule: collectionSchedule(process.env), clock: () => new Date().toISOString(), source: createMtaCommuteSource({ apiKey, routeId: DEFAULT_COMMUTE.target.routeId, stopId: '103617', directionId: '1' }) }, intendedAt);
}
