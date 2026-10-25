import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import test from 'node:test';
import { CommuteDecisionService, createMtaCommuteSource, InMemoryObservationHistory, recommendationFor } from '../src/lib/commute/index.js';
import type { CommuteObservationSource, ObservationHistoryStore } from '../src/lib/commute/index.js';
import type { ReliabilityFrame } from '../src/lib/reliability/index.js';
import { frames, time } from './fixtures/reliability/current-trip.js';
import { commuteConfiguration as DEFAULT_COMMUTE } from './fixtures/reliability/current-trip.js';

function harness(history: ObservationHistoryStore = new InMemoryObservationHistory()) {
  let current = time(2);
  const service = legacyService({ history, clock: () => current });
  return { history, service, clock: (value: string) => { current = value; }, async ingest(frame: ReliabilityFrame) { current = frame.completedAt; assert.equal(await service.ingest(frame), true); } };
}
async function ingestAll(h: ReturnType<typeof harness>, history = frames()) { for (const f of history) await h.ingest(f); }

test('explicit status mapping sends only VERIFIED to NORMAL_ROUTE', () => {
  assert.equal(recommendationFor('VERIFIED').action, 'NORMAL_ROUTE');
  assert.deepEqual(recommendationFor('UNVERIFIED'), { action: 'BACKUP_ROUTE', label: 'Walk to the D train.' });
  assert.equal(recommendationFor('HIGH_GHOST_RISK').action, 'BACKUP_ROUTE');
});

test('stable synthetic current-trip history produces one typed NORMAL_ROUTE decision', async () => {
  const h = harness(); await ingestAll(h);
  const d = await h.service.assess();
  assert.equal(d.primaryLeg.status, 'VERIFIED'); assert.equal(d.recommendation.action, 'NORMAL_ROUTE');
  assert.equal(d.primaryLeg.stop.id, 'MTA_103620'); assert.equal(d.primaryLeg.directionId, '0');
  assert.equal(d.dataHealth.status, 'HEALTHY'); assert.equal(d.primaryLeg.evidence.distinctCurrentTripObservations, 5);
});

test('one successful observation is insufficient; repeated ingestion accumulates without sleeps', async () => {
  const h = harness(); const history = frames(); await h.ingest(history[0]!);
  let d = await h.service.assess();
  assert.equal(d.primaryLeg.status, 'UNVERIFIED'); assert.equal(d.recommendation.action, 'BACKUP_ROUTE');
  assert.equal(d.primaryLeg.evidence.framesRetained, 1);
  for (const f of history.slice(1)) await h.ingest(f);
  d = await h.service.assess(); assert.equal(d.primaryLeg.evidence.framesRetained, 5); assert.equal(d.primaryLeg.status, 'VERIFIED');
});

test('transit HIGH_GHOST_RISK remains distinct from acquisition failure', async () => {
  const h = harness(); const history = frames();
  history.forEach((f, i) => { for (const b of [f.vm, f.sm]) { const o = b!.observations[0]!; o.timestamp = time(i * 30 - 200); o.monitoredCall!.realtimePrediction.distanceFromStopMeters = 100 + i * 50; } });
  await ingestAll(h, history); const d = await h.service.assess();
  assert.equal(d.dataHealth.status, 'HEALTHY'); assert.equal(d.primaryLeg.status, 'HIGH_GHOST_RISK'); assert.equal(d.recommendation.action, 'BACKUP_ROUTE');
});

for (const failed of ['vm', 'sm', 'both'] as const) {
  test(`live ingest handles ${failed} endpoint failure without calling real MTA`, async () => {
    const frame = frames()[0]!;
    const fail = async () => { throw new Error('https://example.invalid?key=SECRET_TEST_KEY'); };
    const source: CommuteObservationSource = { vehicleMonitoring: failed === 'vm' || failed === 'both' ? fail : async () => frame.vm!, stopMonitoring: failed === 'sm' || failed === 'both' ? fail : async () => frame.sm! };
    const service = legacyService({ history: new InMemoryObservationHistory(), source, clock: () => time(2) });
    const result = await service.ingestLive(); const d = await service.assess();
    assert.equal(result.vehicleMonitoring, failed === 'sm' ? 'SUCCEEDED' : 'FAILED');
    assert.equal(result.stopMonitoring, failed === 'vm' ? 'SUCCEEDED' : 'FAILED');
    assert.equal(d.primaryLeg.status, 'UNVERIFIED'); assert.equal(d.recommendation.action, 'BACKUP_ROUTE');
    assert.match(d.primaryLeg.summary, /Realtime data unavailable/); assert.ok(!d.primaryLeg.summary.includes('ghost'));
    assert.equal(d.dataHealth.status, failed === 'both' ? 'UNAVAILABLE' : 'DEGRADED');
    assert.ok(!JSON.stringify(d).includes('SECRET_TEST_KEY'));
  });
}

