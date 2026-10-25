import { createHistoryBackend } from '../src/lib/history/backend.js';
import { SupabaseObservationHistory } from '../src/lib/history/supabase-history.js';
import { CommuteDecisionService } from '../src/lib/commute/service.js';
import { PROVISIONAL_POLICY } from '../src/lib/reliability/policy.js';
// Run shortly after the morning website check. Purely administrative, never a collector or scheduler.
try {
  const binding = createHistoryBackend(process.env);
  if (binding.backend !== 'SUPABASE' || !(binding.store instanceof SupabaseObservationHistory)) throw new Error();
  const now = new Date().toISOString();
  const frames = (await binding.store.getRecent(now)).filter(f => Date.parse(f.completedAt) <= Date.parse(now));
  const records = [];
  for (const frame of frames) {
    const prefix = frames.filter(f => Date.parse(f.completedAt) <= Date.parse(frame.completedAt) && Date.parse(f.completedAt) >= Date.parse(frame.completedAt) - PROVISIONAL_POLICY.historyWindowSeconds * 1000);
    const service = new CommuteDecisionService({ history: { add: async () => { throw Error(); }, getRecent: async () => prefix }, clock: () => frame.completedAt });
    const d = await service.assess();
    records.push({ acquisitionId: frame.acquisitionId, completedAt: frame.completedAt, vm: frame.vm ? 'RECEIVED' : 'FAILED', sm: frame.sm ? 'RECEIVED' : 'FAILED', vmIssues: frame.vm?.issues.length ?? null, smIssues: frame.sm?.issues.length ?? null, vehicleId: d.primaryLeg.vehicleId, observationAgeSeconds: d.primaryLeg.ageSeconds, evidence: d.primaryLeg.evidence, status: d.primaryLeg.status, reasonCodes: d.primaryLeg.reasonCodes, recommendation: d.recommendation.action });
  }
  let output = JSON.stringify({ kind: 'BOUNDED_RETROSPECTIVE_DIAGNOSTIC', capturedAt: now, activeCommute: 'BX28 / 103617 / DIRECTION 1', frameLimit: 40, windowSeconds: PROVISIONAL_POLICY.historyWindowSeconds, possiblyTruncated: frames.length === 40, records }, null, 2);
  for (const key of [process.env.MTA_BUS_TIME_API_KEY,process.env.SUPABASE_SECRET_KEY,process.env.SUPABASE_SERVICE_ROLE_KEY,process.env.COMMUTEGUARD_CRON_SECRET].filter((s): s is string => !!s)) for (const variant of [key,encodeURIComponent(key),JSON.stringify(key).slice(1,-1)]) output = output.replaceAll(variant,'[REDACTED]');
  console.log(output);
} catch { console.error('MORNING_REPORT_UNAVAILABLE: sensitive details omitted.'); process.exitCode = 1; }
