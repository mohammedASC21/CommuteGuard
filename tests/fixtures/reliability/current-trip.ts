import type { ObservationBatch, VehicleObservation } from '../../../src/mta/types.js';
import type { ReliabilityFrame, ReliabilityInput } from '../../../src/lib/reliability/index.js';

/** Synthetic normalized input: not evidence of live terminal boarding availability. */
export const target = { routeId: 'MTA NYCT_BX10', stopId: 'MTA_103620', directionId: '0', isOrigin: true };
export const vehicleId = 'FIXTURE_VEHICLE';
export const time = (seconds: number) => new Date(Date.UTC(2026, 9, 20, 12, 0, seconds)).toISOString();
export function observation(index: number, context: 'vehicle' | 'stop'): VehicleObservation {
  return { source: 'mta-bus-time-siri', context, vehicleId, routeId: target.routeId, serviceDate: '2026-10-20', tripId: 'FIXTURE_CURRENT_TRIP', blockId: 'FIXTURE_BLOCK',
    timestamp: time(index * 30), latitude: 40.875 + index * 0.0002, longitude: -73.88,
    progressRate: 'normalProgress',
    staticAssignment: { directionId: '0', destinationId: 'MTA_FIXTURE_DEST', destinationName: 'RIVERDALE 263 ST' },
    monitoredCall: { staticReference: { stopId: target.stopId }, realtimePrediction: { distanceFromStopMeters: 500 - index * 40, stopsFromCall: 0 } },
    onwardCalls: [], issues: [] };
}
export function batch(index: number, context: 'vehicle' | 'stop'): ObservationBatch {
  return { source: 'mta-bus-time-siri', context, responseTimestamp: time(index * 30 + 1), deliveries: [{ responseTimestamp: time(index * 30 + 1), validUntil: time(index * 30 + 61) }], observations: [observation(index, context)], issues: [] };
}
export function frames(count = 5): ReliabilityFrame[] {
  return Array.from({ length: count }, (_, i) => ({ completedAt: time(i * 30 + 2), vm: batch(i, 'vehicle'), sm: batch(i, 'stop') }));
}
export function input(history = frames()): ReliabilityInput {
  return { vehicleId, target: { ...target }, frames: history, evaluatedAt: history.at(-1)?.completedAt ?? time(2) };
}

/** Preserve the original Bx10/origin regression independently of the active commute. */
export const commuteConfiguration = {
  route: 'Bx10', stopName: 'E 206 ST/ROCHAMBEAU AV', destination: 'RIVERDALE 263 ST',
  target: { ...target }, backupLabel: 'Walk to the D train.',
};
