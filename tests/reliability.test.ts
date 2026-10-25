import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import test from 'node:test';
import { assessReliability, classifyReliabilityEvidence, deriveReliabilityEvidence, PROVISIONAL_POLICY, validatePolicy } from '../src/lib/reliability/index.js';
import type { ReliabilityFrame } from '../src/lib/reliability/index.js';
import { frames, input, time, vehicleId } from './fixtures/reliability/current-trip.js';

function edit(history: ReliabilityFrame[], mutate: (o: NonNullable<ReliabilityFrame['vm']>['observations'][number], index: number) => void) {
  history.forEach((f, index) => { for (const b of [f.vm, f.sm]) for (const o of b?.observations ?? []) mutate(o, index); });
  return history;
}
function reason(result: ReturnType<typeof assessReliability>, code: typeof result.reasonCodes[number]) { assert.ok(result.reasonCodes.includes(code), `missing ${code}`); }

test('multiple current-trip fresh compatible progressing observations are VERIFIED at origin only after longer stable history', () => {
  const result = assessReliability(input());
  assert.equal(result.status, 'VERIFIED');
  assert.equal(result.evidence.distinctCurrentTripObservations, 5);
  assert.equal(result.evidence.progressingObservations, 4);
  reason(result, 'CURRENT_TRIP_MATCH'); reason(result, 'STABLE_ASSIGNMENT'); reason(result, 'PROGRESS_TOWARD_TARGET');
  assert.equal(assessReliability(input(frames(3))).status, 'UNVERIFIED');
});

test('one observation never verifies, including when policy tries to allow a single assignment', () => {
  assert.equal(assessReliability(input(frames(1))).status, 'UNVERIFIED');
  assert.throws(() => validatePolicy({ ...PROVISIONAL_POLICY, minimumDistinctObservations: 1 }));
  assert.throws(() => validatePolicy({ ...PROVISIONAL_POLICY, originMinimumStableAssignmentObservations: 1 }));
});

test('legitimate layover has advancing timestamps and stationary coordinates without false HIGH_GHOST_RISK', () => {
  const history = edit(frames(8), o => { o.latitude = 40.875; o.progressStatus = 'layover'; o.progressRate = 'noProgress'; o.monitoredCall!.realtimePrediction.distanceFromStopMeters = 0; });
  const result = assessReliability(input(history));
  assert.equal(result.status, 'UNVERIFIED'); reason(result, 'LAYOVER');
  assert.equal(result.evidence.negativeStreaks.PROGRESSION, 0);
});

test('prevTrip approach is future context, not current-trip verification or an unexplained journey mismatch', () => {
  const history = frames();
  for (const f of history) { const vm = f.vm!.observations[0]!; const sm = f.sm!.observations[0]!; vm.tripId = 'PREVIOUS'; vm.staticAssignment.directionId = '1'; sm.progressStatus = 'prevTrip'; }
  const result = assessReliability(input(history));
  assert.equal(result.status, 'UNVERIFIED'); reason(result, 'PREVIOUS_TRIP'); reason(result, 'PROGRESS_TOWARD_TARGET');
  assert.ok(!result.reasonCodes.includes('UNEXPLAINED_JOURNEY_MISMATCH'));
  assert.notEqual(result.journey?.current?.tripId, result.journey?.stopMonitoring?.tripId);
});

test('a single assignment transition resets stable observations', () => {
  const history = edit(frames(), (o, i) => { if (i < 4) { o.tripId = 'PRIOR'; o.staticAssignment.directionId = '1'; o.progressStatus = 'prevTrip'; } });
  const result = assessReliability(input(history));
  assert.equal(result.status, 'UNVERIFIED'); reason(result, 'ASSIGNMENT_TRANSITION');
  assert.equal(result.evidence.stableAssignmentObservations, 1);
});

test('stable current assignment with supportive motion is eligible under an explicit provisional policy', () => {
  const policy = { ...PROVISIONAL_POLICY, originMinimumStableAssignmentObservations: 3 };
  assert.equal(assessReliability(input(frames(3)), policy).status, 'VERIFIED');
});

test('stale observations cannot verify, and a lone weak quality signal is not automatically high risk', () => {
  const request = input(); request.evaluatedAt = time(300);
  const result = assessReliability(request);
  assert.equal(result.status, 'UNVERIFIED'); reason(result, 'STALE_OBSERVATIONS');
});

