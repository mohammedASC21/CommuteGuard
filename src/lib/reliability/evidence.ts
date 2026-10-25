import type { VehicleObservation } from '../../mta/types.js';
import { PROVISIONAL_POLICY, validatePolicy } from './policy.js';
import type { EvidenceSample, JourneyContext, NegativeEvidenceFamily, ReliabilityEvidence, ReliabilityInput, ReliabilityPolicy, ReliabilityReason } from './types.js';

const seconds = (s?: string): number | undefined => s && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(s) && Number.isFinite(Date.parse(s)) ? Date.parse(s) / 1000 : undefined;
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const coords = (o?: VehicleObservation): o is VehicleObservation & { latitude: number; longitude: number } => Boolean(o && finite(o.latitude) && Math.abs(o.latitude) <= 90 && finite(o.longitude) && Math.abs(o.longitude) <= 180);
const tokens = (o?: VehicleObservation) => o?.progressStatus?.split(/[\s,]+/).filter(Boolean) ?? [];
const context = (o?: VehicleObservation): JourneyContext | undefined => o ? ({ vehicleId: o.vehicleId, routeId: o.routeId, serviceDate: o.serviceDate, tripId: o.tripId, blockId: o.blockId, directionId: o.staticAssignment.directionId, destinationId: o.staticAssignment.destinationId, destinationName: o.staticAssignment.destinationName }) : undefined;
const identity = (o?: VehicleObservation) => o?.vehicleId && o.tripId && o.serviceDate ? JSON.stringify([o.vehicleId, o.routeId, o.serviceDate, o.tripId, o.blockId, o.staticAssignment.directionId, o.staticAssignment.destinationId, o.staticAssignment.destinationName]) : undefined;
// Only source evidence, never acquisition/response times or changing ETA predictions.
const sourceEvidence = (o?: VehicleObservation) => o && JSON.stringify([
  o.source, o.context, identity(o), o.timestamp, o.latitude, o.longitude,
  o.progressRate, o.progressStatus, o.staticAssignment.originScheduledDeparture,
  o.monitoredCall?.staticReference.stopId,
  o.monitoredCall?.realtimePrediction.distanceFromStopMeters,
  o.monitoredCall?.realtimePrediction.stopsFromCall,
  o.onwardCalls.map(c => c.staticReference.stopId),
]);
/** Physical Earth-radius constant, not a policy threshold. Coordinates may be inferred by MTA. */
function meters(a: VehicleObservation & { latitude: number; longitude: number }, b: VehicleObservation & { latitude: number; longitude: number }): number {
  const radians = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * radians;
  const dLon = (b.longitude - a.longitude) * radians;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * radians) * Math.cos(b.latitude * radians) * Math.sin(dLon / 2) ** 2;
  return 6_371_000 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}

