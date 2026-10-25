import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { PGlite } from '@electric-sql/pglite';
import { migratedDb, sqlRest } from './helpers/persistent-db.js';
import { collectionSchedule, collectionWindow } from '../src/lib/collector/schedule.js';
import { collectScheduled, scheduledAcquisitionId } from '../src/lib/collector/collector.js';
import { createCollectorHandler } from '../src/server/collector-handler.js';
import { SupabaseObservationHistory } from '../src/lib/history/supabase-history.js';
import { commuteScope } from '../src/lib/history/scope.js';
import { CommuteDecisionService, DEFAULT_COMMUTE, type CommuteObservationSource } from '../src/lib/commute/index.js';
import { PROVISIONAL_POLICY, type ReliabilityFrame } from '../src/lib/reliability/index.js';
import { frames, commuteConfiguration } from './fixtures/reliability/current-trip.js';

const schedule = collectionSchedule();
const start = Date.parse('2026-10-19T14:23:00.000Z'); // Monday EDT
const at = (i: number, offset = 2) => new Date(start + i * 30000 + offset * 1000).toISOString();
let db: PGlite;
before(async () => { db = await migratedDb(); await db.exec(await readFile(new URL('../supabase/migrations/202610200002_scheduled_collection.sql', import.meta.url), 'utf8')); });
after(async () => { await db?.close(); });
const scope = () => commuteScope(DEFAULT_COMMUTE, `scheduled_test_${randomUUID()}`);
const store = (id: string, fetcher = sqlRest(db)) => new SupabaseObservationHistory({ scope: id, url: 'https://offline.example', secretKey: 'sb_secret_FAKE_TEST_ONLY' }, fetcher);
function fixture(index: number): ReliabilityFrame {
  const f = frames(1)[0]!;
  f.completedAt = at(index);
  for (const b of [f.vm, f.sm]) {
    b!.responseTimestamp = at(index, 1); b!.deliveries = [{ responseTimestamp: at(index, 1), validUntil: at(index, 61) }];
    for (const o of b!.observations) {
      o.routeId = DEFAULT_COMMUTE.target.routeId; o.serviceDate = '2026-10-19'; o.timestamp = at(index, 0);
      o.latitude = 40.875 + index * 0.0002;
      o.staticAssignment = { directionId: '1', destinationId: DEFAULT_COMMUTE.destinationId };
      o.monitoredCall!.staticReference.stopId = DEFAULT_COMMUTE.target.stopId;
      o.monitoredCall!.realtimePrediction.distanceFromStopMeters = 10000 - index * 60;
    }
  }
  return f;
}
function source(f: ReliabilityFrame): CommuteObservationSource { return { vehicleMonitoring: async () => { if (!f.vm) throw Error('FAKE_VM_FAILURE'); return f.vm; }, stopMonitoring: async () => { if (!f.sm) throw Error('FAKE_SM_FAILURE'); return f.sm; } }; }
const run = (id: string, index: number, f = fixture(index), history = store(id)) => collectScheduled({ scope: id, history, source: source(f), schedule, clock: () => at(index) }, at(index, 0));

for (const [date, allowed] of [
  ['2026-10-19T14:22:59.000Z', false], ['2026-10-19T14:23:00.000Z', true],
  ['2026-10-19T14:23:30.000Z', true], ['2026-10-19T14:29:30.000Z', true],
  ['2026-10-19T14:30:00.000Z', true], ['2026-10-19T14:30:00.001Z', false],
  ['2026-10-21T14:25:00.000Z', true], ['2026-10-20T14:25:00.000Z', false],
  ['2026-10-22T14:25:00.000Z', false], ['2026-10-23T14:25:00.000Z', false],
  ['2026-10-24T14:25:00.000Z', false], ['2026-10-25T14:25:00.000Z', false],
  ['2026-11-02T15:23:00.000Z', true], ['2026-11-02T14:23:00.000Z', false],
  ['2026-03-09T14:23:00.000Z', true], ['2026-03-09T15:23:00.000Z', false],
  ['2026-03-02T15:23:00.000Z', true], ['2026-10-19T15:23:00.000Z', false],
] as const) test(`window/DST: ${date} -> ${allowed}`, () => { assert.equal(collectionWindow(date, schedule).allowed, allowed); });

