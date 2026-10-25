import { SupabaseNotificationStore } from '../src/lib/notifications/store.js';
import { departurePlan, localDate } from '../src/lib/notifications/model.js';
import { commuteScope } from '../src/lib/history/scope.js';
import { DEFAULT_COMMUTE } from '../src/lib/commute/types.js';
try {
  const status = await new SupabaseNotificationStore(process.env).status();
  const now = new Date().toISOString();
  const plan = departurePlan(now,status.settings.departure_time,commuteScope(DEFAULT_COMMUTE));
  console.log(JSON.stringify({ savedDeparture:status.settings.departure_time,timezone:status.settings.timezone,
    todayEligible:[1,3].includes(new Date(`${localDate(now)}T12:00:00Z`).getUTCDay()), nextCollectionWindow:{start:plan.start,departure:plan.departure},
    notifications:status.subscribed?'SUBSCRIBED':'NOT_SUBSCRIBED', localWorkerHeartbeat:status.worker,
    lastNotificationOccurrence:status.lastOccurrence },null,2));
} catch { console.error('NOTIFICATION_STATUS_UNAVAILABLE: check local migration/configuration.'); process.exitCode=1; }
