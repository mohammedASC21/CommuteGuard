import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { checkProductionEnvironment, productionOrigin, collectionUrl, assertProductionCollectionEnvironment } from '../src/lib/deployment/config.js';
import { productionSmoke } from '../src/lib/deployment/smoke.js';
import { decisionDisplayDeadline, observationDisplayDeadline } from '../src/lib/commute/presentation.js';
import { CommuteDecisionService, DEFAULT_COMMUTE, InMemoryObservationHistory } from '../src/lib/commute/index.js';
import { CommuteScreen, isDecision } from '../src/components/commute-screen.js';
import { frames, time, commuteConfiguration } from './fixtures/reliability/current-trip.js';

const env = { MTA_BUS_TIME_API_KEY: 'FAKE_MTA_SERVER_ONLY', MTA_STOP_ID: '103617', MTA_DIRECTION_ID: '1', SUPABASE_URL: 'https://offline.example', SUPABASE_SECRET_KEY: 'sb_secret_FAKE_SERVER_ONLY', COMMUTEGUARD_HISTORY_BACKEND: 'supabase', COMMUTEGUARD_CRON_SECRET: 'FAKE_DEDICATED_CRON_SECRET_123456789', COMMUTEGUARD_PRODUCTION_URL: 'https://commuteguard.example.com' };
const now = '2026-10-20T14:30:00.000Z'; // Tuesday, outside the schedule
async function decision() {
  const history = new InMemoryObservationHistory();
  const service = new CommuteDecisionService({ history, clock: () => time(62) });
  for (const frame of frames(3)) {
    for (const b of [frame.vm, frame.sm]) for (const o of b!.observations) { o.routeId = DEFAULT_COMMUTE.target.routeId; o.staticAssignment.directionId = '1'; o.staticAssignment.destinationId = DEFAULT_COMMUTE.destinationId; o.monitoredCall!.staticReference.stopId = DEFAULT_COMMUTE.target.stopId; }
    await service.ingest(frame);
  }
  return service.assess();
}
test('production env: valid explicit Supabase + dedicated cron + active Bx28 configuration', () => {
  assert.deepEqual(checkProductionEnvironment(env), { ready: true, issues: [] });
  assert.doesNotThrow(() => assertProductionCollectionEnvironment({ ...env, NODE_ENV: 'production' }));
});
for (const field of ['MTA_BUS_TIME_API_KEY','SUPABASE_URL','SUPABASE_SECRET_KEY','COMMUTEGUARD_CRON_SECRET','COMMUTEGUARD_PRODUCTION_URL'] as const) test(`production env: missing ${field} is reported by name without values`, () => {
  const result = checkProductionEnvironment({ ...env, [field]: undefined }); assert.equal(result.ready, false);
  const json = JSON.stringify(result); for (const key of [env.MTA_BUS_TIME_API_KEY, env.SUPABASE_SECRET_KEY, env.COMMUTEGUARD_CRON_SECRET]) assert.ok(!json.includes(key));
});
test('production env: memory, old Bx10 settings, changed schedule and public credential variables fail validation', () => {
  for (const update of [{ COMMUTEGUARD_HISTORY_BACKEND: 'memory' }, { MTA_STOP_ID: '103620', MTA_DIRECTION_ID: '0' }, { COMMUTE_DAYS: 'TUESDAY' }, { COMMUTE_COLLECTION_INTERVAL_SECONDS: '60' }, { NEXT_PUBLIC_SUPABASE_SECRET_KEY: env.SUPABASE_SECRET_KEY }]) assert.equal(checkProductionEnvironment({ ...env, ...update }).ready, false);
});
test('production env: dedicated cron secret cannot reuse known credentials', () => {
  for (const key of ['MTA_BUS_TIME_API_KEY','SUPABASE_SECRET_KEY','SUPABASE_SERVICE_ROLE_KEY','VERCEL_TOKEN','SUPABASE_DB_PASSWORD']) assert.ok(checkProductionEnvironment({ ...env, [key]: env.COMMUTEGUARD_CRON_SECRET }).issues.includes('CRON_SECRET_MUST_BE_DEDICATED'));
});
test('production env: origin is administrative only, not required by website/collector runtime', () => {
  assert.equal(checkProductionEnvironment({ ...env, COMMUTEGUARD_PRODUCTION_URL: undefined }, false).ready, true);
  assert.throws(() => assertProductionCollectionEnvironment({ ...env, NODE_ENV: 'production', COMMUTEGUARD_CRON_SECRET: undefined }), /PRODUCTION_CONFIGURATION_UNAVAILABLE/);
});
for (const url of ['http://localhost:3000','https://localhost','https://127.0.0.1','https://192.168.0.1','https://[::1]','https://commuteguard.local','https://user:password@example.com','https://example.com/path','https://example.com?token=FAKE','https://example.com#fragment','https://example.com:8443']) test(`production origin rejects unsafe form ${url.split('?')[0]}`, () => { assert.throws(() => productionOrigin(url), /^Error: INVALID_PRODUCTION_ORIGIN$/); });
test('production origin normalized once and creates the exact protected cron path', () => {
  assert.equal(productionOrigin('https://CommuteGuard.example.com/'), 'https://commuteguard.example.com');
  assert.equal(collectionUrl(env.COMMUTEGUARD_PRODUCTION_URL), 'https://commuteguard.example.com/api/internal/commute/collect');
});
test('production smoke uses injected HTTP: auth checks, outside-window no-op and fresh shared-history website', async () => {
  let calls = 0;
  const d = await decision();
  const fake: typeof fetch = async (input, init) => {
    calls++;
    if (String(input).endsWith('/api/commute')) return Response.json(d, { headers: { 'X-CommuteGuard-History': 'SUPABASE' } });
    assert.equal(String(input), collectionUrl(env.COMMUTEGUARD_PRODUCTION_URL));
    const headers = new Headers(init?.headers);
    return headers.get('Authorization') === `Bearer ${env.COMMUTEGUARD_CRON_SECRET}` ? Response.json({ collected: false, reason: 'OUTSIDE_COLLECTION_WINDOW' }) : Response.json({ reason: 'UNAUTHORIZED' }, { status: 401 });
  };
  const result = await productionSmoke(env, fake, now);
  assert.equal(calls, 4); assert.equal(result.productionSmoke, 'PASS'); assert.equal(result.insideCollectionWindow, false); assert.equal(result.backend, 'SUPABASE');
  for (const key of [env.MTA_BUS_TIME_API_KEY, env.SUPABASE_SECRET_KEY, env.COMMUTEGUARD_CRON_SECRET]) assert.ok(!JSON.stringify(result).includes(key));
});
test('production smoke refuses absent/invalid configuration before any request', async () => {
  let calls = 0;
  await assert.rejects(() => productionSmoke({ ...env, COMMUTEGUARD_PRODUCTION_URL: undefined }, async () => { calls++; throw Error(); }, now));
  assert.equal(calls, 0);
});
test('production smoke rejects a platform login/redirect/auth failure rather than treating it as an operational endpoint', async () => {
  await assert.rejects(() => productionSmoke(env, async () => new Response('private internals', { status: 302 }), now), /PRODUCTION_AUTH_CHECK_FAILED/);
});
test('client import graph contains no environment readers or privileged storage adapters', async () => {
  const visited = new Set<string>();
  async function visit(path: string) {
    if (visited.has(path)) return; visited.add(path);
    const content = await readFile(path, 'utf8');
    assert.doesNotMatch(content, /process\.env|node:fs|createHistoryBackend|SUPABASE_SECRET_KEY|COMMUTEGUARD_CRON_SECRET/);
    for (const match of content.matchAll(/from ['"](\.[^'"]+)['"]/g)) {
      const base = resolve(dirname(path), match[1]!); let found = false;
      for (const candidate of [base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx')]) try { await readFile(candidate); await visit(candidate); found = true; break; } catch (e) { if ((e as { code?: string }).code !== 'ENOENT') throw e; }
      assert.equal(found, true);
    }
  }
  await visit(resolve('src/components/commute-screen.tsx'));
  assert.ok(visited.size > 3);
});
test('deployment config excludes secret files and declares Next.js/frozen install; no extra hosting cron', async () => {
  const config = JSON.parse(await readFile('vercel.json', 'utf8'));
  assert.equal(config.framework, 'nextjs'); assert.equal(config.installCommand, 'pnpm install --frozen-lockfile'); assert.equal(config.crons, undefined);
  assert.match(await readFile('.vercelignore','utf8'), /^\.env\*$/m);
  for (const file of ['src/app/api/commute/route.ts','src/app/api/internal/commute/collect/route.ts']) assert.match(await readFile(file, 'utf8'), /export const maxDuration = 60/);
});
test('snapshot expiry respects existing vehicle age, source validity and never extends the server deadline', async () => {
  const d = await decision();
  assert.equal(d.primaryLeg.status, 'VERIFIED');
  assert.equal(Date.parse(d.displayExpiresAt!), Date.parse(time(121))); // source validUntil on the latest frame
  assert.equal(decisionDisplayDeadline(d), Date.parse(time(121)));
  assert.equal(observationDisplayDeadline(now, 85), Date.parse(now)+5000);
  assert.equal(observationDisplayDeadline(now, 120), Date.parse(now));
  assert.equal(observationDisplayDeadline(now, 9, [], 10), Date.parse(now)+1000);
  assert.equal(decisionDisplayDeadline({ ...d, displayExpiresAt: time(63) }), Date.parse(time(63)));
});
test('transport rejects contradictory positive recommendation or unhealthy VERIFIED', async () => {
  const d = await decision();
  assert.equal(isDecision(d), true);
  assert.equal(isDecision({ ...d, recommendation: { action: 'BACKUP_ROUTE', label: 'Backup' } }), false);
  assert.equal(isDecision({ ...d, dataHealth: { ...d.dataHealth, status: 'UNAVAILABLE' } }), false);
  assert.equal(isDecision({ ...d, displayExpiresAt: 'bad' }), false);
});
test('phone tab expires a VERIFIED snapshot without polling and removes the normal-route recommendation', async t => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://offline.example/' });
  const previous = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const d = await decision(); const initial = Date.parse(d.evaluatedAt);
  t.mock.timers.enable({ apis: ['Date','setTimeout'], now: initial });
  let requests = 0; globalThis.fetch = async () => { requests++; return Response.json(d); };
  const root = createRoot(document.getElementById('root')!);
  try {
    await act(async () => root.render(<CommuteScreen />));
    assert.match(document.body.textContent!, /Use the normal Bx28 route/);
    await act(async () => t.mock.timers.tick(Date.parse(d.displayExpiresAt!) - initial + 1));
    assert.equal(requests, 1); assert.match(document.body.textContent!, /This check has expired/); assert.match(document.body.textContent!, /UNVERIFIED|Walk to the D train/); assert.doesNotMatch(document.body.textContent!, /Use the normal Bx28 route/);
  } finally { await act(async () => root.unmount()); t.mock.timers.reset(); Object.assign(globalThis, previous); dom.window.close(); }
});
test('generic Bx10 terminal regression remains separate from active intermediate Bx28', () => { assert.equal(commuteConfiguration.route, 'Bx10'); assert.equal(commuteConfiguration.target.isOrigin, true); assert.equal(DEFAULT_COMMUTE.route, 'Bx28'); assert.equal(DEFAULT_COMMUTE.target.isOrigin, false); });

test('cron body limit is enforced on bytes even without a Content-Length header', async () => {
  const { createCollectorHandler } = await import('../src/server/collector-handler.js');
  let calls = 0;
  const handler = createCollectorHandler(() => env.COMMUTEGUARD_CRON_SECRET, async () => { calls++; throw Error(); });
  const response = await handler(new Request('https://offline.example/api/internal/commute/collect', { method: 'POST', headers: { Authorization: `Bearer ${env.COMMUTEGUARD_CRON_SECRET}` }, body: JSON.stringify({ scheduledAt: now, padding: 'a'.repeat(512) }) }));
  assert.equal(response.status, 400); assert.equal(calls, 0); assert.match(await response.text(), /INVALID_REQUEST/);
});

test('a slow phone clock cannot keep VERIFIED beyond the server freshness budget', async t => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://offline.example/' });
  const previous = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const d = await decision();
  t.mock.timers.enable({ apis: ['Date','setTimeout'], now: Date.parse(d.evaluatedAt) - 3600000 });
  let elapsed = 0; t.mock.method(performance, 'now', () => elapsed);
  let requests = 0; globalThis.fetch = async () => { requests++; return Response.json(d); };
  const root = createRoot(document.getElementById('root')!);
  try {
    await act(async () => root.render(<CommuteScreen />));
    assert.match(document.body.textContent!, /Use the normal Bx28 route/);
    elapsed = 60000; await act(async () => t.mock.timers.tick(60000));
    assert.equal(requests, 1); assert.match(document.body.textContent!, /This check has expired/); assert.doesNotMatch(document.body.textContent!, /Use the normal Bx28 route/);
  } finally { await act(async () => root.unmount()); t.mock.timers.reset(); t.mock.restoreAll(); Object.assign(globalThis, previous); dom.window.close(); }
});
