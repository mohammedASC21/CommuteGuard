import { validatePolicy } from './policy.js';
import type { ReliabilityAssessment, ReliabilityEvidence, ReliabilityPolicy, ReliabilityReason } from './types.js';

/** Apply policy to inspectable evidence. No request, scheduling, or wall-clock access. */
export function classifyReliabilityEvidence(evidence: ReliabilityEvidence, policy: Readonly<ReliabilityPolicy>, evaluatedAt: string): ReliabilityAssessment {
  validatePolicy(policy);
  if (evaluatedAt !== evidence.evaluatedAt || Object.keys(evidence.policy).some(key => policy[key as keyof ReliabilityPolicy] !== evidence.policy[key as keyof ReliabilityPolicy])) throw new Error('EVIDENCE_POLICY_OR_CLOCK_MISMATCH');
  const reasons = new Set<ReliabilityReason>(evidence.reasonCodes);
  const latest = evidence.latest;
  if (!latest) reasons.add('NO_REALTIME_CANDIDATE');
  const stableMinimum = Math.max(policy.minimumStableAssignmentObservations, evidence.target.isOrigin ? policy.originMinimumStableAssignmentObservations : policy.minimumStableAssignmentObservations);
  const enough = evidence.distinctCurrentTripObservations >= policy.minimumDistinctObservations && evidence.stableAssignmentObservations >= stableMinimum;
  if (!enough) reasons.add('INSUFFICIENT_OBSERVATIONS');
  else reasons.add('STABLE_ASSIGNMENT');
  if (evidence.target.isOrigin && !enough) reasons.add('ORIGIN_REQUIRES_STABLE_CURRENT_TRIP');
  const uniqueLatest = evidence.samples.findLast(sample => !sample.neutralSourceDuplicate);
  const latestProgress = uniqueLatest?.coordinateMovementMeters !== undefined && uniqueLatest.coordinateMovementMeters >= policy.minimumCoordinateMovementMeters && uniqueLatest.targetDistanceDeltaMeters !== undefined && uniqueLatest.targetDistanceDeltaMeters < 0;
  const progressing = latestProgress && evidence.progressingObservations >= policy.minimumProgressingObservations && evidence.progressDistanceMeters >= policy.minimumProgressDistanceMeters;
  if (!progressing) reasons.add('INSUFFICIENT_PROGRESS');
  const negativeFamilies = Object.values(evidence.negativeStreaks).filter(count => count >= policy.minimumNegativeObservations).length;
  const decisiveStale = policy.decisiveSevereStaleness && latest?.reasons.includes('SEVERELY_STALE_OBSERVATIONS');
  let status: ReliabilityAssessment['status'] = 'UNVERIFIED';
  if (negativeFamilies >= policy.minimumNegativeEvidenceFamilies || decisiveStale) status = 'HIGH_GHOST_RISK';
  else if (latest?.currentTripCompatible && uniqueLatest?.advancingDistinctObservation && enough && progressing) status = 'VERIFIED';
  let summary = 'There is not enough consistent realtime evidence to rely on this vehicle.';
  if (status === 'VERIFIED') summary = 'Strong, consistent current-trip movement evidence was observed. Arrival, departure and on-time service are not guaranteed.';
  else if (status === 'HIGH_GHOST_RISK') summary = 'Repeated negative evidence or an explicitly decisive policy condition prevents reliable confirmation. High Ghost Risk is this project’s inference, not an MTA status.';
  else if (latest?.reasons.includes('LAYOVER')) summary = 'Realtime data indicates a terminal layover. Departure and boarding availability remain unverified.';
  else if (latest?.reasons.includes('PREVIOUS_TRIP')) summary = 'Realtime data is available, but the vehicle is still associated with its previous trip.';
  else if (latest?.reasons.includes('UNEXPLAINED_JOURNEY_MISMATCH')) summary = 'Current and stop-specific journey information disagree without a previous-trip explanation.';
  return { status, summary, reasonCodes: [...reasons], evidence, evaluatedAt,
    vehicleId: evidence.vehicleId,
    journey: latest ? { current: latest.vm, stopMonitoring: latest.sm } : undefined };
}