test('repeated request failures stay data-unavailable UNVERIFIED rather than presenting ghost detection', async () => {
  const h = harness();
  for (let i = 0; i < 5; i++) await h.ingest({ completedAt: time(i * 30 + 2), errors: ['SECRET_ERROR'] });
  const d = await h.service.assess(); assert.equal(d.primaryLeg.status, 'UNVERIFIED');
  assert.equal(d.dataHealth.status, 'UNAVAILABLE'); assert.match(d.primaryLeg.summary, /Realtime data unavailable/);
  assert.ok(!JSON.stringify(d).includes('SECRET_ERROR'));
});

test('successful empty responses mean no candidate, not request failure', async () => {
  const h = harness(); const f = frames()[0]!; f.vm!.observations = []; f.sm!.observations = [];
  await h.ingest(f); const d = await h.service.assess();
  assert.equal(d.dataHealth.status, 'HEALTHY'); assert.equal(d.dataHealth.vehicleMonitoring, 'EMPTY');
  assert.equal(d.primaryLeg.status, 'UNVERIFIED'); assert.equal(d.recommendation.action, 'BACKUP_ROUTE');
  assert.ok(d.primaryLeg.reasonCodes.includes('NO_STOP_CANDIDATE')); assert.ok(!d.primaryLeg.reasonCodes.includes('REQUEST_FAILURE'));
});

test('duplicate source timestamps stay visible but cannot grow useful evidence', async () => {
  const h = harness(); const history = frames(6);
  for (const b of [history[5]!.vm, history[5]!.sm]) b!.observations[0]!.timestamp = time(120);
  await ingestAll(h, history); const d = await h.service.assess();
  assert.equal(d.primaryLeg.evidence.framesRetained, 6); assert.equal(d.primaryLeg.evidence.distinctCurrentTripObservations, 0);
  assert.equal(d.primaryLeg.status, 'UNVERIFIED'); assert.ok(d.primaryLeg.reasonCodes.includes('REPEATED_TIMESTAMP'));
});

test('history prunes old frames and has a hard count bound', async () => {
  const history = new InMemoryObservationHistory({ historyWindowSeconds: 600, maximumFrames: 3, maximumObservationsPerEndpoint: 64 });
  const h = harness(history); await ingestAll(h, frames(8));
  let saved = await history.getRecent(time(212)); assert.equal(saved.length, 3);
  assert.ok(saved.every((f, i) => i === 0 || f.completedAt > saved[i - 1]!.completedAt));
  h.clock(time(1000)); saved = await history.getRecent(time(1000)); assert.equal(saved.length, 0);
  assert.equal((await h.service.assess()).recommendation.action, 'BACKUP_ROUTE');
});

test('history snapshots are defensive, and out-of-order completion is explicitly rejected', async () => {
  const history = new InMemoryObservationHistory(); const f = frames()[0]!; await history.add(f);
  f.vm!.observations = [];
  const saved = await history.getRecent(time(2)); assert.equal(saved[0]!.vm!.observations.length, 1);
  saved[0]!.vm!.observations = []; assert.equal((await history.getRecent(time(2)))[0]!.vm!.observations.length, 1);
  await assert.rejects(history.add(f), { message: 'NON_INCREASING_HISTORY_TIME' });
});

