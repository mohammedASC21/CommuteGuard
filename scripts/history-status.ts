import { DEFAULT_COMMUTE } from '../src/lib/commute/types.js';
import { createHistoryBackend } from '../src/lib/history/backend.js';
const history = createHistoryBackend(process.env);
const activeCommute = { route: DEFAULT_COMMUTE.route, boardingStopId: DEFAULT_COMMUTE.target.stopId, directionId: DEFAULT_COMMUTE.target.directionId, isOrigin: DEFAULT_COMMUTE.target.isOrigin };
try {
  const frames = await history.store.getRecent(new Date().toISOString());
  console.log(JSON.stringify({ backend: history.backend, activeCommute, commuteScope: history.scope, eligibleRecentFrames: frames.length, oldestFrameTimestamp: frames[0]?.completedAt ?? null, newestFrameTimestamp: frames.at(-1)?.completedAt ?? null, connectivity: history.backend === 'SUPABASE' ? 'CONNECTED' : 'PROCESS_LOCAL_ONLY', evidenceWindowSeconds: history.evidenceWindowSeconds }, null, 2));
} catch {
  console.log(JSON.stringify({ backend: history.backend, activeCommute, commuteScope: history.scope, eligibleRecentFrames: null, oldestFrameTimestamp: null, newestFrameTimestamp: null, connectivity: history.backend === 'NOT_CONFIGURED' ? 'NOT_CONFIGURED' : 'FAILED', evidenceWindowSeconds: history.evidenceWindowSeconds }, null, 2));
  process.exitCode = 1;
}
