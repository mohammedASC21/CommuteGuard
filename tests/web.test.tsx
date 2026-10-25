import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { DecisionCard, CommuteScreen, checkedTime, isDecision } from '../src/components/commute-screen.js';
import { createCommuteHandler } from '../src/server/commute-handler.js';
import { CommuteDecisionService, InMemoryObservationHistory, recommendationFor } from '../src/lib/commute/index.js';
import type { CommuteDecision } from '../src/lib/commute/types.js';
import { frames, time } from './fixtures/reliability/current-trip.js';
import { commuteConfiguration as DEFAULT_COMMUTE } from './fixtures/reliability/current-trip.js';

async function fixture(): Promise<CommuteDecision> {
  const service = legacyService({ history: new InMemoryObservationHistory(), clock: () => time(122) });
  for (const frame of frames()) await service.ingest(frame);
  return service.assess();
}
function html(decision: CommuteDecision) { return renderToStaticMarkup(<DecisionCard decision={decision} />); }
for (const status of ['VERIFIED', 'UNVERIFIED', 'HIGH_GHOST_RISK'] as const) {
  test(`web: ${status} displays service recommendation`, async () => {
    const decision = await fixture();
    decision.primaryLeg.status = status;
    decision.recommendation = recommendationFor(status, DEFAULT_COMMUTE);
    const output = html(decision);
    assert.ok(output.includes(status.replaceAll('_', ' ')));
    assert.ok(output.includes(decision.recommendation.label));
    if (status === 'HIGH_GHOST_RISK') assert.match(output, /not an official MTA designation/);
  });
}
test('web: degraded health is separate from transit diagnosis', async () => {
  const d = await fixture(); d.primaryLeg.status = 'UNVERIFIED'; d.recommendation = recommendationFor('UNVERIFIED', DEFAULT_COMMUTE); d.dataHealth.status = 'DEGRADED';
  assert.match(html(d), /Realtime data is currently incomplete/);
  assert.doesNotMatch(html(d), /Ghost|ghost/);
});
test('web: unavailable service decision remains backup-oriented', async () => {
  const service = legacyService({ history: new InMemoryObservationHistory(), clock: () => time(2) });
  const d = await service.assess();
  assert.equal(d.dataHealth.status, 'UNAVAILABLE');
  assert.match(html(d), /Walk to the D train/);
  assert.match(html(d), /currently unavailable/);
});
test('web: previous trip and other reasons are understandable and optional', async () => {
  const d = await fixture(); d.primaryLeg.reasonCodes = ['PREVIOUS_TRIP', 'INSUFFICIENT_OBSERVATIONS', 'LAYOVER', 'STALE_OBSERVATIONS'];
  const output = html(d);
  assert.match(output, /<details>/); assert.match(output, /associated with its previous trip/);
  assert.match(output, /not enough distinct/); assert.match(output, /source-indicated layover/); assert.match(output, /too old/);
  assert.doesNotMatch(output, /PREVIOUS_TRIP/);
});
test('web: authoritative timestamp rendered in New York including DST', async () => {
  assert.equal(checkedTime('2026-10-20T18:28:00Z'), '2:28 PM');
  assert.equal(checkedTime('2026-12-20T18:28:00Z'), '1:28 PM');
  const d = await fixture(); assert.match(html(d), /8:02 AM/); assert.match(html(d), /New York time/);
});
test('web: rejects incomplete or invalid transport payloads', async () => {
  assert.equal(isDecision({}), false); assert.equal(isDecision(null), false);
  const d = await fixture(); assert.equal(isDecision(d), true);
  assert.equal(isDecision({ ...d, evaluatedAt: 'bad' }), false);
});
test('API: ingests and assesses actual Phase 3 service, uncached typed DTO', async () => {
  const history = new InMemoryObservationHistory();
  const saved = frames();
  for (const frame of saved.slice(0, 4)) await history.add(frame);
  const service = legacyService({ history, clock: () => time(122), source: {
    vehicleMonitoring: async () => saved[4]!.vm!, stopMonitoring: async () => saved[4]!.sm!,
  } });
  const response = await createCommuteHandler(() => service)();
  assert.equal(response.status, 200); assert.match(response.headers.get('Cache-Control')!, /no-store/);
  const d = await response.json() as CommuteDecision;
  assert.equal(d.primaryLeg.status, 'VERIFIED'); assert.equal(d.recommendation.action, 'NORMAL_ROUTE');
  assert.equal(d.primaryLeg.evidence.framesRetained, 5);
});
test('API: exception containing credential/URL is sanitized', async () => {
  const credential = 'FAKE_PRIVATE_CREDENTIAL';
  const response = await createCommuteHandler(() => { throw new Error(`https://example.invalid/?key=${credential}`); })();
  assert.equal(response.status, 503); const body = await response.text();
  assert.doesNotMatch(body, /FAKE_PRIVATE|https|stack|key=/); assert.match(body, /COMMUTE_UNAVAILABLE/);
});
test('API: defensively redacts credential even from successful DTO strings', async () => {
  const d = await fixture(); d.primaryLeg.summary = 'FAKE_PRIVATE_CREDENTIAL';
  const response = await createCommuteHandler(() => ({ ingestLive: async () => ({ stored: true, vehicleMonitoring: 'SUCCEEDED', stopMonitoring: 'SUCCEEDED', vehicleObservationCount: 1, stopObservationCount: 1 }), assess: async () => d }), () => 'FAKE_PRIVATE_CREDENTIAL')();
  assert.doesNotMatch(await response.text(), /FAKE_PRIVATE_CREDENTIAL/);
});
test('API: failure after a successful normal recommendation does not reuse it', async () => {
  let fail = false;
  const service = legacyService({ history: new InMemoryObservationHistory(), clock: () => time(fail ? 152 : 122), source: {
    vehicleMonitoring: async () => { if (fail) throw Error('private'); return frames()[4]!.vm!; },
    stopMonitoring: async () => { if (fail) throw Error('private'); return frames()[4]!.sm!; },
  } });
  for (const frame of frames().slice(0,4)) await service.ingest(frame);
  const handler = createCommuteHandler(() => service);
  assert.equal(((await (await handler()).json()) as CommuteDecision).recommendation.action, 'NORMAL_ROUTE');
  fail = true;
  const d = await (await handler()).json() as CommuteDecision;
  assert.equal(d.primaryLeg.status, 'UNVERIFIED'); assert.equal(d.recommendation.action, 'BACKUP_ROUTE');
});
test('web: initial loading, manual refresh, duplicate prevention, failure and retry', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const previous = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  let resolve!: (value: Response) => void; let requests = 0;
  globalThis.fetch = async () => { requests++; return new Promise<Response>(r => { resolve = r; }); };
  const root = createRoot(document.getElementById('root')!);
  try {
    await act(async () => root.render(<CommuteScreen />));
    assert.match(document.body.textContent!, /Checking your Bx28/);
    assert.doesNotMatch(document.body.textContent!, /VERIFIED/);
    assert.equal(document.querySelector('button')!.disabled, true);
    const d = await fixture();
    // This interaction test displays a current snapshot; historical engine fixtures remain unchanged.
    d.evaluatedAt = new Date().toISOString(); d.displayExpiresAt = new Date(Date.now() + 60000).toISOString(); d.primaryLeg.ageSeconds = 0;
    await act(async () => resolve(Response.json(d)));
    assert.match(document.body.textContent!, /Use the normal Bx10 route/);
    await act(async () => { document.querySelector('button')!.click(); document.querySelector('button')!.click(); });
    assert.equal(requests, 2); assert.doesNotMatch(document.body.textContent!, /VERIFIED|Use the normal/);
    await act(async () => resolve(new Response('private server internals', { status: 503 })));
    assert.match(document.body.textContent!, /Walk to the D train/); assert.match(document.body.textContent!, /Try again/);
    assert.doesNotMatch(document.body.textContent!, /VERIFIED|private server internals/);
    await act(async () => document.querySelector('button')!.click());
    await act(async () => resolve(Response.json(d)));
    assert.equal(requests, 3); assert.match(document.body.textContent!, /Check again/);
  } finally { await act(async () => root.unmount()); Object.assign(globalThis, previous); dom.window.close(); }
});

