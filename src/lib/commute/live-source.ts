import { fetchBusRoute } from '../../mta/client.js';
import type { CommuteObservationSource } from './types.js';

/** Server-only composition. Credential stays in this closure, never in a decision. */
export function createMtaCommuteSource(options: { apiKey: string; stopId: string; directionId: string; routeId: string }, fetcher: typeof fetch = fetch): CommuteObservationSource {
  if (!/^MTA NYCT_[A-Z0-9]+$/.test(options.routeId ?? '') || !options.apiKey.trim() || !/^\d+$/.test(options.stopId) || !/^[01]$/.test(options.directionId)) throw new Error('INVALID_MTA_SOURCE_CONFIGURATION');
  const { apiKey, stopId, directionId } = options;
  const routeId = options.routeId;
  const sanitized = <T>(value: T): T => JSON.parse(JSON.stringify(value).replaceAll(apiKey, '[REDACTED]').replaceAll(encodeURIComponent(apiKey), '[REDACTED]').replaceAll(JSON.stringify(apiKey).slice(1, -1), '[REDACTED]')) as T;
  return {
    async vehicleMonitoring() {
      try { return sanitized(await fetchBusRoute({ apiKey, routeId }, fetcher)); }
      catch { throw new Error('MTA_VM_FAILED'); }
    },
    async stopMonitoring() {
      try { return sanitized(await fetchBusRoute({ apiKey, routeId, stopId, directionId }, fetcher)); }
      catch { throw new Error('MTA_SM_FAILED'); }
    },
  };
}
