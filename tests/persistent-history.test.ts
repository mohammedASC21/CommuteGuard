import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DecisionCard } from '../src/components/commute-screen.js';
import { PGlite } from '@electric-sql/pglite';
import { migratedDb, sqlRest } from './helpers/persistent-db.js';
import { SupabaseObservationHistory } from '../src/lib/history/supabase-history.js';
import { commuteScope } from '../src/lib/history/scope.js';
import { createHistoryBackend } from '../src/lib/history/backend.js';
import { CommuteDecisionService, DEFAULT_COMMUTE } from '../src/lib/commute/index.js';
import type { ReliabilityFrame } from '../src/lib/reliability/index.js';
import { PROVISIONAL_POLICY } from '../src/lib/reliability/index.js';
import { frames, time, commuteConfiguration } from './fixtures/reliability/current-trip.js';
import { createCommuteHandler } from '../src/server/commute-handler.js';

let db: PGlite;
before(async () => { db = await migratedDb(); });
after(async () => { await db?.close(); });
const scope = () => commuteScope(DEFAULT_COMMUTE, `test_${randomUUID()}`);
function fixture(count = 3): ReliabilityFrame[] {
  return frames(count).map(f => {
    f.acquisitionId = randomUUID();
    for (const b of [f.vm, f.sm]) for (const o of b!.observations) {
      o.routeId = DEFAULT_COMMUTE.target.routeId; o.staticAssignment = { directionId: '1', destinationId: 'MTA_101530', destinationName: DEFAULT_COMMUTE.destination };
      o.monitoredCall!.staticReference.stopId = 'MTA_103617';
    }
    return f;
  });
}
const store = (id = scope(), fetcher = sqlRest(db), retentionSeconds?: number) => new SupabaseObservationHistory({ url: 'https://offline.example', secretKey: 'sb_secret_FAKE_TEST_ONLY', scope: id, retentionSeconds }, fetcher);
const service = (history = store(), clock = time(62)) => new CommuteDecisionService({ history, clock: () => clock });

