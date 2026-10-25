import type { ObservationBatch } from '../../mta/types.js';

export type ReliabilityStatus = 'VERIFIED' | 'UNVERIFIED' | 'HIGH_GHOST_RISK';
export const REASON_CODES = [
  'FRESH_OBSERVATIONS', 'STALE_OBSERVATIONS', 'SEVERELY_STALE_OBSERVATIONS',
  'INSUFFICIENT_OBSERVATIONS', 'REPEATED_TIMESTAMP', 'REGRESSING_TIMESTAMP',
  'MISSING_TIMESTAMP', 'MISSING_ASSIGNMENT', 'INVALID_TIME', 'OBSERVATION_GAP', 'CURRENT_TRIP_MATCH',
  'PREVIOUS_TRIP', 'STABLE_ASSIGNMENT', 'ASSIGNMENT_TRANSITION',
  'UNEXPLAINED_JOURNEY_MISMATCH', 'CROSS_SOURCE_TIME_SKEW', 'CROSS_SOURCE_POSITION_MISMATCH',
  'PROGRESS_TOWARD_TARGET', 'NO_PROGRESS', 'MOVING_AWAY', 'DISTANCE_UNAVAILABLE',
  'COORDINATES_UNAVAILABLE', 'LAYOVER', 'SOURCE_NO_PROGRESS', 'NO_REALTIME_CANDIDATE',
  'CANDIDATE_DISAPPEARED', 'CANDIDATE_REAPPEARED', 'REQUEST_FAILURE', 'ADAPTER_ISSUE',
  'WRONG_ROUTE_OR_DIRECTION', 'TARGET_STOP_UNCONFIRMED', 'AMBIGUOUS_CANDIDATE',
  'ORIGIN_REQUIRES_STABLE_CURRENT_TRIP', 'INSUFFICIENT_PROGRESS',
] as const;
export type ReliabilityReason = (typeof REASON_CODES)[number];
export interface ReliabilityTarget {
  routeId: string;
  /** Fully qualified adapter stop reference, e.g. MTA_103620. */
  stopId: string;
  directionId: string;
  isOrigin: boolean;
}
export interface ReliabilityFrame {
  /** Acquisition identity; transport/history metadata, never movement evidence. */
  acquisitionId?: string;
  completedAt: string;
  vm?: ObservationBatch;
  sm?: ObservationBatch;
  /** Presence of errors matters; upstream error strings are never copied to output. */
  errors?: readonly string[];
}
export interface ReliabilityInput {
  target: ReliabilityTarget;
  /** Evaluate one explicit vehicle; never silently pick a different candidate. */
  vehicleId: string;
  frames: readonly ReliabilityFrame[];
  /** Caller-supplied clock: no Date.now(), network, environment or persistence. */
  evaluatedAt: string;
}
export interface ReliabilityPolicy {
  historyWindowSeconds: number;
  maxObservationAgeSeconds: number;
  severeObservationAgeSeconds: number;
  maximumObservationGapSeconds: number;
  maxFutureSkewSeconds: number;
  maxCrossSourceTimestampSkewSeconds: number;
  maxCrossSourceResponseSkewSeconds: number;
  maxCrossSourcePositionDifferenceMeters: number;
  minimumDistinctObservations: number;
  minimumStableAssignmentObservations: number;
  originMinimumStableAssignmentObservations: number;
  minimumProgressingObservations: number;
  minimumProgressDistanceMeters: number;
  minimumCoordinateMovementMeters: number;
  minimumNegativeObservations: number;
  minimumNegativeEvidenceFamilies: number;
  /** Explicit opt-in only: one severely old latest observation can be decisive. */
  decisiveSevereStaleness: boolean;
}
export type NegativeEvidenceFamily = 'SOURCE_QUALITY' | 'AVAILABILITY' | 'ASSIGNMENT' | 'PROGRESSION';
export interface JourneyContext {
  vehicleId?: string;
  routeId?: string;
  serviceDate?: string;
  tripId?: string;
  blockId?: string;
  directionId?: string;
  destinationId?: string;
  destinationName?: string;
}
export interface EvidenceSample {
  /** Fresh identical VM/SM evidence; persisted acquisition contributes no new source sample. */
  neutralSourceDuplicate?: boolean;
  completedAt: string;
  vm?: JourneyContext;
  sm?: JourneyContext;
  vmTimestamp?: string;
  smTimestamp?: string;
  vmResponseTimestamp?: string;
  smResponseTimestamp?: string;
  vmValidUntil?: (string | undefined)[];
  smValidUntil?: (string | undefined)[];
  vehicleAgeSeconds?: number;
  vmProgressRate?: string;
  smProgressRate?: string;
  vmProgressStatus?: string;
  smProgressStatus?: string;
  predictedArrival?: string;
  scheduledOriginDeparture?: string;
  targetDistanceMeters?: number;
  stopsFromCall?: number;
  coordinateMovementMeters?: number;
  targetDistanceDeltaMeters?: number;
  sourceTimestampDeltaSeconds?: number;
  reasons: ReliabilityReason[];
  currentTripCompatible: boolean;
  advancingDistinctObservation: boolean;
}
export interface ReliabilityEvidence {
  vehicleId: string;
  evaluatedAt: string;
  policy: Readonly<ReliabilityPolicy>;
  target: ReliabilityTarget;
  samples: EvidenceSample[];
  latest?: EvidenceSample;
  distinctCurrentTripObservations: number;
  stableAssignmentObservations: number;
  progressingObservations: number;
  progressDistanceMeters: number;
  negativeStreaks: Record<NegativeEvidenceFamily, number>;
  reasonCodes: ReliabilityReason[];
}
export interface ReliabilityAssessment {
  status: ReliabilityStatus;
  summary: string;
  reasonCodes: ReliabilityReason[];
  evidence: ReliabilityEvidence;
  evaluatedAt: string;
  vehicleId?: string;
  journey?: { current?: JourneyContext; stopMonitoring?: JourneyContext };
}
