import type { ReliabilityFrame } from '../reliability/index.js';
import type { ObservationHistoryStore } from './types.js';

export interface HistoryPolicy { historyWindowSeconds: number; maximumFrames: number; maximumObservationsPerEndpoint: number }
/** Development bounds, not calibrated transit thresholds. One frame is one paired acquisition. */
export const PROVISIONAL_HISTORY_POLICY: Readonly<HistoryPolicy> = Object.freeze({ historyWindowSeconds: 600, maximumFrames: 40, maximumObservationsPerEndpoint: 64 });
export class InMemoryObservationHistory implements ObservationHistoryStore {
  private frames: ReliabilityFrame[] = [];
  private readonly policy: HistoryPolicy;
  constructor(policy: Readonly<HistoryPolicy> = PROVISIONAL_HISTORY_POLICY) {
    if (!Number.isFinite(policy.historyWindowSeconds) || policy.historyWindowSeconds <= 0 || !Number.isInteger(policy.maximumFrames) || policy.maximumFrames < 1 || !Number.isInteger(policy.maximumObservationsPerEndpoint) || policy.maximumObservationsPerEndpoint < 1) throw new Error('INVALID_HISTORY_POLICY');
    this.policy = { historyWindowSeconds: policy.historyWindowSeconds, maximumFrames: policy.maximumFrames, maximumObservationsPerEndpoint: policy.maximumObservationsPerEndpoint };
  }
  private prune(at: number) {
    this.frames = this.frames.filter(f => Date.parse(f.completedAt) >= at - this.policy.historyWindowSeconds * 1000).slice(-this.policy.maximumFrames);
  }
  async add(frame: ReliabilityFrame): Promise<void> {
    const at = Date.parse(frame.completedAt);
    const latest = this.frames.at(-1);
    if (!Number.isFinite(at)) throw new Error('NON_INCREASING_HISTORY_TIME');
    // Clone only normalized frame fields. Repeated source times remain visible to the engine.
    const copy: ReliabilityFrame = structuredClone({ acquisitionId: frame.acquisitionId, completedAt: frame.completedAt, vm: frame.vm, sm: frame.sm, errors: frame.errors?.length ? [...new Set(frame.errors.map(e => e === 'HISTORY_GAP' ? 'HISTORY_GAP' : 'ACQUISITION_FAILURE'))] : [] });
    const existing = frame.acquisitionId ? this.frames.find(f => f.acquisitionId === frame.acquisitionId) : undefined;
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(copy)) throw new Error('ACQUISITION_CONFLICT');
      return;
    }
    if (latest && at <= Date.parse(latest.completedAt)) throw new Error('NON_INCREASING_HISTORY_TIME');
    for (const endpoint of ['vm', 'sm'] as const) {
      const batch = copy[endpoint];
      if (batch && batch.observations.length > this.policy.maximumObservationsPerEndpoint) {
        batch.observations = batch.observations.slice(0, this.policy.maximumObservationsPerEndpoint);
        batch.issues = [...batch.issues, 'HISTORY_CAPACITY_EXCEEDED'];
      }
    }
    this.frames.push(copy);
    this.prune(at);
  }
  async getRecent(evaluatedAt: string): Promise<readonly ReliabilityFrame[]> {
    const at = Date.parse(evaluatedAt);
    if (!Number.isFinite(at)) throw new Error('INVALID_HISTORY_CLOCK');
    this.prune(at);
    return structuredClone(this.frames);
  }
}
