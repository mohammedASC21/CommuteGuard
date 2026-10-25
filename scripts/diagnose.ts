import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { fetchBusRoute } from '../src/mta/client.js';
import { DEFAULT_COMMUTE } from '../src/lib/commute/types.js';
import { parseSiri } from '../src/mta/siri.js';

function redact(value: string): string {
  const key = process.env.MTA_BUS_TIME_API_KEY;
  return key ? value.replaceAll(key, '[REDACTED]').replaceAll(encodeURIComponent(key), '[REDACTED]') : value;
}

async function main() {
  const { values } = parseArgs({ options: { route: { type: 'string' }, fixture: { type: 'string' }, stop: { type: 'string' }, direction: { type: 'string' } }, strict: true });
  const stopId = values.stop ?? (process.env.MTA_STOP_ID || undefined);
  const directionId = values.direction ?? (process.env.MTA_DIRECTION_ID || undefined);
  const batch = values.fixture
    ? parseSiri(JSON.parse(await readFile(values.fixture, 'utf8')) as unknown, stopId ? 'stop' : 'vehicle')
    : await fetchBusRoute({ routeId: values.route ?? DEFAULT_COMMUTE.target.routeId, apiKey: process.env.MTA_BUS_TIME_API_KEY ?? '', stopId, directionId });
  console.log(redact(JSON.stringify({
    mode: values.fixture ? 'OFFLINE_FIXTURE_NOT_LIVE' : 'LIVE',
    fetchedAt: new Date().toISOString(),
    note: 'Candidates only. Positions/state may be inferred; expected times are predictions. staticAssignment and call staticReference are schedule/reference data. No reliability decision.',
    ...batch,
  }, null, 2)));
}
main().catch((error: unknown) => {
  console.error(redact(error instanceof Error ? error.message : 'DIAGNOSTIC_FAILED'));
  process.exitCode = 1;
});
