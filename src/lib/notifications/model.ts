import type { CommuteDecision } from '../commute/types.js';
export const LOCAL_SCHEDULE = { timezone: 'America/New_York', days: ['MONDAY', 'WEDNESDAY'], minutesBefore: 7, intervalSeconds: 30 } as const;
export interface DepartureSettings { departure_time: string; timezone: 'America/New_York'; updated_at: string }
export interface Subscription { endpoint: string; keys: { p256dh: string; auth: string } }
export interface PushMessage { title: string; body: string; tag: string }
export function validateTime(value: unknown): string {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw Error('INVALID_DEPARTURE_TIME');
  return value;
}
export function validateSubscription(value: unknown): Subscription {
  if (!value || typeof value !== 'object') throw Error('INVALID_SUBSCRIPTION');
  const s = value as Subscription;
  const url = new URL(s.endpoint);
  // Restrict server-side requests to known browser push providers, never arbitrary hosts.
  const allowed = url.hostname === 'fcm.googleapis.com' || url.hostname === 'updates.push.services.mozilla.com'
    || url.hostname.endsWith('.push.services.mozilla.com') || url.hostname === 'web.push.apple.com';
  if (!allowed || url.protocol !== 'https:' || url.port || url.username || url.password || url.hash || s.endpoint.length > 2048
    || !/^[A-Za-z0-9_-]{87}$/.test(s.keys?.p256dh ?? '') || !/^[A-Za-z0-9_-]{22}$/.test(s.keys?.auth ?? '')) throw Error('INVALID_SUBSCRIPTION');
  return { endpoint: url.href, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } };
}
export function notificationFor(decision: CommuteDecision, occurrence: string): PushMessage {
  const status = decision.primaryLeg.status;
  return { title: `CommuteGuard — Bx28 ${status === 'VERIFIED' ? 'Verified' : status === 'HIGH_GHOST_RISK' ? 'Warning' : 'Unverified'}`,
    body: status === 'VERIFIED' ? 'Use the normal Bx28 route.' : status === 'HIGH_GHOST_RISK' ? 'Repeated warning signs detected. Walk to the D train.' : 'Walk to the D train.', tag: occurrence };
}
export const TEST_NOTIFICATION: PushMessage = { title: 'CommuteGuard Test', body: 'Local push notifications are working.', tag: 'commuteguard-test' };
function localParts(at: number) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: LOCAL_SCHEDULE.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes) => p.find(x => x.type === type)!.value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}:${get('second')}` };
}
export function localDate(at: string): string { return localParts(Date.parse(at)).date; }
/** Convert a New York wall date/time by validating both possible offsets, never a fixed UTC offset. */
export function departureInstant(date: string, time: string): number {
  validateTime(time);
  for (const offset of ['-04:00', '-05:00']) {
    const ms = Date.parse(`${date}T${time}:00${offset}`);
    const p = localParts(ms);
    if (p.date === date && p.time === `${time}:00`) return ms;
  }
  throw Error('INVALID_LOCAL_DEPARTURE');
}
export function departurePlan(now: string, time: string, scope: string) {
  validateTime(time);
  const ms = Date.parse(now); if (!Number.isFinite(ms)) throw Error('INVALID_CLOCK');
  const date = localDate(now);
  // Include tomorrow for a collection window crossing midnight before a Monday departure.
  const startDate = Date.parse(`${date}T12:00:00Z`);
  for (let i = 0; i <= 8; i++) {
    const day = new Date(startDate + i * 86400000);
    if (![1, 3].includes(day.getUTCDay())) continue;
    const d = day.toISOString().slice(0, 10);
    const end = departureInstant(d, time), start = end - LOCAL_SCHEDULE.minutesBefore * 60000;
    if (ms >= end + 60000) continue; // no late/backfilled status notifications
    return { date: d, start: new Date(start).toISOString(), departure: new Date(end).toISOString(),
      occurrence: `${scope}:${d}:${time}`, collect: ms >= start && ms < end, notify: ms >= end && ms < end + 60000 };
  }
  throw Error('NO_DEPARTURE');
}
