import { createHash, randomUUID } from 'node:crypto';
import { CommuteDecisionService } from '../commute/service.js';
import type { CommuteObservationSource, ObservationHistoryStore } from '../commute/types.js';
import type { ReliabilityFrame } from '../reliability/types.js';
import { collectionWindow, type CollectionSchedule } from './schedule.js';
export type CollectionReason = 'COLLECTED' | 'OUTSIDE_COLLECTION_WINDOW' | 'INVALID_SCHEDULE_SLOT' | 'DUPLICATE_ACQUISITION' | 'COLLECTION_IN_PROGRESS' | 'UPSTREAM_PARTIAL_FAILURE' | 'UPSTREAM_FAILURE' | 'UPSTREAM_ISSUES' | 'STORAGE_FAILURE';
export interface CollectionResult { accepted: true; collected: boolean; reason: CollectionReason; acquisitionId?: string }
export interface Claim { status: 'ACQUIRED' | 'DUPLICATE_ACQUISITION' | 'COLLECTION_IN_PROGRESS'; gap: boolean }
export interface ScheduledHistory extends ObservationHistoryStore {
  claimCollection(slot: string, id: string, token: string): Promise<Claim>;
  completeCollection(slot: string, token: string, frame: ReliabilityFrame, result: CollectionReason): Promise<void>;
}
export function scheduledAcquisitionId(scope: string, slot: string): string {
  const hex = createHash('sha256').update(`scheduled:v1:${scope}:${slot}`).digest('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
}
/** One bounded pair, no sleeps or classifier knowledge. Persistent lease fences every commit. */
export async function collectScheduled(deps: { scope: string; history: ScheduledHistory; source: CommuteObservationSource; schedule: CollectionSchedule; clock: () => string }, intendedAt: string): Promise<CollectionResult> {
  const reply = (reason: CollectionReason, collected = false, acquisitionId?: string): CollectionResult => ({ accepted: true, collected, reason, ...(acquisitionId ? { acquisitionId } : {}) });
  try {
    const now = deps.clock();
    if (!collectionWindow(now, deps.schedule).allowed) return reply('OUTSIDE_COLLECTION_WINDOW');
    const slot = collectionWindow(intendedAt, deps.schedule);
    const delay = Date.parse(now) - Date.parse(intendedAt);
    if (!slot.allowed || delay < -5000 || delay > 60000) return reply('INVALID_SCHEDULE_SLOT');
    const id = scheduledAcquisitionId(deps.scope, slot.slot), token = randomUUID();
    const claim = await deps.history.claimCollection(slot.slot, id, token);
    if (claim.status !== 'ACQUIRED') return reply(claim.status, false, id);
    let result: CollectionReason = 'COLLECTED';
    const history: ObservationHistoryStore = {
      getRecent: at => deps.history.getRecent(at),
      add: async frame => {
        const missing = Number(!frame.vm) + Number(!frame.sm);
        result = missing === 2 ? 'UPSTREAM_FAILURE' : missing === 1 ? 'UPSTREAM_PARTIAL_FAILURE' : [frame.vm, frame.sm].some(b => b!.issues.length || b!.observations.some(o => o.issues.length)) ? 'UPSTREAM_ISSUES' : 'COLLECTED';
        await deps.history.completeCollection(slot.slot, token, { ...frame, acquisitionId: id, errors: [...(frame.errors ?? []), ...(claim.gap ? ['HISTORY_GAP'] : [])] }, result);
      },
    };
    const service = new CommuteDecisionService({ history, source: deps.source, clock: deps.clock });
    const ingestion = await service.ingestLive();
    return ingestion.stored ? reply(result, true, id) : reply('STORAGE_FAILURE', false, id);
  } catch { return reply('STORAGE_FAILURE'); }
}
