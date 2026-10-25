import type { ReliabilityFrame } from '../reliability/types.js';
import type { ObservationBatch, StopCall, VehicleObservation } from '../../mta/types.js';

const fail = (): never => { throw new Error('INVALID_NORMALIZED_HISTORY'); };
const object = (x: unknown): Record<string, unknown> => x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : fail();
const array = (x: unknown): unknown[] => Array.isArray(x) ? x : fail();
const text = (x: unknown): string => typeof x === 'string' && x.length <= 4096 && !/https?:\/\/|[?&](?:key|apikey)=/i.test(x) ? x : fail();
const optionalText = (x: unknown): string | undefined => x === undefined ? undefined : text(x);
const optionalNumber = (x: unknown): number | undefined => x === undefined ? undefined : typeof x === 'number' && Number.isFinite(x) ? x : fail();
const codes = (x: unknown): string[] => array(x).map(v => /^[A-Za-z][A-Za-z0-9_]*$/.test(text(v)) ? text(v) : 'ADAPTER_ISSUE');
function call(value: unknown): StopCall {
  const c = object(value), s = object(c.staticReference), r = object(c.realtimePrediction);
  return { staticReference: { stopId: optionalText(s.stopId), stopName: optionalText(s.stopName), scheduledArrival: optionalText(s.scheduledArrival), scheduledDeparture: optionalText(s.scheduledDeparture) },
    realtimePrediction: { expectedArrival: optionalText(r.expectedArrival), expectedDeparture: optionalText(r.expectedDeparture), distanceFromStopMeters: optionalNumber(r.distanceFromStopMeters), stopsFromCall: optionalNumber(r.stopsFromCall) } };
}
function observation(value: unknown, context: 'vehicle' | 'stop'): VehicleObservation {
  const o = object(value), s = object(o.staticAssignment);
  if (o.source !== 'mta-bus-time-siri' || o.context !== context) fail();
  return { source: 'mta-bus-time-siri', context, vehicleId: optionalText(o.vehicleId), tripId: optionalText(o.tripId), serviceDate: optionalText(o.serviceDate), routeId: optionalText(o.routeId), timestamp: optionalText(o.timestamp), latitude: optionalNumber(o.latitude), longitude: optionalNumber(o.longitude), progressRate: optionalText(o.progressRate), progressStatus: optionalText(o.progressStatus), blockId: optionalText(o.blockId),
    staticAssignment: { directionId: optionalText(s.directionId), destinationId: optionalText(s.destinationId), destinationName: optionalText(s.destinationName), originScheduledDeparture: optionalText(s.originScheduledDeparture) },
    monitoredCall: o.monitoredCall === undefined ? undefined : call(o.monitoredCall), onwardCalls: array(o.onwardCalls).map(call), issues: codes(o.issues) };
}
function batch(value: unknown, context: 'vehicle' | 'stop'): ObservationBatch {
  const b = object(value);
  if (b.source !== 'mta-bus-time-siri' || b.context !== context) fail();
  if (array(b.observations).length > 64) fail();
  return { source: 'mta-bus-time-siri', context, responseTimestamp: optionalText(b.responseTimestamp),
    deliveries: array(b.deliveries).map(value => { const d = object(value); return { responseTimestamp: optionalText(d.responseTimestamp), validUntil: optionalText(d.validUntil) }; }),
    observations: array(b.observations).map(o => observation(o, context)), issues: codes(b.issues) };
}
/** Allowlist only normalized fields. Opaque acquisition ID is metadata, never source evidence. */
export function normalizedFrame(value: unknown): ReliabilityFrame & { acquisitionId: string } {
  const f = object(value), id = text(f.acquisitionId), completedAt = text(f.completedAt);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) || !Number.isFinite(Date.parse(completedAt))) fail();
  const result = { acquisitionId: id.toLowerCase(), completedAt: new Date(completedAt).toISOString(), vm: f.vm === undefined ? undefined : batch(f.vm, 'vehicle'), sm: f.sm === undefined ? undefined : batch(f.sm, 'stop'), errors: f.errors === undefined ? [] : array(f.errors).map(e => e === 'HISTORY_GAP' ? 'HISTORY_GAP' : 'ACQUISITION_FAILURE') };
  if (Buffer.byteLength(JSON.stringify(result)) > 1048576) fail();
  return result;
}
