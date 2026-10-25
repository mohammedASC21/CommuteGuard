import { createHash } from 'node:crypto';
import type { CommuteConfiguration } from '../commute/types.js';

/** Changes to route/stop/direction/branch/boarding context create another evidence scope. */
export function commuteScope(config: Readonly<CommuteConfiguration>, namespace = 'commute'): string {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(namespace)) throw new Error('INVALID_HISTORY_SCOPE');
  const identity = JSON.stringify([1, config.target.routeId, config.target.stopId, config.target.directionId, config.target.isOrigin, config.destinationId ?? null, config.alightingStopId ?? null]);
  return `${namespace}:v1:${createHash('sha256').update(identity).digest('hex')}`;
}
