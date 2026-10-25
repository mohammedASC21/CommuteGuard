import { parseArgs } from 'node:util';
import { setTimeout } from 'node:timers/promises';
import { CommuteDecisionService, createMtaCommuteSource, DEFAULT_COMMUTE } from '../src/lib/commute/index.js';
import { createHistoryBackend } from '../src/lib/history/backend.js';
import { PROVISIONAL_POLICY } from '../src/lib/reliability/index.js';

async function main() {
  const minimumSamples = Math.max(PROVISIONAL_POLICY.minimumDistinctObservations, PROVISIONAL_POLICY.minimumStableAssignmentObservations, DEFAULT_COMMUTE.target.isOrigin ? PROVISIONAL_POLICY.originMinimumStableAssignmentObservations : PROVISIONAL_POLICY.minimumStableAssignmentObservations, PROVISIONAL_POLICY.minimumProgressingObservations + 1);
  const { values } = parseArgs({ options: { observe: { type: 'boolean', default: false }, samples: { type: 'string', default: String(minimumSamples) }, 'interval-seconds': { type: 'string', default: '30' } } });
  const count = values.observe ? Number(values.samples) : 1;
  const interval = Number(values['interval-seconds']);
  if (!Number.isInteger(count) || count < (values.observe ? minimumSamples : 1) || count > 20 || !Number.isFinite(interval) || interval < 30 || interval > 300) throw new Error('INVALID_DEVELOPMENT_COLLECTION_OPTIONS');
  const key = process.env.MTA_BUS_TIME_API_KEY ?? '';
  const configuredStopId = DEFAULT_COMMUTE.target.stopId.replace(/^MTA_/, '');
  const configuredDirectionId = DEFAULT_COMMUTE.target.directionId;
  const stopId = process.env.MTA_STOP_ID || configuredStopId;
  const directionId = process.env.MTA_DIRECTION_ID || configuredDirectionId;
  // Do not silently apply the confirmed stop name/origin context to an unverified override.
  if (stopId !== configuredStopId || directionId !== configuredDirectionId) throw new Error('UNVERIFIED_COMMUTE_OVERRIDE');
  const source = createMtaCommuteSource({ apiKey: key, stopId, directionId, routeId: DEFAULT_COMMUTE.target.routeId });
  const history = createHistoryBackend(process.env);
  console.log(`History backend: ${history.backend}; scope: ${history.scope}`);
  if (history.backend === 'MEMORY') console.log('Development-only memory: history is not shared across processes.');
  const service = new CommuteDecisionService({ source, history: history.store, clock: () => new Date().toISOString() });
  const secrets = [key, process.env.SUPABASE_SECRET_KEY, process.env.SUPABASE_SERVICE_ROLE_KEY].filter((s): s is string => !!s);
  const log = (message: string) => { for (const secret of secrets) for (const value of [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)]) message = message.replaceAll(value, '[REDACTED]'); console.log(message); };
  for (let index = 0; index < count; index++) {
    if (index > 0) await setTimeout(interval * 1000);
    const ingestion = await service.ingestLive();
    log(`Observation ${index + 1}/${count}: VM ${ingestion.vehicleMonitoring} (${ingestion.vehicleObservationCount}); SM ${ingestion.stopMonitoring} (${ingestion.stopObservationCount}); stored=${ingestion.stored}`);
  }
  const d = await service.assess();
  log(`${DEFAULT_COMMUTE.route} — ${d.primaryLeg.status}`);
  log(`Recommendation: ${d.recommendation.action} — ${d.recommendation.label}`);
  log(d.primaryLeg.summary);
  log(`Data health: ${d.dataHealth.status}; VM=${d.dataHealth.vehicleMonitoring}; SM=${d.dataHealth.stopMonitoring}; history=${d.dataHealth.history}`);
  log(`Reason codes: ${d.primaryLeg.reasonCodes.join(', ')}`);
  log(`History frames=${d.primaryLeg.evidence.framesRetained}; usable distinct=${d.primaryLeg.evidence.distinctCurrentTripObservations}; stable=${d.primaryLeg.evidence.stableAssignmentObservations}; progressing=${d.primaryLeg.evidence.progressingObservations}`);
  log(`Evaluated at: ${d.evaluatedAt}; vehicle=${d.primaryLeg.vehicleId ?? 'none'}; source age seconds=${d.primaryLeg.ageSeconds ?? 'unavailable'}`);
  log(`Source timestamps: VM=${d.primaryLeg.observedAt?.vehicleMonitoring ?? 'unavailable'}; SM=${d.primaryLeg.observedAt?.stopMonitoring ?? 'unavailable'}`);
}
main().catch(() => { console.error('COMMUTE_CHECK_FAILED: configuration or execution unavailable. Sensitive details omitted.'); process.exitCode = 1; });
