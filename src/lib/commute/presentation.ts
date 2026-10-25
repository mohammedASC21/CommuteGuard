import type { CommuteDecision } from './types.js';
import { PROVISIONAL_POLICY } from '../reliability/policy.js';
/** Display expiry only, never a replacement classifier. Expiry cannot produce VERIFIED. */
export function decisionDisplayDeadline(d: CommuteDecision): number {
  // A current failure-to-verify assessment may describe already stale evidence.
  // Keep its explanation visible for the existing snapshot budget; it grants no confidence.
  if (d.primaryLeg.status === 'UNVERIFIED') return observationDisplayDeadline(d.evaluatedAt, undefined);
  const bound = observationDisplayDeadline(d.evaluatedAt, d.primaryLeg.ageSeconds);
  return d.displayExpiresAt ? Math.min(bound, Date.parse(d.displayExpiresAt)) : bound;
}
export function observationDisplayDeadline(evaluatedAt: string, age: number | undefined, limits: readonly (string | undefined)[] = [], maximumAge = PROVISIONAL_POLICY.maxObservationAgeSeconds): number {
  const remaining = typeof age === 'number' && Number.isFinite(age) ? Math.max(0, maximumAge - Math.max(0, age)) : maximumAge;
  return Math.min(Date.parse(evaluatedAt) + remaining * 1000, ...limits.map(t => Date.parse(t ?? '')).filter(Number.isFinite));
}