test('repeated timestamps with changed position/distance remain conflicting and block verification', () => {
  const history = frames(6);
  for (const b of [history[5]!.vm, history[5]!.sm]) b!.observations[0]!.timestamp = time(120);
  const result = assessReliability(input(history));
  assert.equal(result.status, 'UNVERIFIED'); reason(result, 'REPEATED_TIMESTAMP');
  assert.equal(result.evidence.distinctCurrentTripObservations, 0);
});

test('regressing source timestamp cannot verify even if the other endpoint advances', () => {
  const history = frames(); history[4]!.sm!.observations[0]!.timestamp = time(80);
  const result = assessReliability(input(history));
  assert.notEqual(result.status, 'VERIFIED'); reason(result, 'REGRESSING_TIMESTAMP');
});

test('moving away from the same target is negative evidence rather than supporting progress', () => {
  const history = edit(frames(), (o, i) => { o.monitoredCall!.realtimePrediction.distanceFromStopMeters = 100 + i * 50; });
  const result = assessReliability(input(history));
  assert.notEqual(result.status, 'VERIFIED'); reason(result, 'MOVING_AWAY');
  assert.ok(result.evidence.negativeStreaks.PROGRESSION >= 3);
});

test('missing coordinates cannot be replaced by distance changes or arrival predictions', () => {
  const history = edit(frames(), o => { delete o.latitude; o.monitoredCall!.realtimePrediction.expectedArrival = time(250); });
  const result = assessReliability(input(history));
  assert.equal(result.status, 'UNVERIFIED'); reason(result, 'COORDINATES_UNAVAILABLE');
});

test('missing target distance cannot be replaced by coordinate movement', () => {
  const history = edit(frames(), o => { delete o.monitoredCall!.realtimePrediction.distanceFromStopMeters; });
  const result = assessReliability(input(history));
  assert.equal(result.status, 'UNVERIFIED'); reason(result, 'DISTANCE_UNAVAILABLE');
});

test('request failure blocks verification without exposing raw errors', () => {
  const history = frames(); history[4]!.errors = ['SECRET upstream request error'];
  const result = assessReliability(input(history));
  assert.equal(result.status, 'UNVERIFIED'); reason(result, 'REQUEST_FAILURE');
  assert.ok(!JSON.stringify(result).includes('SECRET'));
});

test('adapter/parser issues block verification', () => {
  const history = frames(); history[4]!.vm!.issues = ['malformed field'];
  const result = assessReliability(input(history));
  assert.equal(result.status, 'UNVERIFIED'); reason(result, 'ADAPTER_ISSUE');
});

test('no realtime candidate defaults to UNVERIFIED', () => {
  const history = frames(); for (const f of history) { f.vm!.observations = []; f.sm!.observations = []; }
  const result = assessReliability(input(history));
  assert.equal(result.status, 'UNVERIFIED'); reason(result, 'NO_REALTIME_CANDIDATE');
});

test('unexplained VM/SM mismatch cannot verify', () => {
  const history = frames(); for (const f of history) f.sm!.observations[0]!.tripId = 'OTHER_TRIP';
  const result = assessReliability(input(history));
  assert.equal(result.status, 'UNVERIFIED'); reason(result, 'UNEXPLAINED_JOURNEY_MISMATCH');
});

test('disappearance then reappearance resets history and does not imply cancellation', () => {
  const history = frames(7); history[4]!.vm!.observations = []; history[4]!.sm!.observations = [];
  const result = assessReliability(input(history));
  assert.equal(result.status, 'UNVERIFIED'); reason(result, 'CANDIDATE_DISAPPEARED'); reason(result, 'CANDIDATE_REAPPEARED');
  assert.equal(result.evidence.stableAssignmentObservations, 2);
});

test('schedule-only and prediction-only observations never verify', () => {
  for (const which of ['schedule', 'prediction']) {
    const history = edit(frames(), o => {
      delete o.timestamp; delete o.latitude; delete o.longitude;
      delete o.monitoredCall!.realtimePrediction.distanceFromStopMeters;
      if (which === 'schedule') o.staticAssignment.originScheduledDeparture = time(400);
      else o.monitoredCall!.realtimePrediction.expectedArrival = time(400);
    });
    const result = assessReliability(input(history));
    assert.notEqual(result.status, 'VERIFIED'); reason(result, 'MISSING_TIMESTAMP');
  }
});