// Migration validation executes actual DDL/functions and checks access controls.
test('migration: table, UUID constraint, indexes, RLS and server-role RPC permissions', async () => {
  const rls = await db.query<{ relrowsecurity: boolean }>("select relrowsecurity from pg_class where oid='public.commute_observation_frames'::regclass");
  assert.equal(rls.rows[0]!.relrowsecurity, true);
  const indexes = await db.query<{ indexname: string }>("select indexname from pg_indexes where tablename='commute_observation_frames'");
  assert.ok(indexes.rows.some(i => i.indexname === 'commute_frames_recent_idx'));
  assert.ok(indexes.rows.some(i => i.indexname === 'commute_frames_retention_idx'));
  for (const role of ['anon', 'authenticated']) {
    const grants = await db.query<{ allowed: boolean }>("select has_function_privilege($1, 'public.cg_append_frame(text,uuid,timestamptz,jsonb,integer)', 'EXECUTE') as allowed", [role]);
    assert.equal(grants.rows[0]!.allowed, false);
  }
  const grants = await db.query<{ allowed: boolean }>("select has_function_privilege('service_role', 'public.cg_append_frame(text,uuid,timestamptz,jsonb,integer)', 'EXECUTE') as allowed");
  assert.equal(grants.rows[0]!.allowed, true);
});
test('durable collector A -> replacement web service B -> persisted Bx28 VERIFIED, then current negative supersedes it', async () => {
  const id = scope(), saved = fixture();
  const collector = service(store(id));
  for (const f of saved) assert.equal(await collector.ingest(f), true);
  const freshWebService = service(store(id));
  const d = await freshWebService.assess();
  assert.equal(d.primaryLeg.status, 'VERIFIED'); assert.equal(d.recommendation.action, 'NORMAL_ROUTE');
  const next = fixture(4)[3]!;
  for (const b of [next.vm, next.sm]) b!.observations[0]!.progressStatus = 'prevTrip';
  assert.equal(await freshWebService.ingest(next), true);
  const current = await freshWebService.assess(time(92));
  assert.equal(current.primaryLeg.status, 'UNVERIFIED'); assert.equal(current.recommendation.action, 'BACKUP_ROUTE');
});
test('file-backed PostgreSQL survives database close/reopen as well as store replacement', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'commuteguard-pg-'));
  try {
    const id = scope(), saved = fixture();
    const a = await migratedDb(directory);
    for (const f of saved) await store(id, sqlRest(a)).add(f);
    await a.close();
    const b = new PGlite(directory);
    try { assert.equal((await service(store(id, sqlRest(b))).assess()).primaryLeg.status, 'VERIFIED'); }
    finally { await b.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('scope is stable and includes route, direction, origin, branch and downstream stop', () => {
  assert.equal(commuteScope(DEFAULT_COMMUTE), commuteScope(structuredClone(DEFAULT_COMMUTE)));
  for (const c of [commuteConfiguration, { ...DEFAULT_COMMUTE, target: { ...DEFAULT_COMMUTE.target, directionId: '0' } }, { ...DEFAULT_COMMUTE, target: { ...DEFAULT_COMMUTE.target, isOrigin: true } }, { ...DEFAULT_COMMUTE, destinationId: 'OTHER' }, { ...DEFAULT_COMMUTE, alightingStopId: 'OTHER' }]) assert.notEqual(commuteScope(c), commuteScope(DEFAULT_COMMUTE));
});
for (const mismatch of ['BX10', 'DIRECTION']) test(`scope prevents ${mismatch} history from entering Bx28`, async () => {
  const name = `test_${randomUUID()}`;
  const other = mismatch === 'BX10' ? commuteConfiguration : { ...DEFAULT_COMMUTE, target: { ...DEFAULT_COMMUTE.target, directionId: '0' } };
  const old = store(commuteScope(other, name));
  const saved = mismatch === 'BX10' ? frames(3).map(f => ({ ...f, acquisitionId: randomUUID() })) : fixture();
  if (mismatch === 'DIRECTION') for (const f of saved) for (const b of [f.vm, f.sm]) b!.observations[0]!.staticAssignment.directionId = '0';
  for (const f of saved) await old.add(f);
  assert.equal((await store(commuteScope(DEFAULT_COMMUTE, name)).getRecent(time(62))).length, 0);
});
test('out-of-order arrival is reconstructed chronologically without changing completion times', async () => {
  const s = store(), saved = fixture();
  for (const f of saved.toReversed()) await s.add(f);
  assert.deepEqual((await s.getRecent(time(62))).map(f => f.completedAt), saved.map(f => f.completedAt));
});
test('evidence window excludes old frames independently of row retention', async () => {
  const s = store(); const f = fixture()[0]!; await s.add(f);
  assert.equal((await s.getRecent(time(602))).length, 1);
  assert.equal((await s.getRecent(time(603))).length, 0);
  assert.equal(PROVISIONAL_POLICY.historyWindowSeconds, 600);
});
test('retention cleanup removes old ingested rows but never changes classifier policy', async () => {
  const id = scope(), s = store(id, sqlRest(db), 600), saved = fixture();
  await s.add(saved[0]!);
  await db.query("update public.commute_observation_frames set created_at = clock_timestamp() - interval '601 seconds' where scope_id=$1", [id]);
  await s.add(saved[1]!);
  assert.equal((await s.getRecent(time(62))).length, 1);
  assert.equal(PROVISIONAL_POLICY.minimumDistinctObservations, 3);
  assert.throws(() => store(scope(), sqlRest(db), 599), /INVALID_HISTORY_RETENTION/);
});
test('duplicate acquisition is idempotent and conflicting retry cannot overwrite original', async () => {
  const s = store(), f = fixture()[0]!;
  await s.add(f); await s.add(structuredClone(f));
  assert.equal((await s.getRecent(time(62))).length, 1);
  const changed = structuredClone(f); changed.sm!.observations[0]!.latitude = 1;
  await assert.rejects(s.add(changed), /HISTORY_WRITE_FAILED/);
});
test('concurrent duplicate inserts create one acquisition row', async () => {
  const id = scope(), f = fixture()[0]!;
  await Promise.all(Array.from({ length: 8 }, () => store(id).add(f)));
  assert.equal((await store(id).getRecent(time(62))).length, 1);
});
test('different acquisitions with repeated source timestamps remain separate evidence', async () => {
  const s = store(), saved = fixture();
  for (const b of [saved[1]!.vm, saved[1]!.sm]) b!.observations[0]!.timestamp = saved[0]!.vm!.observations[0]!.timestamp;
  for (const f of saved.slice(0, 2)) await s.add(f);
  assert.equal((await s.getRecent(time(32))).length, 2);
  const d = await service(s, time(32)).assess(); assert.equal(d.primaryLeg.status, 'UNVERIFIED'); assert.ok(d.primaryLeg.reasonCodes.includes('REPEATED_TIMESTAMP'));
});
for (const mode of ['VM_FAILED', 'SM_FAILED', 'BOTH_FAILED', 'EMPTY'] as const) test(`${mode} normalized acquisition persists without disguising failure/emptiness`, async () => {
  const s = store(), f = fixture()[0]!;
  if (mode === 'VM_FAILED' || mode === 'BOTH_FAILED') delete f.vm;
  if (mode === 'SM_FAILED' || mode === 'BOTH_FAILED') delete f.sm;
  if (mode === 'EMPTY') { f.vm!.observations = []; f.sm!.observations = []; }
  else f.errors = ['private upstream description must be discarded'];
  await s.add(f);
  const restored = (await s.getRecent(time(2)))[0]!;
  assert.equal(!!restored.vm, !!f.vm); assert.equal(!!restored.sm, !!f.sm);
  assert.ok(!JSON.stringify(restored).includes('private upstream'));
  const d = await service(s, time(2)).assess(); assert.equal(d.primaryLeg.status, 'UNVERIFIED'); assert.equal(d.recommendation.action, 'BACKUP_ROUTE');
  assert.equal(d.dataHealth.status, mode === 'EMPTY' ? 'HEALTHY' : mode === 'BOTH_FAILED' ? 'UNAVAILABLE' : 'DEGRADED');
});
test('DB read failure is history failure and backup, never a cached normal route or ghost diagnosis', async () => {
  const s = store(scope(), async () => { throw Error('SECRET_URL_WITH_CREDENTIAL'); });
  const d = await service(s).assess();
  assert.equal(d.primaryLeg.status, 'UNVERIFIED'); assert.equal(d.recommendation.action, 'BACKUP_ROUTE'); assert.equal(d.dataHealth.history, 'FAILED');
  assert.ok(!JSON.stringify(d).includes('SECRET_URL')); assert.ok(d.primaryLeg.reasonCodes.includes('HISTORY_UNAVAILABLE'));
});
test('failed write overrides previously verified history; successful recovery stores a gap', async () => {
  const id = scope(), saved = fixture(5), good = sqlRest(db); let fail = false;
  const s = store(id, async (input, init) => fail && String(input).includes('cg_append_frame') ? new Response(null, { status: 500 }) : good(input, init));
  const a = service(s);
  for (const f of saved.slice(0,3)) await a.ingest(f);
  assert.equal((await a.assess()).primaryLeg.status, 'VERIFIED');
  fail = true; assert.equal(await a.ingest(saved[3]!), false);
  assert.equal((await a.assess(time(92))).primaryLeg.status, 'UNVERIFIED');
  fail = false; await a.ingest(saved[4]!);
  const recovered = await a.assess(time(122)); assert.equal(recovered.dataHealth.history, 'GAP'); assert.equal(recovered.primaryLeg.status, 'UNVERIFIED');
});
test('lost write response can retry the same acquisition without duplicate evidence', async () => {
  const id = scope(), f = fixture()[0]!, good = sqlRest(db); let lose = true;
  const s = store(id, async (input, init) => { const r = await good(input, init); if (lose) { lose = false; throw Error('LOST_RESPONSE'); } return r; });
  const a = service(s); assert.equal(await a.ingest(f), false); assert.equal(await a.ingest(f), true);
  assert.equal((await store(id).getRecent(time(2))).length, 1);
});
test('API transport uses a fresh service with the same durable collector history', async () => {
  const id = scope(), saved = fixture(); for (const f of saved) await service(store(id)).ingest(f);
  const web = new CommuteDecisionService({ history: store(id), clock: () => time(92), source: { vehicleMonitoring: async () => fixture(4)[3]!.vm!, stopMonitoring: async () => fixture(4)[3]!.sm! } });
  const r = await createCommuteHandler(() => web)(); const d = await r.json();
  assert.equal(d.primaryLeg.status, 'VERIFIED'); assert.equal(d.primaryLeg.route, 'Bx28'); assert.equal(d.primaryLeg.evidence.framesRetained, 4);
});
test('malformed DB payload fails closed instead of skipping bad evidence', async () => {
  const s = store(scope(), async () => Response.json([{ completedAt: 'not valid' }]));
  assert.equal((await service(s).assess()).dataHealth.history, 'FAILED');
});
test('credentials and non-model fields never enter persisted payload or API errors', async () => {
  const id = scope(), f = fixture()[0]!;
  Object.assign(f, { apiKey: 'FAKE_MTA_KEY', rawResponse: { secret: 'FAKE_DB_KEY' } });
  const s = store(id); await s.add(f); assert.ok(!JSON.stringify(await s.getRecent(time(2))).includes('FAKE_MTA_KEY'));
  const sensitive = new SupabaseObservationHistory({ url: 'https://offline.example', scope: id, secretKey: 'sb_secret_PRIVATE_TEST', redactions: ['MTA_PRIVATE_TEST'] }, sqlRest(db));
  f.vm!.observations[0]!.tripId = 'MTA_PRIVATE_TEST'; await assert.rejects(sensitive.add(f), { message: 'HISTORY_WRITE_FAILED' });
  const r = await createCommuteHandler(() => { throw Error('sb_secret_PRIVATE_TEST'); })();
  assert.ok(!(await r.text()).includes('PRIVATE_TEST'));
});
test('backend selection is shared, explicit, and never silently falls back on Supabase failure', async () => {
  assert.equal(createHistoryBackend({}).backend, 'NOT_CONFIGURED');
  assert.equal(createHistoryBackend({ COMMUTEGUARD_HISTORY_BACKEND: 'memory' }).backend, 'MEMORY');
  assert.equal(createHistoryBackend({ COMMUTEGUARD_HISTORY_BACKEND: 'memory', NODE_ENV: 'production' }).backend, 'NOT_CONFIGURED');
  const env = { SUPABASE_URL: 'https://offline.example', SUPABASE_SECRET_KEY: 'sb_secret_FAKE_TEST_ONLY' };
  const a = createHistoryBackend(env, DEFAULT_COMMUTE, sqlRest(db)), b = createHistoryBackend(env, DEFAULT_COMMUTE, sqlRest(db));
  assert.equal(a.backend, 'SUPABASE'); assert.equal(a.scope, b.scope);
  for (const f of fixture()) await a.store.add(f);
  assert.equal((await service(b.store as SupabaseObservationHistory).assess()).primaryLeg.status, 'VERIFIED');
});

test('manual retention cleanup works without any background scheduler', async () => {
  const id = scope(), s = store(id); await s.add(fixture()[0]!);
  await db.query("update public.commute_observation_frames set created_at = clock_timestamp() - interval '2 days' where scope_id=$1", [id]);
  await s.prune(); assert.equal((await s.getRecent(time(62))).length, 0);
});
test('bounded retrieval keeps newest frames, including invalid future clocks rather than hiding them', async () => {
  const s = store();
  for (const [i, f] of fixture(45).entries()) { f.completedAt = time(2 + i); await s.add(f); }
  const recent = await s.getRecent(time(62)); assert.equal(recent.length, 40); assert.equal(recent[0]!.completedAt, time(7));
  assert.equal((await service(s).assess()).primaryLeg.status, 'UNVERIFIED');
});
test('SQL rejects a malformed frame identity and browser roles cannot read the table', async () => {
  await assert.rejects(db.query('insert into public.commute_observation_frames(scope_id,acquisition_id,completed_at,frame) values($1,$2,$3,$4)', [scope(), randomUUID(), time(2), JSON.stringify({ acquisitionId: null, completedAt: time(2) })]));
  await db.exec('set role anon');
  try { await assert.rejects(db.query('select * from public.commute_observation_frames')); }
  finally { await db.exec('reset role'); }
});
test('secret and legacy JWT keys stay in server headers, not the RPC body or request URL', async () => {
  for (const secretKey of ['sb_secret_FAKE_HEADER_KEY', 'FAKE.JWT.SERVICE_ROLE']) {
    const s = new SupabaseObservationHistory({ url: 'https://offline.example', scope: scope(), secretKey }, async (input, init) => {
      assert.ok(!String(input).includes(secretKey)); assert.ok(!String(init?.body).includes(secretKey));
      const h = init?.headers as Record<string, string>; assert.equal(h.apikey, secretKey);
      assert.equal(h.Authorization, secretKey.startsWith('sb_secret_') ? undefined : `Bearer ${secretKey}`);
      return Response.json([]);
    });
    await s.getRecent(time(62));
  }
});

test('normalized provenance and previous/current trip contexts survive database roundtrip', async () => {
  const s = store(), f = fixture()[0]!;
  f.vm!.observations[0]!.tripId = 'CURRENT_PREVIOUS_TRIP'; f.sm!.observations[0]!.tripId = 'FUTURE_BOARDING_TRIP';
  for (const b of [f.vm, f.sm]) {
    const o = b!.observations[0]!; o.progressStatus = 'layover,prevTrip'; o.progressRate = 'noProgress';
    o.staticAssignment.originScheduledDeparture = time(300);
    o.monitoredCall!.staticReference.scheduledArrival = time(180);
    o.monitoredCall!.realtimePrediction.expectedArrival = time(210);
    b!.issues = ['MISSING_OR_INVALID_timestamp'];
  }
  await s.add(f); const restored = (await s.getRecent(time(2)))[0]!;
  assert.deepEqual(restored.vm, JSON.parse(JSON.stringify(f.vm)));
  assert.deepEqual(restored.sm, JSON.parse(JSON.stringify(f.sm)));
});
test('configured database outage stays SUPABASE and yields history failure without memory fallback', async () => {
  const binding = createHistoryBackend({ SUPABASE_URL: 'https://offline.example', SUPABASE_SECRET_KEY: 'sb_secret_FAKE' }, DEFAULT_COMMUTE, async () => { throw Error('sb_secret_FAKE'); });
  const a = new CommuteDecisionService({ history: binding.store, clock: () => time(62) });
  assert.equal(binding.backend, 'SUPABASE'); assert.equal((await a.assess()).dataHealth.history, 'FAILED');
  assert.equal(binding.backend, 'SUPABASE');
});

test('web regression: persisted Bx28 VERIFIED, UNVERIFIED and HIGH_GHOST_RISK render their service recommendations', async () => {
  for (const status of ['VERIFIED', 'UNVERIFIED', 'HIGH_GHOST_RISK'] as const) {
    const s = store();
    const saved = status === 'UNVERIFIED' ? fixture(1) : fixture(status === 'HIGH_GHOST_RISK' ? 5 : 3);
    if (status === 'HIGH_GHOST_RISK') saved.forEach((f, i) => {
      for (const b of [f.vm, f.sm]) { const o = b!.observations[0]!; o.timestamp = time(i * 30 - 200); o.monitoredCall!.realtimePrediction.distanceFromStopMeters = 100 + i * 50; }
    });
    for (const f of saved) await s.add(f);
    const d = await service(s, saved.at(-1)!.completedAt).assess();
    assert.equal(d.primaryLeg.status, status);
    const html = renderToStaticMarkup(createElement(DecisionCard, { decision: d }));
    assert.match(html, /Bx28/); assert.match(html, /BAINBRIDGE AV\/E 206 ST/);
    assert.ok(html.includes(d.recommendation.label));
    assert.equal(d.recommendation.action, status === 'VERIFIED' ? 'NORMAL_ROUTE' : 'BACKUP_ROUTE');
  }
});

test('migration functions work under the Supabase service_role rather than only the migration owner', async () => {
  const s = store(); await db.exec('set role service_role');
  try { await s.add(fixture()[0]!); assert.equal((await s.getRecent(time(2))).length, 1); }
  finally { await db.exec('reset role'); }
});

test('Supabase project URL and Data API base URL resolve the same RPC path without altering secrets', async () => {
  for (const path of ['', '/', '/rest/v1', '/rest/v1/']) {
    const s = new SupabaseObservationHistory({ url: `https://offline.example${path}`, secretKey: 'sb_secret_FAKE_ONLY', scope: scope() }, async input => {
      assert.equal(new URL(String(input)).pathname, '/rest/v1/rpc/cg_recent_frames');
      return Response.json([]);
    });
    assert.deepEqual(await s.getRecent(time(62)), []);
  }
  assert.throws(() => new SupabaseObservationHistory({ url: 'https://offline.example/arbitrary', secretKey: 'FAKE', scope: scope() }), /INVALID_HISTORY_CONFIGURATION/);
});

test('persistent web-after-CLI: fresh duplicate acquisition survives store recreation without resetting unique evidence', async () => {
  const id = scope();
  const collector = service(store(id), time(62));
  const saved = fixture(3);
  for (const frame of saved) await collector.ingest(frame);
  const before = await collector.assess();
  assert.equal(before.primaryLeg.status, 'VERIFIED');
  const duplicate = structuredClone(saved.at(-1)!);
  duplicate.completedAt = time(69); duplicate.acquisitionId = randomUUID();
  for (const batch of [duplicate.vm!, duplicate.sm!]) {
    batch.responseTimestamp = time(68);
    batch.deliveries = [{ responseTimestamp: time(68), validUntil: time(129) }];
  }
  const web = new CommuteDecisionService({ history: store(id), clock: () => time(69), source: {
    vehicleMonitoring: async () => duplicate.vm!, stopMonitoring: async () => duplicate.sm!,
  } });
  const response = await createCommuteHandler(() => web)();
  const current = await response.json() as Awaited<ReturnType<CommuteDecisionService['assess']>>;
  assert.equal(current.primaryLeg.status, 'VERIFIED');
  assert.equal(current.primaryLeg.evidence.framesRetained, 4);
  assert.deepEqual({ ...current.primaryLeg.evidence, framesRetained: 3 }, before.primaryLeg.evidence);
  const recreated = await service(store(id), time(70)).assess();
  assert.equal(recreated.primaryLeg.status, 'VERIFIED');
  assert.equal((await store(id).getRecent(time(70))).length, 4);
  const stale = await service(store(id), time(152)).assess();
  assert.equal(stale.primaryLeg.status, 'UNVERIFIED');
  assert.equal(stale.recommendation.action, 'BACKUP_ROUTE');
});