test('schedule: defaults centralized and invalid configuration rejected', () => {
  assert.deepEqual(schedule, { timezone: 'America/New_York', days: ['MONDAY', 'WEDNESDAY'], departure: '10:30', minutesBefore: 7, intervalSeconds: 30 });
  for (const env of [{ COMMUTE_TIMEZONE: 'UTC' }, { COMMUTE_DAYS: 'MON' }, { COMMUTE_DAYS: 'MONDAY,MONDAY' }, { COMMUTE_DEPARTURE_TIME: '25:00' }, { COMMUTE_COLLECTION_START_MINUTES_BEFORE: '-1' }, { COMMUTE_COLLECTION_INTERVAL_SECONDS: '5' }, { COMMUTE_DEPARTURE_TIME: '00:01' }]) assert.throws(() => collectionSchedule(env));
  assert.throws(() => collectionWindow('bad', schedule));
});
const secret = 'FAKE_CRON_SECRET_FOR_OFFLINE_TESTS_123456';
const request = (auth?: string, body: object = { scheduledAt: at(0, 0) }) => new Request('https://offline.example/api/internal/commute/collect', { method: 'POST', headers: auth ? { Authorization: auth } : {}, body: JSON.stringify(body) });
for (const auth of [undefined, 'Bearer incorrect', 'wrong-prefix ' + secret]) test(`auth rejects ${auth === undefined ? 'missing' : auth.startsWith('Bearer') ? 'incorrect' : 'wrong prefix'} before acquisition`, async () => {
  let calls = 0;
  const handler = createCollectorHandler(() => secret, async () => { calls++; throw Error('NOT_EXPECTED'); });
  const response = await handler(request(auth)); assert.equal(response.status, 401); assert.equal(calls, 0); assert.ok(!(await response.text()).includes(secret));
});
test('auth fails closed when server secret missing or too short', async () => {
  for (const s of [undefined, 'short']) assert.equal((await createCollectorHandler(() => s, async () => { throw Error(); })(request('Bearer ' + s))).status, 503);
});
test('authenticated outside-window request is a no-op without MTA or database requests', async () => {
  let calls = 0;
  const history = store(scope(), async () => { calls++; throw Error(); });
  const handler = createCollectorHandler(() => secret, intendedAt => collectScheduled({ scope: scope(), history, schedule, clock: () => '2026-10-20T14:23:00Z', source: { vehicleMonitoring: async () => { calls++; throw Error(); }, stopMonitoring: async () => { calls++; throw Error(); } } }, intendedAt));
  const response = await handler(request('Bearer ' + secret)); assert.equal(response.status, 200); assert.equal((await response.json()).reason, 'OUTSIDE_COLLECTION_WINDOW'); assert.equal(calls, 0);
});
test('correct authentication collects one paired frame and emits only safe metadata', async () => {
  const id = scope(); const handler = createCollectorHandler(() => secret, () => run(id, 0));
  const response = await handler(request('Bearer ' + secret)); const text = await response.text();
  assert.equal(response.status, 200); assert.equal(JSON.parse(text).reason, 'COLLECTED'); assert.ok(!text.includes(secret)); assert.ok(!text.includes('sb_secret_'));
  assert.equal((await store(id).getRecent(at(0))).length, 1);
});
test('untrusted slot, expired slot, future slot and malformed request cannot collect', async () => {
  const id = scope();
  for (const intendedAt of ['not-a-date', at(-3, 0), at(1, 0), '2026-10-20T14:23:00Z']) {
    const result = await collectScheduled({ scope: id, history: store(id), source: source(fixture(0)), schedule, clock: () => at(0) }, intendedAt);
    assert.equal(result.collected, false);
  }
  const handler = createCollectorHandler(() => secret, () => { throw Error(); });
  const response = await handler(request('Bearer ' + secret, { scheduledAt: 'bad' })); assert.notEqual(response.status, 200);
  assert.equal((await store(id).getRecent(at(0))).length, 0);
});
for (const missing of ['vm', 'sm', 'both'] as const) test(`upstream ${missing} failure is persisted incomplete evidence, never ghost risk`, async () => {
  const id = scope(), f = fixture(0);
  if (missing !== 'sm') delete f.vm;
  if (missing !== 'vm') delete f.sm;
  const result = await run(id, 0, f); assert.equal(result.collected, true); assert.equal(result.reason, missing === 'both' ? 'UPSTREAM_FAILURE' : 'UPSTREAM_PARTIAL_FAILURE');
  const rows = await store(id).getRecent(at(0)); assert.equal(rows.length, 1); assert.ok(rows[0]!.errors?.length);
  const decision = await new CommuteDecisionService({ history: store(id), clock: () => at(0) }).assess();
  assert.equal(decision.primaryLeg.status, 'UNVERIFIED'); assert.equal(decision.recommendation.action, 'BACKUP_ROUTE');
});
test('malformed-source issues are retained and safe empty responses remain empty', async () => {
  const id = scope(), f = fixture(0); f.vm!.issues.push('MISSING_TIMESTAMP');
  assert.equal((await run(id, 0, f)).reason, 'UPSTREAM_ISSUES');
  const empty = fixture(1); empty.vm!.observations = []; empty.sm!.observations = [];
  assert.equal((await run(id, 1, empty)).collected, true);
  const decision = await new CommuteDecisionService({ history: store(id), clock: () => at(1) }).assess(); assert.equal(decision.primaryLeg.status, 'UNVERIFIED');
});
test('same slot retry across new services never fetches again or duplicates frames', async () => {
  const id = scope(); await run(id, 0);
  let calls = 0; const retry = await collectScheduled({ scope: id, history: store(id), source: { vehicleMonitoring: async () => { calls++; throw Error(); }, stopMonitoring: async () => { calls++; throw Error(); } }, schedule, clock: () => at(1) }, at(0, 0));
  assert.equal(retry.reason, 'DUPLICATE_ACQUISITION'); assert.equal(calls, 0); assert.equal((await store(id).getRecent(at(1))).length, 1);
});
test('separate slots with identical MTA timestamps remain two frames and cannot fake progress', async () => {
  const id = scope(); await run(id, 0); await run(id, 1, fixture(0));
  const rows = await store(id).getRecent(at(1)); assert.equal(rows.length, 2); assert.notEqual(rows[0]!.acquisitionId, rows[1]!.acquisitionId); assert.equal(rows[0]!.vm!.observations[0]!.timestamp, rows[1]!.vm!.observations[0]!.timestamp);
  const decision = await new CommuteDecisionService({ history: store(id), clock: () => at(1) }).assess(); assert.equal(decision.primaryLeg.status, 'UNVERIFIED'); assert.ok(decision.primaryLeg.reasonCodes.includes('REPEATED_TIMESTAMP'));
});
test('overlapping separate collector instances are fenced by the database lease', async () => {
  const id = scope(); let release!: () => void; let entered!: () => void;
  const blocked = new Promise<void>(r => { release = r; }); const started = new Promise<void>(r => { entered = r; });
  const slow: CommuteObservationSource = { vehicleMonitoring: async () => { entered(); await blocked; return fixture(0).vm!; }, stopMonitoring: async () => fixture(0).sm! };
  const first = collectScheduled({ scope: id, history: store(id), source: slow, schedule, clock: () => at(0) }, at(0, 0));
  await started;
  assert.equal((await run(id, 0)).reason, 'DUPLICATE_ACQUISITION');
  assert.equal((await run(id, 1)).reason, 'COLLECTION_IN_PROGRESS');
  release(); assert.equal((await first).collected, true); assert.equal((await store(id).getRecent(at(1))).length, 1);
});
test('storage write failure leaves no fabricated frame; expiry fences old owner and next frame preserves HISTORY_GAP', async () => {
  const id = scope(); const transport = sqlRest(db);
  const broken = store(id, async (input, init) => String(input).endsWith('/cg_complete_collection') ? new Response(null, { status: 500 }) : transport(input, init));
  assert.equal((await run(id, 0, fixture(0), broken)).reason, 'STORAGE_FAILURE'); assert.equal((await store(id).getRecent(at(0))).length, 0);
  await db.query("update public.commute_collection_state set lease_until=clock_timestamp()-interval '1 second' where scope_id=$1", [id]);
  const old = (await db.query<{ lease_token: string }>('select lease_token from public.commute_collection_state where scope_id=$1', [id])).rows[0]!.lease_token;
  assert.equal((await run(id, 1)).collected, true);
  await assert.rejects(() => store(id).completeCollection(at(0, 0), old, { ...fixture(0), acquisitionId: scheduledAcquisitionId(id, at(0, 0)) }, 'COLLECTED'));
  const rows = await store(id).getRecent(at(1)); assert.equal(rows.length, 1); assert.ok(rows[0]!.errors!.includes('HISTORY_GAP'));
  const decision = await new CommuteDecisionService({ history: store(id), clock: () => at(1) }).assess(); assert.equal(decision.primaryLeg.status, 'UNVERIFIED'); assert.equal(decision.recommendation.action, 'BACKUP_ROUTE');
});
test('database connectivity failure produces sanitized STORAGE_FAILURE and no memory fallback', async () => {
  const id = scope(); assert.equal((await run(id, 0, fixture(0), store(id, async () => { throw Error(secret); }))).reason, 'STORAGE_FAILURE');
  const handler = createCollectorHandler(() => secret, () => run(id, 0, fixture(0), store(id, async () => { throw Error(secret); })));
  const response = await handler(request('Bearer ' + secret)); assert.equal(response.status, 503); assert.ok(!(await response.text()).includes(secret));
});
test('migration: state RLS, browser-role denial and service-role RPC privileges', async () => {
  const row = (await db.query<{ relrowsecurity: boolean }>("select relrowsecurity from pg_class where oid='public.commute_collection_state'::regclass")).rows[0]!; assert.equal(row.relrowsecurity, true);
  for (const role of ['anon', 'authenticated', 'service_role']) {
    const allowed = (await db.query<{ value: boolean }>("select has_function_privilege($1,'public.cg_claim_collection(text,timestamptz,uuid,uuid)','EXECUTE') as value", [role])).rows[0]!.value;
    assert.equal(allowed, role === 'service_role');
  }
});
test('diagnostics report durable last completion through a new store', async () => {
  const id = scope(); assert.equal((await store(id).collectionStatus()).state, 'NONE'); await run(id, 0);
  const status = await store(id).collectionStatus(); assert.equal(status.state, 'COLLECTED'); assert.equal(status.lastResult, 'COLLECTED'); assert.equal(Date.parse(status.lastCompletedAt!), Date.parse(at(0)));
});
test('acquisition identity is stable per scope/slot and unrelated to source timestamps', () => {
  const id = scope(); assert.equal(scheduledAcquisitionId(id, at(0)), scheduledAcquisitionId(id, at(0))); assert.notEqual(scheduledAcquisitionId(id, at(0)), scheduledAcquisitionId(id, at(1))); assert.notEqual(scheduledAcquisitionId(id, at(0)), scheduledAcquisitionId(scope(), at(0)));
});
test('scheduled Bx28 scope excludes old Bx10 and wrong-direction histories', async () => {
  const name = randomUUID(), active = commuteScope(DEFAULT_COMMUTE, name);
  await run(active, 0);
  for (const config of [commuteConfiguration, { ...DEFAULT_COMMUTE, target: { ...DEFAULT_COMMUTE.target, directionId: '0' } }]) {
    const other = commuteScope(config, name); await run(other, 1);
    assert.equal((await store(other).getRecent(at(1))).length, 1);
  }
  assert.equal((await store(active).getRecent(at(1))).length, 1);
});
for (const scenario of ['A_QUALIFYING', 'B_INSUFFICIENT', 'C_EXPIRED'] as const) test(`workflow: Monday automatic collection -> new website ${scenario}`, async () => {
  const id = scope(); assert.equal((await store(id).getRecent('2026-10-19T14:22:30Z')).length, 0);
  const count = scenario === 'A_QUALIFYING' ? 14 : scenario === 'B_INSUFFICIENT' ? 1 : 5;
  for (let i = 0; i < count; i++) assert.equal((await run(id, i)).collected, true);
  if (scenario === 'C_EXPIRED') assert.equal((await new CommuteDecisionService({ history: store(id), clock: () => at(4) }).assess()).primaryLeg.status, 'VERIFIED');
  const clock = scenario === 'C_EXPIRED' ? '2026-10-19T14:40:01Z' : at(14);
  const web = new CommuteDecisionService({ history: store(id), source: source(fixture(14)), clock: () => clock });
  if (scenario !== 'C_EXPIRED') assert.equal((await web.ingestLive()).stored, true);
  const d = await web.assess();
  assert.equal(d.primaryLeg.status, scenario === 'A_QUALIFYING' ? 'VERIFIED' : 'UNVERIFIED'); assert.equal(d.recommendation.action, scenario === 'A_QUALIFYING' ? 'NORMAL_ROUTE' : 'BACKUP_ROUTE');
  if (scenario === 'A_QUALIFYING') assert.equal(d.primaryLeg.evidence.framesRetained, 15);
  if (scenario === 'C_EXPIRED') assert.equal(d.primaryLeg.evidence.framesRetained, 0);
});
test('earlier VERIFIED-capable sequence remains retained but is stale at departure', async () => {
  const id = scope(); for (let i = 0; i < 5; i++) await run(id, i);
  const d = await new CommuteDecisionService({ history: store(id), clock: () => at(14) }).assess(); assert.equal(d.primaryLeg.evidence.framesRetained, 5); assert.equal(d.primaryLeg.status, 'UNVERIFIED');
});
test('Phase 2 policy and active intermediate commute unchanged', () => {
  assert.equal(PROVISIONAL_POLICY.minimumDistinctObservations, 3); assert.equal(PROVISIONAL_POLICY.minimumStableAssignmentObservations, 3); assert.equal(PROVISIONAL_POLICY.minimumProgressingObservations, 2); assert.equal(PROVISIONAL_POLICY.maxObservationAgeSeconds, 90); assert.equal(PROVISIONAL_POLICY.historyWindowSeconds, 600); assert.equal(DEFAULT_COMMUTE.target.isOrigin, false);
});

