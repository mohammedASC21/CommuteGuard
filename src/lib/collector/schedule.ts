/** Engineering schedule only; independent of classifier policy. */
export interface CollectionSchedule { timezone: string; days: readonly string[]; departure: string; minutesBefore: number; intervalSeconds: number }
const weekdays = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
export function collectionSchedule(env: Readonly<Record<string, string | undefined>> = {}): CollectionSchedule {
  const schedule = { timezone: env.COMMUTE_TIMEZONE || 'America/New_York', days: (env.COMMUTE_DAYS || 'MONDAY,WEDNESDAY').split(','), departure: env.COMMUTE_DEPARTURE_TIME || '10:30', minutesBefore: Number(env.COMMUTE_COLLECTION_START_MINUTES_BEFORE || 7), intervalSeconds: Number(env.COMMUTE_COLLECTION_INTERVAL_SECONDS || 30) };
  // MVP stays on the confirmed commute. Reject unsupported schedules rather than silently drifting.
  if (schedule.timezone !== 'America/New_York' || schedule.days.some(d => !weekdays.includes(d)) || new Set(schedule.days).size !== schedule.days.length || !/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.departure) || !Number.isInteger(schedule.minutesBefore) || schedule.minutesBefore < 1 || schedule.minutesBefore > 30 || ![30, 60].includes(schedule.intervalSeconds)) throw new Error('INVALID_COLLECTION_SCHEDULE');
  if (departureSeconds(schedule) < schedule.minutesBefore * 60) throw new Error('INVALID_COLLECTION_SCHEDULE');
  return schedule;
}
function departureSeconds(s: CollectionSchedule) { const [h, m] = s.departure.split(':').map(Number); return h! * 3600 + m! * 60; }
export function collectionWindow(now: string, schedule: CollectionSchedule): { allowed: boolean; localDate: string; localTime: string; slot: string } {
  const milliseconds = Date.parse(now);
  if (!Number.isFinite(milliseconds)) throw new Error('INVALID_COLLECTION_CLOCK');
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: schedule.timezone, weekday: 'long', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(milliseconds));
  const value = (name: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === name)!.value;
  const seconds = Number(value('hour')) * 3600 + Number(value('minute')) * 60 + Number(value('second')) + ((milliseconds % 1000) / 1000);
  const end = departureSeconds(schedule);
  const start = end - schedule.minutesBefore * 60;
  const nextWeekday = weekdays[(weekdays.indexOf(value('weekday').toUpperCase()) + 1) % 7]!;
  const allowed = start < 0
    ? (schedule.days.includes(value('weekday').toUpperCase()) && seconds <= end) || (schedule.days.includes(nextWeekday) && seconds >= 86400 + start)
    : schedule.days.includes(value('weekday').toUpperCase()) && seconds >= start && seconds <= end;
  return { allowed,
    localDate: `${value('year')}-${value('month')}-${value('day')}`, localTime: `${value('hour')}:${value('minute')}:${value('second')}`,
    slot: new Date(Math.floor(milliseconds / (schedule.intervalSeconds * 1000)) * schedule.intervalSeconds * 1000).toISOString() };
}
export function collectionStart(s: CollectionSchedule): string { const seconds = departureSeconds(s) - s.minutesBefore * 60; return `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds % 3600 / 60)).padStart(2, '0')}`; }