export function deriveReliabilityEvidence(input: ReliabilityInput, policy: Readonly<ReliabilityPolicy>): ReliabilityEvidence {
  validatePolicy(policy);
  const now = seconds(input.evaluatedAt);
  if (now === undefined) throw new Error('INVALID_EVALUATION_TIME');
  if (!input.vehicleId.trim() || !input.target.routeId.trim() || !input.target.stopId.trim() || !/^[01]$/.test(input.target.directionId)) throw new Error('INVALID_RELIABILITY_TARGET');
  const evidence: ReliabilityEvidence = { vehicleId: input.vehicleId, evaluatedAt: input.evaluatedAt, policy: Object.fromEntries((Object.keys(PROVISIONAL_POLICY) as (keyof ReliabilityPolicy)[]).map(key => [key, policy[key]])) as unknown as Readonly<ReliabilityPolicy>, target: { routeId: input.target.routeId, stopId: input.target.stopId, directionId: input.target.directionId, isOrigin: input.target.isOrigin }, samples: [], distinctCurrentTripObservations: 0, stableAssignmentObservations: 0, progressingObservations: 0, progressDistanceMeters: 0, negativeStreaks: { SOURCE_QUALITY: 0, AVAILABILITY: 0, ASSIGNMENT: 0, PROGRESSION: 0 }, reasonCodes: [] };
  let previous: { vm?: VehicleObservation; sm?: VehicleObservation; time?: number; signature?: string } | undefined;
  let previousSample: EvidenceSample | undefined;
  let previousPresent: boolean | undefined;
  let everPresent = false;
  let lastCompleted: number | undefined;
  for (const frame of input.frames) {
    const completed = seconds(frame.completedAt);
    if (completed !== undefined && completed < now - policy.historyWindowSeconds) continue;
    const reasons = new Set<ReliabilityReason>();
    const negative = new Set<NegativeEvidenceFamily>();
    const vms = frame.vm?.observations.filter(o => o.vehicleId === input.vehicleId) ?? [];
    const sms = frame.sm?.observations.filter(o => o.vehicleId === input.vehicleId) ?? [];
    const vm = vms[0]; const sm = sms[0];
    const present = Boolean(vm || sm);
    if (!present) { reasons.add('NO_REALTIME_CANDIDATE'); negative.add('AVAILABILITY'); }
    if (previousPresent && !present) reasons.add('CANDIDATE_DISAPPEARED');
    if (previousPresent === false && present && everPresent) reasons.add('CANDIDATE_REAPPEARED');
    previousPresent = present; everPresent ||= present;
    if (vms.length > 1 || sms.length > 1) reasons.add('AMBIGUOUS_CANDIDATE');
    if (frame.errors?.length || !frame.vm || !frame.sm) { reasons.add('REQUEST_FAILURE'); negative.add('SOURCE_QUALITY'); }
    if (frame.vm?.issues.length || frame.sm?.issues.length || vm?.issues.length || sm?.issues.length || (frame.vm && frame.vm.context !== 'vehicle') || (frame.sm && frame.sm.context !== 'stop') || (vm && vm.context !== 'vehicle') || (sm && sm.context !== 'stop')) { reasons.add('ADAPTER_ISSUE'); negative.add('SOURCE_QUALITY'); }
    if (completed === undefined || completed > now + policy.maxFutureSkewSeconds || (lastCompleted !== undefined && completed <= lastCompleted)) { reasons.add('INVALID_TIME'); negative.add('SOURCE_QUALITY'); }
    if (completed !== undefined && lastCompleted !== undefined && completed - lastCompleted > policy.maximumObservationGapSeconds) reasons.add('OBSERVATION_GAP');
    lastCompleted = completed;
    const previousTrip = tokens(vm).includes('prevTrip') || tokens(sm).includes('prevTrip');
    const layover = tokens(vm).includes('layover') || tokens(sm).includes('layover') || vm?.progressRate === 'layover' || sm?.progressRate === 'layover';
    if (previousTrip || vm?.progressRate === 'prevTrip' || sm?.progressRate === 'prevTrip') reasons.add('PREVIOUS_TRIP');
    if (layover) reasons.add('LAYOVER');
    if (vm?.progressRate === 'noProgress' || sm?.progressRate === 'noProgress') reasons.add('SOURCE_NO_PROGRESS');
    const vt = seconds(vm?.timestamp); const st = seconds(sm?.timestamp);
    const vr = seconds(frame.vm?.responseTimestamp); const sr = seconds(frame.sm?.responseTimestamp);
    for (const batch of [frame.vm, frame.sm]) for (const delivery of batch?.deliveries ?? []) {
      if (delivery.validUntil !== undefined) {
        const valid = seconds(delivery.validUntil);
        const reference = frame === input.frames.at(-1) ? now : completed;
        if (valid === undefined || reference === undefined || valid < reference) { reasons.add('ADAPTER_ISSUE'); negative.add('SOURCE_QUALITY'); }
      }
    }
    if ((vm && vt === undefined) || (sm && st === undefined)) { reasons.add('MISSING_TIMESTAMP'); negative.add('SOURCE_QUALITY'); }
    let age: number | undefined;
    const ages: number[] = [];
    for (const [o, t, r] of [[vm, vt, vr], [sm, st, sr]] as const) {
      if (!o) continue;
      if (r === undefined || completed === undefined || t === undefined || t > (r ?? now) + policy.maxFutureSkewSeconds || (r !== undefined && completed !== undefined && r > completed + policy.maxFutureSkewSeconds)) { reasons.add('INVALID_TIME'); negative.add('SOURCE_QUALITY'); }
      if (t !== undefined && r !== undefined && completed !== undefined) ages.push(Math.max(r - t, completed - t));
    }
    const isLast = frame === input.frames.at(-1);
    if (isLast) for (const t of [vt, st]) if (t !== undefined) ages.push(now - t);
    if (ages.length) {
      age = Math.max(...ages);
      if (age > policy.maxObservationAgeSeconds) { reasons.add('STALE_OBSERVATIONS'); negative.add('SOURCE_QUALITY'); }
      else if (vt !== undefined && st !== undefined && !reasons.has('INVALID_TIME')) reasons.add('FRESH_OBSERVATIONS');
      if (age > policy.severeObservationAgeSeconds) reasons.add('SEVERELY_STALE_OBSERVATIONS');
    }
    if (vt !== undefined && st !== undefined && Math.abs(vt - st) > policy.maxCrossSourceTimestampSkewSeconds || vr !== undefined && sr !== undefined && Math.abs(vr - sr) > policy.maxCrossSourceResponseSkewSeconds) reasons.add('CROSS_SOURCE_TIME_SKEW');
    if (coords(vm) && coords(sm) && meters(vm, sm) > policy.maxCrossSourcePositionDifferenceMeters) reasons.add('CROSS_SOURCE_POSITION_MISMATCH');
    if (!coords(vm) || !coords(sm)) reasons.add('COORDINATES_UNAVAILABLE');
    const stopMatch = sm?.monitoredCall?.staticReference.stopId === input.target.stopId;
    const vmTarget = vm?.monitoredCall?.staticReference.stopId === input.target.stopId || vm?.onwardCalls.some(c => c.staticReference.stopId === input.target.stopId);
    if (!stopMatch || !vmTarget) reasons.add('TARGET_STOP_UNCONFIRMED');
    const distance = stopMatch ? sm?.monitoredCall?.realtimePrediction.distanceFromStopMeters : undefined;
    const usableDistance = finite(distance) && distance >= 0 ? distance : undefined;
    if (usableDistance === undefined) reasons.add('DISTANCE_UNAVAILABLE');
    const routeMatch = [vm, sm].every(o => o?.routeId === input.target.routeId);
    const directionMatch = [vm, sm].every(o => o?.staticAssignment.directionId === input.target.directionId);
    const tripMatch = Boolean(vm?.tripId && sm?.tripId && vm.tripId === sm.tripId && vm.serviceDate && vm.serviceDate === sm.serviceDate);
    const destinationMatch = Boolean(vm && sm && vm.staticAssignment.destinationId && vm.staticAssignment.destinationId === sm.staticAssignment.destinationId && (!vm.staticAssignment.destinationName || !sm.staticAssignment.destinationName || vm.staticAssignment.destinationName === sm.staticAssignment.destinationName));
    if ([vm, sm].some(o => o && (!o.tripId || !o.serviceDate || !o.routeId || !o.staticAssignment.directionId || !o.staticAssignment.destinationId))) reasons.add('MISSING_ASSIGNMENT');
    const differs = (a?: string, b?: string) => Boolean(a && b && a !== b);
    const knownRouteMismatch = [vm, sm].some(o => o?.routeId && o.routeId !== input.target.routeId);
    const knownDirectionMismatch = [vm, sm].some(o => o?.staticAssignment.directionId && o.staticAssignment.directionId !== input.target.directionId);
    const blockConflict = Boolean(vm?.blockId && sm?.blockId && vm.blockId !== sm.blockId);
    // prevTrip explains journey/direction, never a route/service-date/vehicle inconsistency.
    if (knownRouteMismatch || (!reasons.has('PREVIOUS_TRIP') && knownDirectionMismatch)) { reasons.add('WRONG_ROUTE_OR_DIRECTION'); negative.add('ASSIGNMENT'); }
    const unexplained = Boolean(vm && sm && (knownRouteMismatch || differs(vm.serviceDate, sm.serviceDate) || blockConflict || (!reasons.has('PREVIOUS_TRIP') && (differs(vm.tripId, sm.tripId) || differs(vm.staticAssignment.directionId, sm.staticAssignment.directionId) || differs(vm.staticAssignment.destinationId, sm.staticAssignment.destinationId) || differs(vm.staticAssignment.destinationName, sm.staticAssignment.destinationName)))));
    if (unexplained) { reasons.add('UNEXPLAINED_JOURNEY_MISMATCH'); negative.add('ASSIGNMENT'); }
    if (tripMatch && routeMatch && directionMatch && destinationMatch && !reasons.has('PREVIOUS_TRIP')) reasons.add('CURRENT_TRIP_MATCH');
    const signature = vm && sm && identity(vm) && identity(sm) ? JSON.stringify([identity(vm), identity(sm)]) : undefined;
    if (previous?.signature && signature && signature !== previous.signature) reasons.add('ASSIGNMENT_TRANSITION');
    const t = vt !== undefined && st !== undefined ? Math.min(vt, st) : undefined;
    const sameIdentity = Boolean(signature && signature === previous?.signature);
    let delta: number | undefined;
    if (sameIdentity && t !== undefined && previous?.time !== undefined) {
      delta = t - previous.time;
      if (delta === 0) reasons.add('REPEATED_TIMESTAMP');
      if (delta < 0) { reasons.add('REGRESSING_TIMESTAMP'); negative.add('SOURCE_QUALITY'); }
      if (delta > policy.maximumObservationGapSeconds) reasons.add('OBSERVATION_GAP');
    }
    // Also catch independent source regression/repetition, even when the minimum timestamp hides it.
    if (sameIdentity) for (const [current, old] of [[vt, seconds(previous?.vm?.timestamp)], [st, seconds(previous?.sm?.timestamp)]] as const) {
      if (current !== undefined && old !== undefined && current < old) { reasons.add('REGRESSING_TIMESTAMP'); negative.add('SOURCE_QUALITY'); }
      if (current !== undefined && current === old) reasons.add('REPEATED_TIMESTAMP');
    }
    let movement: number | undefined; let distanceDelta: number | undefined;
    const beforeDistance = previous?.sm?.monitoredCall?.staticReference.stopId === input.target.stopId ? previous.sm.monitoredCall.realtimePrediction.distanceFromStopMeters : undefined;
    if (sameIdentity && delta !== undefined && delta > 0 && !reasons.has('REGRESSING_TIMESTAMP') && !reasons.has('REPEATED_TIMESTAMP') && !reasons.has('OBSERVATION_GAP')) {
      if (coords(sm) && coords(previous?.sm)) movement = meters(previous.sm, sm);
      if (usableDistance !== undefined && finite(beforeDistance) && beforeDistance >= 0) distanceDelta = usableDistance - beforeDistance;
      if (distanceDelta !== undefined && distanceDelta < 0) reasons.add('PROGRESS_TOWARD_TARGET');
      if (distanceDelta !== undefined && distanceDelta > 0 && !layover && !reasons.has('PREVIOUS_TRIP')) {
        reasons.add('MOVING_AWAY');
        if (distanceDelta >= policy.minimumProgressDistanceMeters) negative.add('PROGRESSION');
      }
      if (distanceDelta === 0 && movement !== undefined && movement < policy.minimumCoordinateMovementMeters && !layover && !reasons.has('PREVIOUS_TRIP')) { reasons.add('NO_PROGRESS'); negative.add('PROGRESSION'); }
    }
    const blockers: ReliabilityReason[] = ['NO_REALTIME_CANDIDATE', 'REQUEST_FAILURE', 'ADAPTER_ISSUE', 'AMBIGUOUS_CANDIDATE', 'INVALID_TIME', 'MISSING_TIMESTAMP', 'MISSING_ASSIGNMENT', 'STALE_OBSERVATIONS', 'PREVIOUS_TRIP', 'LAYOVER', 'SOURCE_NO_PROGRESS', 'CROSS_SOURCE_TIME_SKEW', 'CROSS_SOURCE_POSITION_MISMATCH', 'COORDINATES_UNAVAILABLE', 'TARGET_STOP_UNCONFIRMED', 'DISTANCE_UNAVAILABLE', 'WRONG_ROUTE_OR_DIRECTION', 'UNEXPLAINED_JOURNEY_MISMATCH', 'REGRESSING_TIMESTAMP', 'REPEATED_TIMESTAMP', 'OBSERVATION_GAP', 'MOVING_AWAY', 'NO_PROGRESS'];
    const neutralDuplicate = sameIdentity && reasons.has('REPEATED_TIMESTAMP')
      && sourceEvidence(vm) === sourceEvidence(previous?.vm) && sourceEvidence(sm) === sourceEvidence(previous?.sm)
      && !blockers.some(r => r !== 'REPEATED_TIMESTAMP' && reasons.has(r));
    if (reasons.has('REPEATED_TIMESTAMP') && !neutralDuplicate) negative.add('SOURCE_QUALITY');
    const compatible = neutralDuplicate ? previousSample?.currentTripCompatible === true
      : reasons.has('CURRENT_TRIP_MATCH') && Boolean(signature) && !blockers.some(r => reasons.has(r));
    const previousCompatible = previousSample?.currentTripCompatible === true;
    if (!neutralDuplicate && (!compatible || !sameIdentity)) {
      evidence.distinctCurrentTripObservations = 0; evidence.stableAssignmentObservations = 0;
      evidence.progressingObservations = 0; evidence.progressDistanceMeters = 0;
    }
    if (compatible && !neutralDuplicate) {
      evidence.distinctCurrentTripObservations++; evidence.stableAssignmentObservations++;
      if (previousCompatible && sameIdentity && distanceDelta !== undefined && distanceDelta < 0 && movement !== undefined && movement >= policy.minimumCoordinateMovementMeters) {
        evidence.progressingObservations++; evidence.progressDistanceMeters += -distanceDelta;
      }
    }
    if (!neutralDuplicate) for (const family of Object.keys(evidence.negativeStreaks) as NegativeEvidenceFamily[]) evidence.negativeStreaks[family] = negative.has(family) ? evidence.negativeStreaks[family] + 1 : 0;
    const sample: EvidenceSample = { completedAt: frame.completedAt, vm: context(vm), sm: context(sm), vmTimestamp: vm?.timestamp, smTimestamp: sm?.timestamp, vmResponseTimestamp: frame.vm?.responseTimestamp, smResponseTimestamp: frame.sm?.responseTimestamp, vmValidUntil: frame.vm?.deliveries.map(d => d.validUntil), smValidUntil: frame.sm?.deliveries.map(d => d.validUntil), vehicleAgeSeconds: age, vmProgressRate: vm?.progressRate, smProgressRate: sm?.progressRate, vmProgressStatus: vm?.progressStatus, smProgressStatus: sm?.progressStatus, predictedArrival: sm?.monitoredCall?.realtimePrediction.expectedArrival, scheduledOriginDeparture: sm?.staticAssignment.originScheduledDeparture, targetDistanceMeters: usableDistance, stopsFromCall: stopMatch ? sm?.monitoredCall?.realtimePrediction.stopsFromCall : undefined, coordinateMovementMeters: movement, targetDistanceDeltaMeters: distanceDelta, sourceTimestampDeltaSeconds: delta, reasons: [...reasons], currentTripCompatible: compatible, advancingDistinctObservation: compatible && (!sameIdentity || (delta !== undefined && delta > 0)) };
    evidence.samples.push(sample);
    sample.neutralSourceDuplicate = neutralDuplicate;
    if (!neutralDuplicate) {
      previous = { vm, sm, time: t, signature };
      previousSample = sample;
    }
  }
  evidence.latest = evidence.samples.at(-1);
  evidence.reasonCodes = [...new Set(evidence.samples.flatMap(s => s.reasons))];
  return evidence;
}
