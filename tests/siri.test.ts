import { gunzipSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fetchBx10, fetchBusRoute } from '../src/mta/client.js';
import { parseSiri } from '../src/mta/siri.js';

// Mutable test-only shape; production JSON always enters the parser as unknown.
interface Fixture {
  Siri: { ServiceDelivery: { ResponseTimestamp: string; VehicleMonitoringDelivery: {
    ResponseTimestamp: string; ValidUntil: string;
    VehicleActivity: { RecordedAtTime?: string; MonitoredVehicleJourney: Record<string, unknown> }[];
  }[] } };
}
const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/siri-vm.synthetic.json', import.meta.url), 'utf8')) as Fixture;
const activity = (f: Fixture) => f.Siri.ServiceDelivery.VehicleMonitoringDelivery[0]!.VehicleActivity[0]!;
const mockFetch = (body: unknown): typeof fetch => async () => Response.json(body);

test('keeps vehicle timestamps, predictions and static references distinct', () => {
  const result = parseSiri(fixture(), 'vehicle');
  const o = result.observations[0]!;
  assert.equal(o.vehicleId, 'MTA NYCT_FIXTURE_VEHICLE');
  assert.equal(o.tripId, 'MTA NYCT_FIXTURE_TRIP');
  assert.equal(o.routeId, 'MTA NYCT_BX10');
  assert.equal(o.latitude, 40.88);
  assert.notEqual(o.timestamp, result.responseTimestamp);
  assert.equal(o.monitoredCall?.realtimePrediction.distanceFromStopMeters, 600);
  assert.equal(o.monitoredCall?.staticReference.stopId, 'MTA_FIXTURE_STOP');
  assert.equal(o.staticAssignment.originScheduledDeparture, undefined);
  assert.deepEqual(o.issues, []);
});

test('old update stays old; response time never substitutes for missing vehicle time', () => {
  const f = fixture();
  activity(f).RecordedAtTime = '2011-01-28T14:22:30-05:00';
  assert.equal(parseSiri(f, 'vehicle').observations[0]!.timestamp, '2011-01-28T14:22:30-05:00');
  delete activity(f).RecordedAtTime;
  const o = parseSiri(f, 'vehicle').observations[0]!;
  assert.equal(o.timestamp, undefined);
  assert.ok(o.issues.includes('MISSING_OR_INVALID_timestamp'));
});

test('malformed coordinates, dates, calls and missing assignment are explicit', () => {
  const f = fixture();
  activity(f).RecordedAtTime = 'not a date';
  activity(f).MonitoredVehicleJourney = { VehicleLocation: { Latitude: 200, Longitude: '0' }, MonitoredCall: { ExpectedArrivalTime: 'bad' }, OnwardCalls: { OnwardCall: {} } };
  const o = parseSiri(f, 'vehicle').observations[0]!;
  assert.equal(o.latitude, undefined);
  assert.equal(o.longitude, undefined);
  assert.ok(o.issues.includes('MISSING_OR_INVALID_tripId'));
  assert.ok(o.issues.includes('INVALID_ExpectedArrivalTime'));
  assert.ok(o.issues.includes('INVALID_ONWARD_CALLS'));
});

test('handles empty deliveries and rejects malformed/error envelopes', () => {
  const f = fixture();
  f.Siri.ServiceDelivery.VehicleMonitoringDelivery[0]!.VehicleActivity = [];
  assert.ok(parseSiri(f, 'vehicle').issues.includes('NO_CANDIDATES'));
  for (const raw of [null, {}, { Siri: { ServiceDelivery: { Status: false } } }, { Siri: { ServiceDelivery: { VehicleMonitoringDelivery: [{ ErrorCondition: { Description: 'secret' } }] } } }]) {
    assert.throws(() => parseSiri(raw, 'vehicle'), /MTA_/);
  }
});

test('SM preserves prevTrip/layover and differs from VM without merging trips', () => {
  const f = fixture();
  const a = activity(f);
  a.MonitoredVehicleJourney.ProgressStatus = 'prevTrip layover';
  a.MonitoredVehicleJourney.FramedVehicleJourneyRef = { DataFrameRef: '2026-10-20', DatedVehicleJourneyRef: 'NEXT_TRIP' };
  const batch = parseSiri({ Siri: { ServiceDelivery: { ResponseTimestamp: f.Siri.ServiceDelivery.ResponseTimestamp, StopMonitoringDelivery: [{ MonitoredStopVisit: [a] }] } } }, 'stop');
  assert.equal(batch.observations[0]!.context, 'stop');
  assert.equal(batch.observations[0]!.progressStatus, 'prevTrip layover');
  assert.equal(batch.observations[0]!.tripId, 'NEXT_TRIP');
});