test('history overflow surfaces an issue instead of silently verifying truncated candidates', async () => {
  const history = new InMemoryObservationHistory({ historyWindowSeconds: 600, maximumFrames: 40, maximumObservationsPerEndpoint: 1 });
  const h = harness(history); const f = frames()[0]!; f.sm!.observations.push(structuredClone(f.sm!.observations[0]!));
  await h.ingest(f); const d = await h.service.assess();
  assert.equal(d.dataHealth.stopMonitoring, 'ISSUES'); assert.equal(d.primaryLeg.status, 'UNVERIFIED');
});

test('vehicle reassignment resets comparisons across otherwise complete history', async () => {
  const h = harness(); const history = frames();
  for (const b of [history[4]!.vm, history[4]!.sm]) b!.observations[0]!.tripId = 'NEW_TRIP';
  await ingestAll(h, history); const d = await h.service.assess();
  assert.equal(d.primaryLeg.status, 'UNVERIFIED'); assert.equal(d.primaryLeg.evidence.stableAssignmentObservations, 1);
  assert.ok(d.primaryLeg.reasonCodes.includes('ASSIGNMENT_TRANSITION'));
});

test('prevTrip preserves VM direction one and future SM direction zero without a false feed error', async () => {
  const h = harness(); const history = frames();
  for (const f of history) { f.vm!.observations[0]!.staticAssignment.directionId = '1'; f.vm!.observations[0]!.tripId = 'PREVIOUS_TRIP'; f.sm!.observations[0]!.progressStatus = 'prevTrip'; }
  await ingestAll(h, history); const d = await h.service.assess();
  assert.equal(d.dataHealth.status, 'HEALTHY'); assert.equal(d.primaryLeg.status, 'UNVERIFIED');
  assert.equal(d.primaryLeg.journey?.current?.directionId, '1'); assert.equal(d.primaryLeg.journey?.stopMonitoring?.directionId, '0');
  assert.ok(d.primaryLeg.reasonCodes.includes('PREVIOUS_TRIP')); assert.ok(!d.primaryLeg.reasonCodes.includes('UNEXPLAINED_JOURNEY_MISMATCH'));
});

test('adapter issues surface as data health, not a ghost bus label', async () => {
  const h = harness(); const history = frames(); history[4]!.sm!.observations[0]!.issues.push('SECRET_UPSTREAM_DESCRIPTION');
  await ingestAll(h, history); const d = await h.service.assess();
  assert.equal(d.dataHealth.stopMonitoring, 'ISSUES'); assert.equal(d.primaryLeg.status, 'UNVERIFIED');
  assert.ok(d.primaryLeg.reasonCodes.includes('ADAPTER_ISSUE')); assert.ok(!JSON.stringify(d).includes('SECRET_UPSTREAM_DESCRIPTION'));
});

test('an earlier prevTrip candidate is not skipped in favor of a reassuring later candidate', async () => {
  const h = harness(); const history = frames();
  for (const f of history) {
    const v = structuredClone(f.vm!.observations[0]!); const s = structuredClone(f.sm!.observations[0]!);
    v.vehicleId = s.vehicleId = 'EARLY_CANDIDATE'; v.tripId = 'PREVIOUS'; v.staticAssignment.directionId = '1'; s.progressStatus = 'prevTrip';
    s.monitoredCall!.realtimePrediction.expectedArrival = time(300);
    f.sm!.observations[0]!.monitoredCall!.realtimePrediction.expectedArrival = time(400);
    f.vm!.observations.push(v); f.sm!.observations.push(s);
  }
  await ingestAll(h, history); const d = await h.service.assess();
  assert.equal(d.primaryLeg.vehicleId, 'EARLY_CANDIDATE'); assert.equal(d.primaryLeg.status, 'UNVERIFIED'); assert.equal(d.recommendation.action, 'BACKUP_ROUTE');
});

test('old successful history cannot hide a new endpoint failure or expired acquisition', async () => {
  const h = harness(); await ingestAll(h);
  assert.equal((await h.service.assess()).recommendation.action, 'NORMAL_ROUTE');
  await h.ingest({ completedAt: time(152), vm: frames(6)[5]!.vm, errors: ['SM_FAILED'] });
  assert.equal((await h.service.assess()).primaryLeg.status, 'UNVERIFIED');
  const another = harness(); await ingestAll(another); another.clock(time(300));
  assert.equal((await another.service.assess()).dataHealth.vehicleMonitoring, 'STALE');
  assert.equal((await another.service.assess()).recommendation.action, 'BACKUP_ROUTE');
});