test('HIGH_GHOST_RISK requires repeated negative evidence from multiple families by default', () => {
  const history = edit(frames(), (o, i) => { o.timestamp = time(i * 30 - 200); o.monitoredCall!.realtimePrediction.distanceFromStopMeters = 100 + i * 50; });
  const result = assessReliability(input(history));
  assert.equal(result.status, 'HIGH_GHOST_RISK'); reason(result, 'STALE_OBSERVATIONS'); reason(result, 'MOVING_AWAY');
  assert.ok(result.summary.includes('not an MTA status'));
});

test('severe staleness is decisive only with explicit opt-in policy', () => {
  const request = input(frames(1)); request.evaluatedAt = time(400);
  assert.equal(assessReliability(request).status, 'UNVERIFIED');
  assert.equal(assessReliability(request, { ...PROVISIONAL_POLICY, decisiveSevereStaleness: true }).status, 'HIGH_GHOST_RISK');
});

test('repeated failures with absent candidates can become HIGH_GHOST_RISK', () => {
  const history = frames().map(f => ({ completedAt: f.completedAt, errors: ['failed'] }));
  assert.equal(assessReliability(input(history)).status, 'HIGH_GHOST_RISK');
});

test('target mismatch and unrelated VM/SM distances cannot verify', () => {
  const history = frames();
  for (const f of history) f.vm!.observations[0]!.monitoredCall!.staticReference.stopId = 'MTA_OTHER_STOP';
  const result = assessReliability(input(history));
  assert.equal(result.status, 'UNVERIFIED'); reason(result, 'TARGET_STOP_UNCONFIRMED');
  const another = frames();
  for (const f of another) f.sm!.observations[0]!.monitoredCall!.staticReference.stopId = 'MTA_OTHER_STOP';
  reason(assessReliability(input(another)), 'DISTANCE_UNAVAILABLE');
});

test('long gaps, future clocks, cross-source skew, duplicates and wrong direction fail closed', () => {
  const cases = [
    (h: ReliabilityFrame[]) => { h[4]!.completedAt = time(230); },
    (h: ReliabilityFrame[]) => { h[4]!.vm!.observations[0]!.timestamp = time(500); },
    (h: ReliabilityFrame[]) => { h[4]!.vm!.observations[0]!.latitude = 41; },
    (h: ReliabilityFrame[]) => { h[4]!.vm!.observations.push(structuredClone(h[4]!.vm!.observations[0]!)); },
    (h: ReliabilityFrame[]) => { h[4]!.sm!.observations[0]!.staticAssignment.directionId = '1'; },
  ];
  for (const mutate of cases) { const history = frames(); mutate(history); assert.notEqual(assessReliability(input(history)).status, 'VERIFIED'); }
});

test('different service date, block or vehicle cannot be silently merged into stable evidence', () => {
  for (const kind of ['serviceDate', 'blockId', 'vehicleId'] as const) {
    const history = frames(); edit([history[4]!], o => { o[kind] = 'CHANGED'; });
    assert.notEqual(assessReliability(input(history)).status, 'VERIFIED');
  }
});

test('prevTrip does not explain a conflicting route or service date', () => {
  const history = frames();
  for (const f of history) { f.sm!.observations[0]!.progressStatus = 'prevTrip'; f.vm!.observations[0]!.serviceDate = '2026-10-19'; }
  reason(assessReliability(input(history)), 'UNEXPLAINED_JOURNEY_MISMATCH');
});

test('policy/clock provenance cannot change between extraction and classification', () => {
  const evidence = deriveReliabilityEvidence(input(), PROVISIONAL_POLICY);
  assert.throws(() => classifyReliabilityEvidence(evidence, { ...PROVISIONAL_POLICY, maxObservationAgeSeconds: 1 }, input().evaluatedAt));
  assert.throws(() => classifyReliabilityEvidence(evidence, PROVISIONAL_POLICY, time(500)));
  assert.throws(() => assessReliability({ ...input(), evaluatedAt: 'invalid' }));
  assert.throws(() => validatePolicy({ ...PROVISIONAL_POLICY, minimumProgressDistanceMeters: NaN }));
});