test('client uses official filtered v2 endpoint and flags conflicting route', async () => {
  const f = fixture();
  activity(f).MonitoredVehicleJourney.LineRef = 'MTA NYCT_BX9';
  const batch = await fetchBx10({ apiKey: 'test-only', directionId: '0' }, async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://bustime-classic.mta.info');
    assert.equal(url.searchParams.get('LineRef'), 'MTA NYCT_BX10');
    assert.equal(url.searchParams.get('version'), '2');
    assert.equal(url.searchParams.get('DirectionRef'), '0');
    assert.equal(init?.redirect, 'error');
    return Response.json(f);
  });
  assert.ok(batch.observations[0]!.issues.includes('ROUTE_FILTER_MISMATCH'));
  assert.ok(batch.observations[0]!.issues.includes('DIRECTION_FILTER_MISMATCH'));
});

test('SM requests target stop and flags a conflicting monitored stop', async () => {
  const f = fixture();
  const batch = await fetchBx10({ apiKey: 'test-only', stopId: '123456' }, async input => {
    const url = new URL(String(input));
    assert.equal(url.pathname, '/api/siri/stop-monitoring.json');
    assert.equal(url.searchParams.get('MonitoringRef'), '123456');
    assert.equal(url.searchParams.get('OperatorRef'), 'MTA');
    assert.equal(url.searchParams.get('StopMonitoringDetailLevel'), 'calls');
    return Response.json({ Siri: { ServiceDelivery: { StopMonitoringDelivery: [{ MonitoredStopVisit: [activity(f)] }] } } });
  });
  assert.ok(batch.observations[0]!.issues.includes('STOP_FILTER_MISMATCH'));
});

test('missing key and invalid configuration never invoke network', async () => {
  const noNetwork: typeof fetch = async () => { assert.fail('unexpected network'); };
  await assert.rejects(fetchBx10({ apiKey: '' }, noNetwork), /API_KEY/);
  await assert.rejects(fetchBx10({ apiKey: 'test-only', stopId: 'bad' }, noNetwork), /numeric/);
  await assert.rejects(fetchBx10({ apiKey: 'test-only', directionId: '2' }, noNetwork), /0 or 1/);
});

test('errors do not leak URLs, keys or upstream descriptions', async () => {
  await assert.rejects(fetchBx10({ apiKey: 'SECRET' }, async () => { throw new Error('https://example?key=SECRET'); }), { message: 'MTA_REQUEST_FAILED (network, timeout, or redirect)' });
  await assert.rejects(fetchBx10({ apiKey: 'SECRET' }, async () => new Response('SECRET', { status: 403 })), { message: 'MTA_HTTP_ERROR 403' });
  await assert.rejects(fetchBx10({ apiKey: 'SECRET' }, async () => new Response('SECRET')), { message: 'MTA_INVALID_JSON' });
  await assert.rejects(fetchBx10({ apiKey: 'SECRET' }, mockFetch({ Siri: { ServiceDelivery: { ErrorCondition: 'SECRET' } } })), { message: 'MTA_SERVICE_ERROR' });
});

test('captured official v2 VM response preserves array labels and v2 distances', () => {
  const raw = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/bx10-vm-v2.sanitized.json.gz', import.meta.url))).toString('utf8')) as unknown;
  const batch = parseSiri(raw, 'vehicle');
  assert.equal(batch.observations.length, 13);
  const o = batch.observations.find(v => v.vehicleId === 'MTA NYCT_8681')!;
  assert.ok(o.staticAssignment.destinationName);
  assert.equal(o.monitoredCall?.staticReference.stopName, 'RIVERDALE AV/W 263 ST');
  assert.equal(o.monitoredCall?.realtimePrediction.distanceFromStopMeters, 4);
  assert.equal(o.monitoredCall?.realtimePrediction.stopsFromCall, 0);
  assert.ok(o.monitoredCall?.staticReference.scheduledArrival);
});

test('captured SM response retains combined previous-trip and layover flags', () => {
  const raw = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/bx10-sm-v2.sanitized.json.gz', import.meta.url))).toString('utf8')) as unknown;
  const batch = parseSiri(raw, 'stop');
  assert.equal(batch.observations.length, 5);
  assert.equal(batch.observations[0]!.progressStatus, 'layover,prevTrip');
  assert.ok(batch.observations.every(o => o.progressStatus?.includes('prevTrip')));
  assert.ok(batch.observations.every(o => o.monitoredCall?.staticReference.stopId === 'MTA_100607'));
});

