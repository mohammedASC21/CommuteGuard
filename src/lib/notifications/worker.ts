import { departurePlan, notificationFor, LOCAL_SCHEDULE } from './model.js';
import type { NotificationStore } from './store.js';
import type { PushSender } from './sender.js';
import { expiredSubscription } from './sender.js';
import type { CommuteDecisionService } from '../commute/service.js';
import type { CollectionSchedule } from '../collector/schedule.js';
export interface LocalWorkerDependencies {
  store: NotificationStore; scope: string; clock: () => string;
  collect: (schedule: CollectionSchedule, now: string) => Promise<unknown>;
  service: Pick<CommuteDecisionService,'ingestLive'|'assess'>;
  send: PushSender;
}
/** One bounded tick. The Node entrypoint owns the loop; no browser/HTTP timer. */
export async function localWorkerTick(d: LocalWorkerDependencies): Promise<string> {
  const settings = await d.store.settings(); // re-read each tick, including after restart
  const now = d.clock();
  await d.store.heartbeat();
  const plan = departurePlan(now, settings.departure_time, d.scope);
  if (plan.collect) {
    await d.collect({ ...LOCAL_SCHEDULE, departure:settings.departure_time }, now);
    return 'COLLECTION_TICK';
  }
  if (!plan.notify) return 'WAITING';
  // Claim before side effects: at most one attempt, also across processes/restarts.
  if (!await d.store.claim(plan.occurrence, settings.departure_time)) return 'ALREADY_CLAIMED_OR_CHANGED';
  let result = 'FAILED';
  try {
    const subscription = await d.store.subscription();
    if (!subscription) { result = 'NO_SUBSCRIPTION'; return result; }
    await d.service.ingestLive();
    const decision = await d.service.assess();
    try { await d.send(subscription, notificationFor(decision, plan.occurrence)); result = 'SENT'; }
    catch (error) { if (expiredSubscription(error)) await d.store.removeSubscription(subscription.endpoint); }
    return result;
  } finally { await d.store.finish(plan.occurrence, result); }
}
