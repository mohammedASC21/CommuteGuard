import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessReliability, PROVISIONAL_POLICY } from '../src/lib/reliability/index.js';
import type { ReliabilityFrame } from '../src/lib/reliability/index.js';
import { CommuteDecisionService, InMemoryObservationHistory } from '../src/lib/commute/index.js';
import { frames, input, time, commuteConfiguration } from './fixtures/reliability/current-trip.js';

function duplicate(last: ReliabilityFrame, at: number): ReliabilityFrame {
  const frame = structuredClone(last);
  frame.completedAt = time(at);
  for (const batch of [frame.vm!, frame.sm!]) {
    batch.responseTimestamp = time(at - 1);
    batch.deliveries = [{ responseTimestamp: time(at - 1), validUntil: time(at + 60) }];
  }
  return frame;
}
function counts(result: ReturnType<typeof assessReliability>) {
  const e = result.evidence;
  return [e.distinctCurrentTripObservations, e.stableAssignmentObservations, e.progressingObservations, e.progressDistanceMeters];
}
for (const times of [[127], [127, 140, 150]]) {
  test(`fresh exact duplicates are neutral with unchanged qualifying counts: ${times.length}`, () => {
    const history = frames(); const before = assessReliability(input(history));
    for (const at of times) history.push(duplicate(history.at(-1)!, at));
    const after = assessReliability(input(history));
    assert.equal(before.status, 'VERIFIED'); assert.equal(after.status, 'VERIFIED');
    assert.deepEqual(counts(after), counts(before));
    assert.ok(after.reasonCodes.includes('REPEATED_TIMESTAMP'));
    assert.equal(after.evidence.latest!.advancingDistinctObservation, false);
    assert.equal(after.evidence.latest!.neutralSourceDuplicate, true);
    assert.ok(!after.evidence.latest!.reasons.includes('NO_PROGRESS'));
    assert.deepEqual(after.evidence.negativeStreaks, before.evidence.negativeStreaks);
  });
}
test('duplicate acquisitions cannot refresh source freshness', () => {
  const history = frames();
  for (const at of [140, 170, 200, 120 + PROVISIONAL_POLICY.maxObservationAgeSeconds + 1]) history.push(duplicate(history.at(-1)!, at));
  const result = assessReliability(input(history));
  assert.equal(result.status, 'UNVERIFIED'); assert.ok(result.reasonCodes.includes('STALE_OBSERVATIONS'));
});
test('genuinely advancing timestamp with unchanged position remains NO_PROGRESS', () => {
  const history = frames(); const next = duplicate(history.at(-1)!, 152);
  for (const b of [next.vm!, next.sm!]) b.observations[0]!.timestamp = time(150);
  history.push(next); const result = assessReliability(input(history));
  assert.notEqual(result.status, 'VERIFIED'); assert.ok(result.evidence.latest!.reasons.includes('NO_PROGRESS'));
});
for (const conflict of ['trip', 'direction', 'serviceDate', 'stop', 'position', 'distance', 'layover', 'prevTrip', 'failure', 'issues'] as const) {
  test(`same-timestamp ${conflict} conflict is not neutral`, () => {
    const history = frames(); const next = duplicate(history.at(-1)!, 129);
    for (const b of [next.vm!, next.sm!]) {
      const o = b.observations[0]!;
      if (conflict === 'trip') o.tripId = 'DIFFERENT_TRIP';
      if (conflict === 'direction') o.staticAssignment.directionId = '1';
      if (conflict === 'serviceDate') o.serviceDate = '2026-10-19';
      if (conflict === 'stop') o.monitoredCall!.staticReference.stopId = 'OTHER_STOP';
      if (conflict === 'position') o.latitude! += 0.001;
      if (conflict === 'distance') o.monitoredCall!.realtimePrediction.distanceFromStopMeters! += 100;
      if (conflict === 'layover' || conflict === 'prevTrip') o.progressStatus = conflict;
      if (conflict === 'issues') o.issues.push('CONFLICT');
    }
    if (conflict === 'failure') next.errors = ['HISTORY_GAP'];
    history.push(next); const result = assessReliability(input(history));
    assert.notEqual(result.status, 'VERIFIED'); assert.equal(result.evidence.latest!.neutralSourceDuplicate, false);
  });
}
test('five acquisitions of one source observation count once', () => {
  const history = frames(1);
  for (const at of [7, 12, 17, 22]) history.push(duplicate(history.at(-1)!, at));
  const result = assessReliability(input(history));
  assert.deepEqual(counts(result), [1, 1, 0, 0]); assert.equal(result.status, 'UNVERIFIED');
});
test('new unique progression after duplicates compares against the last unique source update', () => {
  const history = frames(); history.push(duplicate(history.at(-1)!, 127));
  history.push(frames(6)[5]!);
  const result = assessReliability(input(history));
  assert.equal(result.status, 'VERIFIED'); assert.deepEqual(counts(result), [6, 6, 5, 200]);
});
test('fresh duplicates cannot hide a unique no-progress observation', () => {
  const history = frames(); const next = duplicate(history.at(-1)!, 152);
  for (const b of [next.vm!, next.sm!]) b.observations[0]!.timestamp = time(150);
  history.push(next, duplicate(next, 157));
  assert.notEqual(assessReliability(input(history)).status, 'VERIFIED');
});
test('new web service ingests duplicate and reassesses shared history without a saved verdict', async () => {
  const history = new InMemoryObservationHistory();
  const cli = new CommuteDecisionService({ config: commuteConfiguration, history, clock: () => time(122) });
  for (const frame of frames()) await cli.ingest(frame);
  assert.equal((await cli.assess()).primaryLeg.status, 'VERIFIED');
  const last = duplicate(frames().at(-1)!, 129);
  const web = new CommuteDecisionService({ config: commuteConfiguration, history, clock: () => time(129), source: {
    vehicleMonitoring: async () => last.vm!, stopMonitoring: async () => last.sm!,
  } });
  await web.ingestLive(); const decision = await web.assess();
  assert.equal(decision.primaryLeg.status, 'VERIFIED');
  assert.equal(decision.primaryLeg.evidence.framesRetained, 6);
  assert.equal(decision.primaryLeg.evidence.distinctCurrentTripObservations, 5);
});
