import { parseSiri } from './siri.js';
import type { ObservationBatch } from './types.js';

export const BX10_ROUTE_ID = 'MTA NYCT_BX10';
export interface QueryOptions { apiKey: string; stopId?: string; directionId?: string }

/** Node/server only. Do not import into a client component. Never log request URLs. */
export async function fetchBusRoute(options: QueryOptions & { routeId: string }, fetcher: typeof fetch = fetch): Promise<ObservationBatch> {
  if (!/^MTA NYCT_[A-Z0-9]+$/.test(options.routeId)) throw new Error('INVALID_MTA_ROUTE_CONFIGURATION');
  if (!options.apiKey.trim()) throw new Error('MTA_BUS_TIME_API_KEY is required; obtain a Bus Time developer key at https://register.developer.obanyc.com/');
  if (options.stopId !== undefined && !/^\d+$/.test(options.stopId)) throw new Error('MTA_STOP_ID must be a numeric stop code');
  if (options.directionId !== undefined && !/^[01]$/.test(options.directionId)) throw new Error('MTA_DIRECTION_ID must be 0 or 1');
  const context = options.stopId ? 'stop' : 'vehicle';
  const url = new URL(`https://bustime-classic.mta.info/api/siri/${context}-monitoring.json`);
  url.search = new URLSearchParams({ key: options.apiKey, version: '2', LineRef: options.routeId,
    [context === 'vehicle' ? 'VehicleMonitoringDetailLevel' : 'StopMonitoringDetailLevel']: 'calls',
  }).toString();
  if (options.stopId) {
    url.searchParams.set('MonitoringRef', options.stopId);
    url.searchParams.set('OperatorRef', 'MTA');
  }
  if (options.directionId) url.searchParams.set('DirectionRef', options.directionId);
  let response: Response;
  try {
    response = await fetcher(url, { signal: AbortSignal.timeout(15_000), redirect: 'error', cache: 'no-store' });
  } catch {
    // Fetch errors can embed the key-bearing URL. Never expose the original error/cause.
    throw new Error('MTA_REQUEST_FAILED (network, timeout, or redirect)');
  }
  if (!response.ok) throw new Error(`MTA_HTTP_ERROR ${response.status}`);
  let raw: unknown;
  try { raw = await response.json(); } catch { throw new Error('MTA_INVALID_JSON'); }
  const batch = parseSiri(raw, context);
  for (const observation of batch.observations) {
    if (observation.routeId !== options.routeId) observation.issues.push('ROUTE_FILTER_MISMATCH');
    if (options.directionId && observation.staticAssignment.directionId !== options.directionId) observation.issues.push('DIRECTION_FILTER_MISMATCH');
    if (options.stopId && observation.monitoredCall?.staticReference.stopId !== `MTA_${options.stopId}`) observation.issues.push('STOP_FILTER_MISMATCH');
  }
  return batch;
}

/** Historical Bx10 adapter regression helper; active callers use explicit Bx28 route options. */
export function fetchBx10(options: QueryOptions, fetcher: typeof fetch = fetch): Promise<ObservationBatch> {
  return fetchBusRoute({ ...options, routeId: BX10_ROUTE_ID }, fetcher);
}
