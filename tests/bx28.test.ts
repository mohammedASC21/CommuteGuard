import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { CommuteDecisionService, DEFAULT_COMMUTE, InMemoryObservationHistory } from '../src/lib/commute/index.js';
import { deriveReliabilityEvidence, PROVISIONAL_POLICY } from '../src/lib/reliability/index.js';
import { createMtaCommuteSource } from '../src/lib/commute/live-source.js';
import { frames } from './fixtures/reliability/current-trip.js';

function history() {
  const saved = frames(3);
  for (const f of saved) for (const batch of [f.vm, f.sm]) for (const o of batch!.observations) {
    o.routeId = DEFAULT_COMMUTE.target.routeId;
    o.staticAssignment = { directionId: '1', destinationId: 'MTA_101530', destinationName: DEFAULT_COMMUTE.destination };
    o.monitoredCall!.staticReference.stopId = DEFAULT_COMMUTE.target.stopId;
  }
  return saved;
}
test('confirmed Bx28 is an intermediate direction-1 stop, with ordinary stable evidence requirements', async () => {
  assert.equal(DEFAULT_COMMUTE.route, 'Bx28'); assert.equal(DEFAULT_COMMUTE.target.stopId, 'MTA_103617');
  assert.equal(DEFAULT_COMMUTE.target.directionId, '1'); assert.equal(DEFAULT_COMMUTE.target.isOrigin, false);
  const saved = history();
  const service = new CommuteDecisionService({ history: new InMemoryObservationHistory(), clock: () => saved.at(-1)!.completedAt });
  for (const frame of saved) await service.ingest(frame);
  const d = await service.assess();
  assert.equal(d.primaryLeg.status, 'VERIFIED'); assert.equal(d.recommendation.label, 'Use the normal Bx28 route.');
});
for (const destination of ['MTA_802021', undefined]) test(`short Norwood or missing destination ${destination} cannot reassure for Paul Av`, async () => {
  const saved = history();
  for (const f of saved) for (const b of [f.vm, f.sm]) b!.observations[0]!.staticAssignment.destinationId = destination;
  const service = new CommuteDecisionService({ history: new InMemoryObservationHistory(), clock: () => saved.at(-1)!.completedAt });
  for (const f of saved) await service.ingest(f);
  const d = await service.assess(); assert.equal(d.primaryLeg.status, 'UNVERIFIED'); assert.equal(d.recommendation.action, 'BACKUP_ROUTE');
});
test('old Bx10 history cannot verify the new Bx28 commute', async () => {
  const saved = frames(); const service = new CommuteDecisionService({ history: new InMemoryObservationHistory(), clock: () => saved.at(-1)!.completedAt });
  for (const f of saved) await service.ingest(f);
  const d = await service.assess(); assert.equal(d.primaryLeg.status, 'UNVERIFIED'); assert.equal(d.primaryLeg.route, 'Bx28');
});

test('official discovery confirms the user-selected boarding stop precedes Paul Av on the Fordham branch', () => {
  const data = JSON.parse(readFileSync(new URL('./fixtures/bx28-stops.sanitized.json', import.meta.url), 'utf8')) as { groups: { id: string; name: { name: string }; origin: string; stops: { id: string; sequence: number }[] }[] };
  const direction = data.groups.find(g => g.id === '1')!;
  assert.match(direction.name.name, /FORDHAM CENTER/);
  const boarding = direction.stops.find(s => s.id === DEFAULT_COMMUTE.target.stopId)!;
  const alighting = direction.stops.find(s => s.id === 'MTA_100080')!;
  assert.ok(boarding.sequence < alighting.sequence); assert.notEqual(direction.origin, boarding.id);
});

test('three Bx28 observations verify while the same evidence with origin context requires more', async () => {
  const saved = history();
  for (const isOrigin of [false, true]) {
    const service = new CommuteDecisionService({ history: new InMemoryObservationHistory(), config: { ...DEFAULT_COMMUTE, target: { ...DEFAULT_COMMUTE.target, isOrigin } }, clock: () => saved.at(-1)!.completedAt });
    for (const f of saved) await service.ingest(f);
    const d = await service.assess();
    assert.equal(d.primaryLeg.status, isOrigin ? 'UNVERIFIED' : 'VERIFIED');
    assert.equal(d.primaryLeg.reasonCodes.includes('ORIGIN_REQUIRES_STABLE_CURRENT_TRIP'), isOrigin);
    assert.equal(d.primaryLeg.reasonCodes.includes('PREVIOUS_TRIP'), false);
  }
});