test('engine is deterministic, does not mutate inputs and copies no raw upstream fields', () => {
  const request = input(); const snapshot = structuredClone(request);
  const one = assessReliability(request);
  assert.deepEqual(assessReliability(request), one);
  assert.deepEqual(request, snapshot);
  assert.equal(one.vehicleId, vehicleId);
  assert.ok(!JSON.stringify(one).includes('apiKey'));
});

test('9851 real Phase 1 regression never verifies the first temporary assignment or any prevTrip/layover prefix', () => {
  const captures = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/bx10-terminal-history.sanitized.json.gz', import.meta.url))).toString('utf8')) as ReliabilityFrame[];
  const assessments = captures.map((f, index) => assessReliability({ ...input(captures.slice(0, index + 1)), vehicleId: 'MTA NYCT_9851', evaluatedAt: f.completedAt }));
  assert.ok(assessments.every(a => a.status !== 'VERIFIED'));
  const firstSwitch = assessments[2]!;
  assert.equal(firstSwitch.journey?.current?.directionId, '0');
  assert.equal(firstSwitch.status, 'UNVERIFIED');
  reason(firstSwitch, 'TARGET_STOP_UNCONFIRMED');
  assert.equal(assessments[5]!.evidence.latest?.vmProgressStatus, 'layover');
  assert.equal(assessments[17]!.journey?.current?.directionId, '0');
});

test('historical progress cannot hide a latest uncorroborated distance change or small movement away', () => {
  for (const kind of ['stationary', 'away']) {
    const history = frames(6);
    edit([history[5]!], o => {
      if (kind === 'stationary') o.latitude = history[4]!.sm!.observations[0]!.latitude;
      else o.monitoredCall!.realtimePrediction.distanceFromStopMeters = 341;
    });
    assert.notEqual(assessReliability(input(history)).status, 'VERIFIED');
  }
});

test('missing service date or destination assignment, invalid frame order, expired validity cannot verify', () => {
  const edits = [
    (h: ReliabilityFrame[]) => edit(h, o => { delete o.serviceDate; }),
    (h: ReliabilityFrame[]) => edit(h, o => { delete o.staticAssignment.destinationId; }),
    (h: ReliabilityFrame[]) => { h[4]!.completedAt = time(60); },
    (h: ReliabilityFrame[]) => { h[4]!.sm!.deliveries[0]!.validUntil = time(110); },
    (h: ReliabilityFrame[]) => { h[4]!.sm!.observations[0]!.staticAssignment.destinationName = 'CONFLICTING DESTINATION'; },
  ];
  for (const mutate of edits) { const history = frames(); mutate(history); assert.notEqual(assessReliability(input(history)).status, 'VERIFIED'); }
});

test('a bad preceding frame cannot supply a progressing comparison to a recovered stable suffix', () => {
  const history = frames(6);
  history[0]!.errors = ['failed acquisition'];
  for (const f of history.slice(2, 5)) for (const batch of [f.vm, f.sm]) batch!.observations[0]!.latitude = history[1]!.sm!.observations[0]!.latitude;
  const result = assessReliability(input(history));
  assert.equal(result.evidence.stableAssignmentObservations, 5);
  assert.equal(result.evidence.progressingObservations, 1);
  assert.equal(result.status, 'UNVERIFIED');
});

test('structurally compatible caller config cannot leak extra secret or raw response properties', () => {
  const request = input();
  const targetWithExtra = { ...request.target, apiKey: 'SECRET_FROM_CONFIG' };
  const policyWithExtra = { ...PROVISIONAL_POLICY, apiKey: 'SECRET_FROM_CONFIG' };
  const result = assessReliability({ ...request, target: targetWithExtra }, policyWithExtra);
  assert.ok(!JSON.stringify(result).includes('SECRET_FROM_CONFIG'));
  assert.equal(result.status, 'VERIFIED');
});

test('missing assignment is not invented as a contradictory route or journey', () => {
  const history = edit(frames(), o => { delete o.routeId; delete o.tripId; });
  const result = assessReliability(input(history));
  assert.equal(result.status, 'UNVERIFIED'); reason(result, 'MISSING_ASSIGNMENT');
  assert.ok(!result.reasonCodes.includes('UNEXPLAINED_JOURNEY_MISMATCH'));
  assert.ok(!result.reasonCodes.includes('WRONG_ROUTE_OR_DIRECTION'));
});