test('conflicting distance representations do not silently choose a value', () => {
  const f = fixture();
  activity(f).MonitoredVehicleJourney.MonitoredCall = {
    StopPointRef: 'MTA_TEST', DistanceFromStop: 100,
    Extensions: { Distances: { DistanceFromCall: 200 } },
  };
  const o = parseSiri(f, 'vehicle').observations[0]!;
  assert.equal(o.monitoredCall?.realtimePrediction.distanceFromStopMeters, undefined);
  assert.ok(o.issues.includes('CONFLICTING_DistanceFromStop'));
});

test('malformed v2 label arrays are explicit', () => {
  const f = fixture();
  activity(f).MonitoredVehicleJourney.ProgressStatus = ['prevTrip', 42];
  const o = parseSiri(f, 'vehicle').observations[0]!;
  assert.equal(o.progressStatus, undefined);
  assert.ok(o.issues.includes('INVALID_ProgressStatus'));
});

test('historical Bx10 discovery resolves its boarding-to-alighting direction', () => {
  const raw = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/bx10-stops.sanitized.json.gz', import.meta.url))).toString('utf8')) as {
    code: number; data: { references: { stops: { id: string; name: string }[] }; entry: { stopGroupings: { stopGroups: { id: string; name: { name: string }; stopIds: string[] }[] }[] } };
  };
  assert.equal(raw.code, 200);
  assert.equal(raw.data.references.stops.find(s => s.id === 'MTA_103620')?.name, 'E 206 ST/ROCHAMBEAU AV');
  const directions = raw.data.entry.stopGroupings.flatMap(g => g.stopGroups);
  const towardCollege = directions.find(g => g.id === '0')!;
  assert.equal(towardCollege.name.name, 'RIVERDALE 263 ST');
  assert.equal(towardCollege.stopIds[0], 'MTA_103620');
  assert.ok(towardCollege.stopIds.indexOf('MTA_103449') > towardCollege.stopIds.indexOf('MTA_103620'));
  assert.ok(!towardCollege.stopIds.includes('MTA_100080'));
  assert.ok(directions.find(g => g.id === '1')!.stopIds.includes('MTA_100080'));
});

test('historical Bx10 origin uses direction zero while prevTrip VM can be direction one', () => {
  const readCapture = (mode: string): unknown => JSON.parse(gunzipSync(readFileSync(new URL(`./fixtures/siri-${mode}-commute.sanitized.json.gz`, import.meta.url))).toString('utf8')) as unknown;
  const vm = parseSiri(readCapture('vm'), 'vehicle');
  const sm = parseSiri(readCapture('sm'), 'stop');
  assert.equal(sm.observations.length, 4);
  assert.ok(sm.observations.every(o => o.monitoredCall?.staticReference.stopId === 'MTA_103620'));
  assert.ok(sm.observations.every(o => o.staticAssignment.directionId === '0'));
  const candidate = sm.observations.find(o => o.vehicleId === 'MTA NYCT_9851')!;
  const current = vm.observations.find(o => o.vehicleId === candidate.vehicleId)!;
  assert.equal(candidate.progressStatus, 'prevTrip');
  assert.equal(current.staticAssignment.directionId, '1');
  assert.notEqual(current.tripId, candidate.tripId);
  assert.equal(current.serviceDate, candidate.serviceDate);
  assert.equal(current.timestamp, candidate.timestamp);
  assert.equal(candidate.monitoredCall?.realtimePrediction.stopsFromCall, 0);
  assert.equal(candidate.monitoredCall?.realtimePrediction.distanceFromStopMeters, 81);
  assert.equal(candidate.staticAssignment.destinationName, 'RIVERDALE 263 ST');
});

 test('route-scoped adapter requests and validates Bx28 without changing legacy Bx10 calls', async () => {
  const f = fixture(); activity(f).MonitoredVehicleJourney.LineRef = 'MTA NYCT_BX28';
  const result = await fetchBusRoute({ apiKey: 'FAKE_TEST_KEY', routeId: 'MTA NYCT_BX28' }, async input => {
    assert.equal(new URL(String(input)).searchParams.get('LineRef'), 'MTA NYCT_BX28');
    return Response.json(f);
  });
  assert.equal(result.observations[0]!.routeId, 'MTA NYCT_BX28');
  assert.ok(!result.observations[0]!.issues.includes('ROUTE_FILTER_MISMATCH'));
  const mismatch = await fetchBusRoute({ apiKey: 'FAKE_TEST_KEY', routeId: 'MTA NYCT_BX10' }, mockFetch(f));
  assert.ok(mismatch.observations[0]!.issues.includes('ROUTE_FILTER_MISMATCH'));
});
