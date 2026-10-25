import { deriveReliabilityEvidence } from './evidence.js';
import { classifyReliabilityEvidence } from './classify.js';
import { PROVISIONAL_POLICY } from './policy.js';
import type { ReliabilityInput, ReliabilityPolicy } from './types.js';

export * from './types.js';
export { PROVISIONAL_POLICY, validatePolicy } from './policy.js';
export { deriveReliabilityEvidence } from './evidence.js';
export { classifyReliabilityEvidence } from './classify.js';
export function assessReliability(input: ReliabilityInput, policy: Readonly<ReliabilityPolicy> = PROVISIONAL_POLICY) {
  return classifyReliabilityEvidence(deriveReliabilityEvidence(input, policy), policy, input.evaluatedAt);
}