test('history read/write errors do not reuse a reassuring assessment or expose errors', async () => {
  const broken: ObservationHistoryStore = { async add() { throw new Error('SECRET_HISTORY'); }, async getRecent() { throw new Error('SECRET_HISTORY'); } };
  const h = harness(broken); assert.equal(await h.service.ingest(frames()[0]!), false);
  const d = await h.service.assess(); assert.equal(d.primaryLeg.status, 'UNVERIFIED'); assert.equal(d.dataHealth.history, 'FAILED');
  assert.ok(!JSON.stringify(d).includes('SECRET_HISTORY'));
});

test('paired ingestion is concurrent and repeated concurrent calls coalesce', async () => {
  let vmCalls = 0; let smCalls = 0; const f = frames()[0]!;
  const source = { async vehicleMonitoring() { vmCalls++; return f.vm!; }, async stopMonitoring() { smCalls++; return f.sm!; } };
  const service = legacyService({ history: new InMemoryObservationHistory(), source, clock: () => time(2) });
  await Promise.all([service.ingestLive(), service.ingestLive()]);
  assert.equal(vmCalls, 1); assert.equal(smCalls, 1); assert.equal((await service.assess()).primaryLeg.evidence.framesRetained, 1);
});

test('real 9851 terminal sequence remains BACKUP_ROUTE through the application layer', async () => {
  const captures = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/bx10-terminal-history.sanitized.json.gz', import.meta.url))).toString('utf8')) as ReliabilityFrame[];
  const h = harness();
  for (const f of captures) { await h.ingest(f); const d = await h.service.assess(); assert.equal(d.recommendation.action, 'BACKUP_ROUTE'); }
});

for (const failure of ['timeout', 'http', 'json', 'envelope'] as const) {
  test(`real adapter integration contains ${failure} failures without credential-bearing errors`, async t => {
    const key = 'SECRET_TEST_CREDENTIAL'; const logged: unknown[] = [];
    t.mock.method(console, 'log', (...args: unknown[]) => { logged.push(args); });
    t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args); });
    const fake: typeof fetch = async () => {
      if (failure === 'timeout') throw new Error(`timeout https://example.invalid/?key=${key}`);
      if (failure === 'http') return new Response(key, { status: 403 });
      if (failure === 'json') return new Response(key);
      return Response.json({ rawSecret: key });
    };
    const source = createMtaCommuteSource({ routeId: 'MTA NYCT_BX10', apiKey: key, stopId: '103620', directionId: '0' }, fake);
    await assert.rejects(source.vehicleMonitoring(), { message: 'MTA_VM_FAILED' });
    const service = legacyService({ history: new InMemoryObservationHistory(), source, clock: () => time(2) });
    await service.ingestLive(); const d = await service.assess();
    assert.equal(d.primaryLeg.status, 'UNVERIFIED'); assert.ok(!JSON.stringify(d).includes(key)); assert.deepEqual(logged, []);
  });
}

test('real adapter source normalizes both official fixture shapes and redacts reflected credentials', async () => {
  const key = 'SECRET_TEST_CREDENTIAL';
  const load = (mode: string) => JSON.parse(gunzipSync(readFileSync(new URL(`./fixtures/siri-${mode}-commute.sanitized.json.gz`, import.meta.url))).toString('utf8')) as unknown;
  const fake: typeof fetch = async input => {
    const url = new URL(String(input)); assert.equal(url.searchParams.get('key'), key);
    if (url.pathname.includes('stop-monitoring')) { assert.equal(url.searchParams.get('MonitoringRef'), '103620'); assert.equal(url.searchParams.get('DirectionRef'), '0'); return Response.json(load('sm')); }
    assert.equal(url.searchParams.get('LineRef'), 'MTA NYCT_BX10'); assert.equal(url.searchParams.has('DirectionRef'), false);
    const raw = load('vm') as { Siri: { ServiceDelivery: { VehicleMonitoringDelivery: { VehicleActivity: { MonitoredVehicleJourney: { DestinationName: string[] } }[] }[] } } };
    raw.Siri.ServiceDelivery.VehicleMonitoringDelivery[0]!.VehicleActivity[0]!.MonitoredVehicleJourney.DestinationName = [key];
    return Response.json(raw);
  };
  const source = createMtaCommuteSource({ routeId: 'MTA NYCT_BX10', apiKey: key, stopId: '103620', directionId: '0' }, fake);
  const service = legacyService({ history: new InMemoryObservationHistory(), source, clock: () => '2026-10-20T17:15:40.291Z' });
  const result = await service.ingestLive(); const d = await service.assess();
  assert.equal(result.vehicleObservationCount, 13); assert.equal(result.stopObservationCount, 4);
  assert.ok(!JSON.stringify(d).includes(key)); assert.equal(d.recommendation.action, 'BACKUP_ROUTE');
});