function legacyService(options: ConstructorParameters<typeof CommuteDecisionService>[0]) {
  return new CommuteDecisionService({ config: DEFAULT_COMMUTE, ...options });
}

test('active Bx28 decision card uses the confirmed boarding stop and D train backup', async () => {
  const service = new CommuteDecisionService({ history: new InMemoryObservationHistory(), clock: () => time(2) });
  const output = html(await service.assess());
  assert.match(output, /Bx28/); assert.match(output, /BAINBRIDGE AV\/E 206 ST/); assert.match(output, /Walk to the D train/);
  assert.doesNotMatch(output, /Bx10|RIVERDALE|Your stop starts the route/);
});

for (const nextStatus of ['VERIFIED', 'UNVERIFIED'] as const) {
  test(`web: expired VERIFIED refreshes to current ${nextStatus}; old callbacks cannot expire replacement`, async () => {
    const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
    const previous = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
    const originalNow = Date.now;
    let now = originalNow();
    const callbacks: Array<() => void> = [];
    Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
    Date.now = () => now;
    globalThis.setTimeout = ((callback: () => void) => { callbacks.push(callback); return callbacks.length; }) as unknown as typeof setTimeout;
    globalThis.clearTimeout = (() => {}) as typeof clearTimeout;
    let resolve!: (value: Response) => void;
    let requests = 0;
    globalThis.fetch = async (url, options) => {
      assert.equal(url, '/api/commute'); assert.equal(options?.cache, 'no-store');
      requests++; return new Promise<Response>(r => { resolve = r; });
    };
    const root = createRoot(document.getElementById('root')!);
    try {
      const a = await fixture();
      a.primaryLeg.route = 'Bx28'; a.recommendation.label = 'Use the normal Bx28 route.';
      a.evaluatedAt = new Date(now).toISOString(); a.primaryLeg.ageSeconds = 0;
      a.displayExpiresAt = new Date(now + 1000).toISOString();
      await act(async () => root.render(<CommuteScreen />));
      await act(async () => resolve(Response.json(a)));
      assert.match(document.body.textContent!, /Use the normal Bx28 route/);
      const oldTimer = callbacks.at(-1)!;
      now += 1001;
      await act(async () => oldTimer());
      assert.match(document.body.textContent!, /This check has expired/);
      await act(async () => document.querySelector('button')!.click());
      assert.equal(requests, 2);
      const b = structuredClone(a);
      b.evaluatedAt = new Date(now).toISOString(); b.primaryLeg.status = nextStatus;
      b.recommendation = { action: nextStatus === 'VERIFIED' ? 'NORMAL_ROUTE' : 'BACKUP_ROUTE', label: nextStatus === 'VERIFIED' ? 'Use the normal Bx28 route.' : 'Walk to the D train.' };
      // A freshly evaluated negative assessment can legitimately describe stale evidence.
      b.primaryLeg.ageSeconds = nextStatus === 'UNVERIFIED' ? 200 : 0;
      b.displayExpiresAt = new Date(now + (nextStatus === 'UNVERIFIED' ? -1000 : 60000)).toISOString();
      await act(async () => resolve(Response.json(b)));
      await act(async () => oldTimer()); // deliberately deliver an already cleared callback
      assert.doesNotMatch(document.body.textContent!, /This check has expired/);
      assert.equal(document.querySelector('time')!.dateTime, b.evaluatedAt);
      assert.match(document.body.textContent!, nextStatus === 'VERIFIED' ? /Use the normal Bx28 route/ : /Walk to the D train/);
      assert.match(document.body.textContent!, new RegExp(nextStatus));
      const replacementTimer = callbacks.at(-1)!;
      now += 90001;
      await act(async () => replacementTimer());
      assert.match(document.body.textContent!, /This check has expired/);
    } finally {
      await act(async () => root.unmount()); Date.now = originalNow;
      Object.assign(globalThis, previous); dom.window.close();
    }
  });
}
