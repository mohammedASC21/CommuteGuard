import 'server-only';
import { DEFAULT_COMMUTE, CommuteDecisionService, createMtaCommuteSource } from '../lib/commute/index.js';

import { createHistoryBackend } from '../lib/history/backend.js';

let service: CommuteDecisionService | undefined;
/** Only the service object is process-local; configured database history is shared. */
export function getCommuteService(): CommuteDecisionService {
  const apiKey = process.env.MTA_BUS_TIME_API_KEY;
  const stopId = DEFAULT_COMMUTE.target.stopId.replace(/^MTA_/, '');
  const directionId = DEFAULT_COMMUTE.target.directionId;
  if (!apiKey || process.env.MTA_STOP_ID !== stopId || process.env.MTA_DIRECTION_ID !== directionId) throw new Error('COMMUTE_CONFIGURATION_UNAVAILABLE');
  service ??= new CommuteDecisionService({
    history: history().store,
    source: createMtaCommuteSource({ apiKey, routeId: DEFAULT_COMMUTE.target.routeId, stopId, directionId }),
    clock: () => new Date().toISOString(),
  });
  return service;
}

let binding: ReturnType<typeof createHistoryBackend> | undefined;
function history() { return binding ??= createHistoryBackend(process.env); }
export function getHistoryBackendName() { return history().backend; }
