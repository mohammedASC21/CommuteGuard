import type { ObservationBatch } from '../../mta/types.js';
import type { JourneyContext, ReliabilityFrame, ReliabilityReason, ReliabilityStatus, ReliabilityTarget } from '../reliability/index.js';

export interface CommuteConfiguration {
  route: string;
  stopName: string;
  destination: string;
  /** Optional static branch eligibility, not movement evidence. */
  destinationId?: string;
  alightingStopId?: string;
  target: ReliabilityTarget;
  backupLabel: string;
}
export const DEFAULT_COMMUTE: Readonly<CommuteConfiguration> = Object.freeze({
  route: 'Bx28', stopName: 'BAINBRIDGE AV/E 206 ST', destination: 'FORDHAM CENTER 192 ST via GUNHILL', destinationId: 'MTA_101530', alightingStopId: 'MTA_100080',
  target: Object.freeze({ routeId: 'MTA NYCT_BX28', stopId: 'MTA_103617', directionId: '1', isOrigin: false }),
  backupLabel: 'Walk to the D train.',
});
export interface ObservationHistoryStore {
  add(frame: ReliabilityFrame): Promise<void>;
  getRecent(evaluatedAt: string): Promise<readonly ReliabilityFrame[]>;
}
export interface CommuteObservationSource {
  vehicleMonitoring(): Promise<ObservationBatch>;
  stopMonitoring(): Promise<ObservationBatch>;
}
export type EndpointHealth = 'OK' | 'EMPTY' | 'FAILED' | 'ISSUES' | 'STALE' | 'NOT_OBSERVED';
export type CommuteReason = ReliabilityReason | 'NO_STOP_CANDIDATE' | 'DATA_UNAVAILABLE' | 'HISTORY_UNAVAILABLE' | 'STALE_DATA' | 'INVALID_HISTORY' | 'HISTORY_GAP';
export interface CommuteDecision {
  primaryLeg: {
    route: string;
    stop: { id: string; name: string };
    directionId: string;
    destination: string;
    status: ReliabilityStatus;
    summary: string;
    reasonCodes: CommuteReason[];
    vehicleId?: string;
    observedAt?: { vehicleMonitoring?: string; stopMonitoring?: string };
    ageSeconds?: number;
    journey?: { current?: JourneyContext; stopMonitoring?: JourneyContext };
    evidence: { framesRetained: number; distinctCurrentTripObservations: number; stableAssignmentObservations: number; progressingObservations: number };
  };
  recommendation: { action: 'NORMAL_ROUTE' | 'BACKUP_ROUTE'; label: string };
  evaluatedAt: string;
  /** Evidence-bound confidence deadline. UNVERIFIED explanations use the assessment-time snapshot budget. */
  displayExpiresAt?: string;
  dataHealth: {
    status: 'HEALTHY' | 'DEGRADED' | 'UNAVAILABLE';
    vehicleMonitoring: EndpointHealth;
    stopMonitoring: EndpointHealth;
    history: 'OK' | 'FAILED' | 'GAP';
    reasonCodes: CommuteReason[];
  };
}
export interface IngestResult {
  stored: boolean;
  vehicleMonitoring: 'SUCCEEDED' | 'FAILED';
  stopMonitoring: 'SUCCEEDED' | 'FAILED';
  vehicleObservationCount: number;
  stopObservationCount: number;
}