test('cron activation SQL compiles offline with extension stubs, uses 30-second job and blocks browser execution', async () => {
  // Real managed extensions are unavailable in PGlite. Stub only extension boundaries, not our dispatcher SQL.
  await db.exec(`create schema vault; create table vault.decrypted_secrets(name text, decrypted_secret text);
    create schema net; create function net.http_post(url text, headers jsonb, body jsonb, timeout_milliseconds integer) returns bigint language sql as 'select 1::bigint';
    create schema cron; create table cron.offline_jobs(name text, schedule text, command text);
    create function cron.schedule(text,text,text) returns bigint language plpgsql as $$begin insert into cron.offline_jobs values($1,$2,$3); return 1; end;$$;`);
  await db.exec(await readFile(new URL('../supabase/cron/activate.sql', import.meta.url), 'utf8'));
  const jobs = (await db.query<{ schedule: string }>('select schedule from cron.offline_jobs')).rows;
  assert.equal(jobs.length, 1); assert.equal(jobs[0]!.schedule, '30 seconds');
  for (const role of ['anon', 'authenticated', 'service_role']) assert.equal((await db.query<{ allowed: boolean }>("select has_function_privilege($1,'public.cg_dispatch_collection()','EXECUTE') as allowed", [role])).rows[0]!.allowed, false);
});
test('cron credential cannot be retained in normalized scheduled frame', async () => {
  const id = scope(), f = fixture(0);
  f.vm!.observations[0]!.tripId = secret;
  const protectedStore = new SupabaseObservationHistory({ scope: id, url: 'https://offline.example', secretKey: 'sb_secret_FAKE_TEST_ONLY', redactions: [secret] }, sqlRest(db));
  assert.equal((await run(id, 0, f, protectedStore)).reason, 'STORAGE_FAILURE');
  assert.equal((await store(id).getRecent(at(0))).length, 0);
});
test('expired owner cannot commit even before another owner claims a slot', async () => {
  const id = scope(), token = randomUUID(), acquisitionId = scheduledAcquisitionId(id, at(0, 0));
  await store(id).claimCollection(at(0, 0), acquisitionId, token);
  await db.query("update public.commute_collection_state set lease_until=clock_timestamp()-interval '1 second' where scope_id=$1", [id]);
  await assert.rejects(() => store(id).completeCollection(at(0, 0), token, { ...fixture(0), acquisitionId }, 'COLLECTED'));
  assert.equal((await store(id).collectionStatus()).state, 'ABANDONED');
  assert.equal((await store(id).getRecent(at(0))).length, 0);
});