for (const mismatch of ['route', 'direction', 'stop'] as const) test(`candidate selector rejects wrong ${mismatch} for active Bx28`, async () => {
  const saved = history();
  for (const f of saved) for (const b of [f.vm, f.sm]) for (const o of b!.observations) {
    if (mismatch === 'route') o.routeId = 'MTA NYCT_BX10';
    if (mismatch === 'direction') o.staticAssignment.directionId = '0';
    if (mismatch === 'stop') o.monitoredCall!.staticReference.stopId = 'MTA_103620';
  }
  const service = new CommuteDecisionService({ history: new InMemoryObservationHistory(), clock: () => saved.at(-1)!.completedAt });
  for (const f of saved) await service.ingest(f);
  const d = await service.assess();
  assert.equal(d.primaryLeg.vehicleId, undefined); assert.equal(d.primaryLeg.status, 'UNVERIFIED');
  assert.ok(d.primaryLeg.reasonCodes.includes('NO_STOP_CANDIDATE'));
});

test('Bx28 previous-trip behavior requires explicit source evidence, not the old origin configuration', async () => {
  const saved = history();
  for (const f of saved) for (const b of [f.vm, f.sm]) b!.observations[0]!.progressStatus = 'prevTrip';
  const service = new CommuteDecisionService({ history: new InMemoryObservationHistory(), clock: () => saved.at(-1)!.completedAt });
  for (const f of saved) await service.ingest(f);
  const d = await service.assess();
  assert.equal(d.primaryLeg.status, 'UNVERIFIED'); assert.ok(d.primaryLeg.reasonCodes.includes('PREVIOUS_TRIP'));
  assert.ok(!d.primaryLeg.reasonCodes.includes('ORIGIN_REQUIRES_STABLE_CURRENT_TRIP'));
});

test('progress is measured at 103617, independently of a different VM next-stop distance', () => {
  const saved = history();
  for (const [i, f] of saved.entries()) {
    const vm = f.vm!.observations[0]!;
    vm.monitoredCall!.staticReference.stopId = 'MTA_OTHER_NEXT_STOP';
    vm.monitoredCall!.realtimePrediction.distanceFromStopMeters = 10000 + i * 100;
    vm.onwardCalls = [{ staticReference: { stopId: 'MTA_103617' }, realtimePrediction: {} }];
  }
  const e = deriveReliabilityEvidence({ vehicleId: saved[0]!.sm!.observations[0]!.vehicleId!, target: DEFAULT_COMMUTE.target, frames: saved, evaluatedAt: saved.at(-1)!.completedAt }, PROVISIONAL_POLICY);
  assert.equal(e.latest!.targetDistanceMeters, 420); assert.equal(e.latest!.targetDistanceDeltaMeters, -40);
  assert.equal(e.progressDistanceMeters, 80); assert.equal(e.progressingObservations, 2);
});

test('commute source cannot silently fall back to Bx10 when route is omitted', () => {
  const incomplete = { apiKey: 'FAKE_KEY', stopId: '103617', directionId: '1' } as Parameters<typeof createMtaCommuteSource>[0];
  assert.throws(() => createMtaCommuteSource(incomplete), { message: 'INVALID_MTA_SOURCE_CONFIGURATION' });
});

test('an earlier short-turn candidate cannot displace a valid Fordham candidate', async () => {
  const saved = history();
  for (const f of saved) for (const b of [f.vm, f.sm]) {
    const short = structuredClone(b!.observations[0]!);
    short.vehicleId = 'EARLIER_SHORT_TURN'; short.tripId = 'NORWOOD_SHORT_TRIP';
    short.staticAssignment.destinationId = 'MTA_802021';
    short.staticAssignment.destinationName = 'NORWOOD 205 ST STATION via GUNHILL';
    short.monitoredCall!.realtimePrediction.expectedArrival = '2026-10-20T12:00:00Z';
    short.monitoredCall!.realtimePrediction.distanceFromStopMeters = 1;
    b!.observations.unshift(short);
  }
  const service = new CommuteDecisionService({ history: new InMemoryObservationHistory(), clock: () => saved.at(-1)!.completedAt });
  for (const f of saved) await service.ingest(f);
  const d = await service.assess();
  assert.equal(d.primaryLeg.vehicleId, 'FIXTURE_VEHICLE'); assert.equal(d.primaryLeg.status, 'VERIFIED');
});

test('official static branch audit ties all eligible variants to downstream alighting stop 100080', () => {
  const a = JSON.parse(readFileSync(new URL('./fixtures/bx28-static-branches.sanitized.json', import.meta.url), 'utf8')) as { eligibleTripsChecked: number; eligibleTripsMissingDownstreamAlightingStop: number; patterns: { destinationId: string; boardingBeforeAlighting: boolean; originId: string }[] };
  assert.ok(a.eligibleTripsChecked > 0); assert.equal(a.eligibleTripsMissingDownstreamAlightingStop, 0);
  for (const p of a.patterns.filter(p => p.destinationId === DEFAULT_COMMUTE.destinationId)) {
    assert.equal(p.boardingBeforeAlighting, true); assert.notEqual(p.originId, 'MTA_103617');
  }
});
