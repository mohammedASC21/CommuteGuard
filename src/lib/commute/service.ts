import { assessReliability, PROVISIONAL_POLICY, validatePolicy } from '../reliability/index.js';
import type { ReliabilityAssessment, ReliabilityFrame, ReliabilityPolicy, ReliabilityStatus } from '../reliability/index.js';
import type { ObservationBatch, VehicleObservation } from '../../mta/types.js';
import { DEFAULT_COMMUTE } from './types.js';
import { observationDisplayDeadline } from './presentation.js';
import type { CommuteConfiguration, CommuteDecision, CommuteObservationSource, CommuteReason, EndpointHealth, IngestResult, ObservationHistoryStore } from './types.js';

export function recommendationFor(status: ReliabilityStatus, config: Readonly<CommuteConfiguration> = DEFAULT_COMMUTE): CommuteDecision['recommendation'] {
  return status === 'VERIFIED' ? { action: 'NORMAL_ROUTE', label: `Use the normal ${config.route} route.` } : { action: 'BACKUP_ROUTE', label: config.backupLabel };
}
function endpointHealth(batch: ObservationBatch | undefined, completedAt: string | undefined, evaluatedAt: string, policy: Readonly<ReliabilityPolicy>, context: 'vehicle' | 'stop'): EndpointHealth {
  if (!completedAt) return 'NOT_OBSERVED';
  if (!batch) return 'FAILED';
  const response = Date.parse(batch.responseTimestamp ?? '');
  const complete = Date.parse(completedAt);
  const now = Date.parse(evaluatedAt);
  if (![response, complete, now].every(Number.isFinite) || response > complete + policy.maxFutureSkewSeconds * 1000 || complete > now + policy.maxFutureSkewSeconds * 1000) return 'ISSUES';
  if (batch.source !== 'mta-bus-time-siri' || batch.context !== context || batch.issues.length || batch.observations.some(o => o.issues.length || o.context !== context)) return 'ISSUES';
  for (const delivery of batch.deliveries) if (delivery.validUntil !== undefined) {
    const until = Date.parse(delivery.validUntil);
    if (!Number.isFinite(until)) return 'ISSUES';
    if (until < now) return 'STALE';
  }
  if (now - Math.min(response, complete) > policy.maxObservationAgeSeconds * 1000) return 'STALE';
  return batch.observations.length ? 'OK' : 'EMPTY';
}
export class CommuteDecisionService {
  private readonly config: CommuteConfiguration;
  private readonly policy: Readonly<ReliabilityPolicy>;
  private writeFailed = false;
  private failedAcquisition?: string;
  private readonly acquisitionIds = new WeakMap<ReliabilityFrame, string>();
  private inFlight?: Promise<IngestResult>;
  constructor(private readonly dependencies: { history: ObservationHistoryStore; source?: CommuteObservationSource; clock: () => string; config?: Readonly<CommuteConfiguration>; reliabilityPolicy?: Readonly<ReliabilityPolicy> }) {
    const c = dependencies.config ?? DEFAULT_COMMUTE;
    if (!c.route.trim() || !c.stopName.trim() || !c.backupLabel.trim() || !c.target.routeId.trim() || !c.target.stopId.trim() || !/^[01]$/.test(c.target.directionId)) throw new Error('INVALID_COMMUTE_CONFIGURATION');
    this.config = { route: c.route, stopName: c.stopName, destination: c.destination, destinationId: c.destinationId, alightingStopId: c.alightingStopId, backupLabel: c.backupLabel, target: { routeId: c.target.routeId, stopId: c.target.stopId, directionId: c.target.directionId, isOrigin: c.target.isOrigin } };
    this.policy = { ...(dependencies.reliabilityPolicy ?? PROVISIONAL_POLICY) };
    validatePolicy(this.policy);
  }
  async ingest(frame: ReliabilityFrame): Promise<boolean> {
    const acquisitionId = frame.acquisitionId ?? this.acquisitionIds.get(frame) ?? globalThis.crypto.randomUUID();
    this.acquisitionIds.set(frame, acquisitionId);
    try {
      const errors = this.writeFailed && this.failedAcquisition !== acquisitionId ? [...(frame.errors ?? []), 'HISTORY_GAP'] : frame.errors;
      await this.dependencies.history.add({ ...frame, acquisitionId, errors });
      this.writeFailed = false; this.failedAcquisition = undefined; return true;
    }
    catch { this.writeFailed = true; this.failedAcquisition = acquisitionId; return false; }
  }