test('configuration and public clock errors omit secret-bearing causes', async () => {
  assert.throws(() => createMtaCommuteSource({ routeId: 'MTA NYCT_BX10', apiKey: '', stopId: 'SECRET', directionId: '0' }), { message: 'INVALID_MTA_SOURCE_CONFIGURATION' });
  const service = legacyService({ history: new InMemoryObservationHistory(), clock: () => { throw new Error('SECRET_CLOCK'); } });
  await assert.rejects(service.assess(), { message: 'COMMUTE_CLOCK_UNAVAILABLE' });
  assert.equal((await service.ingestLive()).stored, false);
  const config = { ...DEFAULT_COMMUTE, backupLabel: '' };
  assert.throws(() => legacyService({ history: new InMemoryObservationHistory(), config, clock: () => time(2) }), { message: 'INVALID_COMMUTE_CONFIGURATION' });
});

test('vehicle identity and service-date changes cannot carry an old stable suffix', async () => {
  for (const kind of ['vehicleId', 'serviceDate'] as const) {
    const h = harness(); const history = frames();
    for (const b of [history[4]!.vm, history[4]!.sm]) b!.observations[0]![kind] = kind === 'vehicleId' ? 'NEW_VEHICLE' : '2026-10-21';
    await ingestAll(h, history); const d = await h.service.assess();
    assert.equal(d.primaryLeg.status, 'UNVERIFIED'); assert.equal(d.primaryLeg.evidence.stableAssignmentObservations, 1);
  }
});

test('wrong endpoint context or expired validity is data-health failure rather than normal service', async () => {
  for (const kind of ['context', 'expired']) {
    const h = harness(); const history = frames();
    if (kind === 'context') history[4]!.vm!.context = 'stop';
    else history[4]!.sm!.deliveries[0]!.validUntil = time(110);
    await ingestAll(h, history); const d = await h.service.assess();
    assert.equal(d.primaryLeg.status, 'UNVERIFIED'); assert.notEqual(d.dataHealth.status, 'HEALTHY');
    assert.match(d.primaryLeg.summary, /Realtime data unavailable/);
  }
});

test('a recovered history write cannot erase the failed frame and resume old VERIFIED evidence', async () => {
  const backing = new InMemoryObservationHistory(); let failWrite = false;
  const history: ObservationHistoryStore = { async add(f) { if (failWrite) throw new Error('write failed'); await backing.add(f); }, getRecent: at => backing.getRecent(at) };
  const h = harness(history); const sequence = frames(8); await ingestAll(h, sequence.slice(0, 5));
  assert.equal((await h.service.assess()).primaryLeg.status, 'VERIFIED');
  failWrite = true; h.clock(sequence[5]!.completedAt); assert.equal(await h.service.ingest(sequence[5]!), false);
  assert.equal((await h.service.assess()).primaryLeg.status, 'UNVERIFIED');
  failWrite = false; await h.ingest(sequence[6]!); const recovered = await h.service.assess();
  assert.equal(recovered.dataHealth.history, 'GAP'); assert.equal(recovered.primaryLeg.status, 'UNVERIFIED');
  await h.ingest(sequence[7]!); assert.equal((await h.service.assess()).primaryLeg.evidence.stableAssignmentObservations, 1);
});

function legacyService(options: ConstructorParameters<typeof CommuteDecisionService>[0]) {
  return new CommuteDecisionService({ config: DEFAULT_COMMUTE, ...options });
}
