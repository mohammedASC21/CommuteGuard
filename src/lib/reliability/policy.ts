import type { ReliabilityPolicy } from './types.js';

/** Development values only. None were validated by the Phase 1 midday sample. */
export const PROVISIONAL_POLICY: Readonly<ReliabilityPolicy> = Object.freeze({
  historyWindowSeconds: 600,
  maxObservationAgeSeconds: 90,
  severeObservationAgeSeconds: 300,
  maximumObservationGapSeconds: 90,
  maxFutureSkewSeconds: 5,
  maxCrossSourceTimestampSkewSeconds: 5,
  maxCrossSourceResponseSkewSeconds: 5,
  maxCrossSourcePositionDifferenceMeters: 50,
  minimumDistinctObservations: 3,
  minimumStableAssignmentObservations: 3,
  originMinimumStableAssignmentObservations: 5,
  minimumProgressingObservations: 2,
  minimumProgressDistanceMeters: 30,
  minimumCoordinateMovementMeters: 5,
  minimumNegativeObservations: 3,
  minimumNegativeEvidenceFamilies: 2,
  decisiveSevereStaleness: false,
});

export function validatePolicy(policy: Readonly<ReliabilityPolicy>): void {
  for (const key of Object.keys(PROVISIONAL_POLICY) as (keyof ReliabilityPolicy)[]) {
    const value = policy[key];
    if (key === 'decisiveSevereStaleness') {
      if (typeof value !== 'boolean') throw new Error('INVALID_RELIABILITY_POLICY');
    } else if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error('INVALID_RELIABILITY_POLICY');
  }
  for (const key of ['minimumDistinctObservations', 'minimumStableAssignmentObservations', 'originMinimumStableAssignmentObservations', 'minimumProgressingObservations', 'minimumNegativeObservations', 'minimumNegativeEvidenceFamilies'] as const) {
    if (!Number.isInteger(policy[key])) throw new Error('INVALID_RELIABILITY_POLICY');
  }
  // Structural safeguards are not empirically calibrated transit thresholds.
  if (policy.minimumDistinctObservations < 2 || policy.minimumStableAssignmentObservations < 2 || policy.originMinimumStableAssignmentObservations < 2 || policy.minimumNegativeObservations < 2 || policy.minimumNegativeEvidenceFamilies < 2 || policy.minimumNegativeEvidenceFamilies > 4 || policy.severeObservationAgeSeconds < policy.maxObservationAgeSeconds) throw new Error('INVALID_RELIABILITY_POLICY');
}