  ingestLive(): Promise<IngestResult> {
    // Coalesce concurrent calls in one service instance; each completed pair is one frame.
    if (this.inFlight) return this.inFlight;
    const work = this.collect().catch((): IngestResult => {
      this.writeFailed = true;
      return { stored: false, vehicleMonitoring: 'FAILED', stopMonitoring: 'FAILED', vehicleObservationCount: 0, stopObservationCount: 0 };
    });
    this.inFlight = work;
    void work.finally(() => { this.inFlight = undefined; });
    return work;
  }
  private async collect(): Promise<IngestResult> {
    const source = this.dependencies.source;
    const invoke = (method: 'vehicleMonitoring' | 'stopMonitoring') => Promise.resolve().then(() => {
      if (!source) throw new Error('SOURCE_UNAVAILABLE');
      return source[method]();
    });
    const [vmResult, smResult] = await Promise.allSettled([invoke('vehicleMonitoring'), invoke('stopMonitoring')]);
    const vm = vmResult.status === 'fulfilled' ? vmResult.value : undefined;
    const sm = smResult.status === 'fulfilled' ? smResult.value : undefined;
    const errors: string[] = [];
    if (!vm) errors.push('VM_REQUEST_FAILED');
    if (!sm) errors.push('SM_REQUEST_FAILED');
    let stored = false;
    try { stored = await this.ingest({ completedAt: this.dependencies.clock(), vm, sm, errors }); }
    catch { this.writeFailed = true; }
    return { stored, vehicleMonitoring: vm ? 'SUCCEEDED' : 'FAILED', stopMonitoring: sm ? 'SUCCEEDED' : 'FAILED', vehicleObservationCount: vm?.observations.length ?? 0, stopObservationCount: sm?.observations.length ?? 0 };
  }
  private eligible(o: VehicleObservation) {
    return Boolean((!this.config.destinationId || o.staticAssignment.destinationId === this.config.destinationId) && o.vehicleId && o.routeId === this.config.target.routeId && o.staticAssignment.directionId === this.config.target.directionId && o.monitoredCall?.staticReference.stopId === this.config.target.stopId);
  }
  private select(frames: readonly ReliabilityFrame[]): { vehicleId?: string; currentStopCandidate: boolean } {
    // Select before classification, never by favorable assessment. Historical fallback is diagnostic only.
    for (let index = frames.length - 1; index >= 0; index--) {
      const candidates = frames[index]!.sm?.observations.filter(o => this.eligible(o)) ?? [];
      if (!candidates.length) continue;
      const time = (o: VehicleObservation) => {
        const parsed = Date.parse(o.monitoredCall?.realtimePrediction.expectedArrival ?? '');
        return Number.isFinite(parsed) ? parsed : Infinity;
      };
      const distance = (o: VehicleObservation) => {
        const value = o.monitoredCall?.realtimePrediction.distanceFromStopMeters;
        return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : Infinity;
      };
      candidates.sort((a, b) => (time(a) - time(b) || distance(a) - distance(b) || a.vehicleId!.localeCompare(b.vehicleId!)));
      return { vehicleId: candidates[0]!.vehicleId, currentStopCandidate: index === frames.length - 1 };
    }
    return { currentStopCandidate: false };
  }
  async assess(evaluatedAt?: string): Promise<CommuteDecision> {
    try { evaluatedAt ??= this.dependencies.clock(); } catch { throw new Error('COMMUTE_CLOCK_UNAVAILABLE'); }
    if (!Number.isFinite(Date.parse(evaluatedAt))) throw new Error('INVALID_COMMUTE_CLOCK');
    let frames: readonly ReliabilityFrame[] = [];
    let readFailed = false;
    try { frames = await this.dependencies.history.getRecent(evaluatedAt); }
    catch { readFailed = true; }
    const latest = frames.at(-1);
    const vm = endpointHealth(latest?.vm, latest?.completedAt, evaluatedAt, this.policy, 'vehicle');
    const sm = endpointHealth(latest?.sm, latest?.completedAt, evaluatedAt, this.policy, 'stop');
    const healthReasons: CommuteReason[] = [];
    const historyGap = latest?.errors?.includes('HISTORY_GAP') ?? false;
    if (historyGap) healthReasons.push('HISTORY_GAP');
    if (readFailed || this.writeFailed) healthReasons.push('HISTORY_UNAVAILABLE');
    if ([vm, sm].includes('FAILED') || latest?.errors?.length) healthReasons.push('REQUEST_FAILURE');
    if ([vm, sm].includes('ISSUES')) healthReasons.push('ADAPTER_ISSUE');
    if ([vm, sm].includes('STALE')) healthReasons.push('STALE_DATA');
    const usable = (h: EndpointHealth) => h === 'OK' || h === 'EMPTY';
    const health: CommuteDecision['dataHealth'] = { status: usable(vm) && usable(sm) && !readFailed && !this.writeFailed && !historyGap ? 'HEALTHY' : (usable(vm) || usable(sm)) && !readFailed && !this.writeFailed ? 'DEGRADED' : 'UNAVAILABLE', vehicleMonitoring: vm, stopMonitoring: sm, history: readFailed || this.writeFailed ? 'FAILED' : historyGap ? 'GAP' : 'OK', reasonCodes: healthReasons };
    if (latest?.errors?.length && health.status === 'HEALTHY') health.status = 'DEGRADED';
    const selection = this.select(frames);
    let assessment: ReliabilityAssessment | undefined;
    if (selection.vehicleId) {
      try { assessment = assessReliability({ vehicleId: selection.vehicleId, target: this.config.target, frames, evaluatedAt }, this.policy); }
      catch { health.status = 'UNAVAILABLE'; health.reasonCodes.push('INVALID_HISTORY'); }
    }
    const reasons = new Set<CommuteReason>([...(assessment?.reasonCodes ?? ['NO_REALTIME_CANDIDATE']), ...health.reasonCodes]);
    let status: ReliabilityStatus = assessment?.status ?? 'UNVERIFIED';
    let summary = assessment?.summary ?? `No relevant realtime ${this.config.route} candidate is available for the configured stop.`;
    if (!selection.currentStopCandidate) {
      reasons.add('NO_STOP_CANDIDATE');
      if (status === 'VERIFIED') status = 'UNVERIFIED';
      summary = 'No current stop-specific candidate can be confirmed. Disappearance alone does not establish departure or cancellation.';
    }
    // Acquisition/system failure is failure to verify, never a user-facing ghost-bus diagnosis.
    if (health.status !== 'HEALTHY') {
      status = 'UNVERIFIED'; reasons.add('DATA_UNAVAILABLE');
      summary = `Realtime data unavailable or incomplete. The ${this.config.route} could not be verified.`;
    }
    const evidence = assessment?.evidence;
    const current = evidence?.latest;
    return { primaryLeg: { route: this.config.route, stop: { id: this.config.target.stopId, name: this.config.stopName }, directionId: this.config.target.directionId, destination: this.config.destination,
      status, summary, reasonCodes: [...reasons], vehicleId: selection.vehicleId,
      observedAt: current ? { vehicleMonitoring: current.vmTimestamp, stopMonitoring: current.smTimestamp } : undefined,
      ageSeconds: current?.vehicleAgeSeconds, journey: assessment?.journey,
      evidence: { framesRetained: frames.length, distinctCurrentTripObservations: evidence?.distinctCurrentTripObservations ?? 0, stableAssignmentObservations: evidence?.stableAssignmentObservations ?? 0, progressingObservations: evidence?.progressingObservations ?? 0 } },
      recommendation: recommendationFor(status, this.config), evaluatedAt,
      displayExpiresAt: new Date(observationDisplayDeadline(evaluatedAt, current?.vehicleAgeSeconds, [
        ...(current?.vmValidUntil ?? []), ...(current?.smValidUntil ?? []),
        ...[latest?.completedAt, latest?.vm?.responseTimestamp, latest?.sm?.responseTimestamp].map(t => Date.parse(t ?? '')).filter(Number.isFinite).map(t => new Date(t + this.policy.maxObservationAgeSeconds * 1000).toISOString()),
      ], this.policy.maxObservationAgeSeconds)).toISOString(), dataHealth: health };
  }
}
