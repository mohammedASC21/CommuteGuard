import { validateSubscription, validateTime, type DepartureSettings, type Subscription } from './model.js';
export interface NotificationStore {
  settings(): Promise<DepartureSettings>;
  saveTime(time: string): Promise<void>;
  subscription(): Promise<Subscription | null>;
  saveSubscription(value: Subscription): Promise<void>;
  removeSubscription(endpoint: string): Promise<void>;
  claim(occurrence: string, departure: string): Promise<boolean>;
  finish(occurrence: string, result: string): Promise<void>;
  heartbeat(): Promise<void>;
}
export class SupabaseNotificationStore implements NotificationStore {
  private url: string; private key: string;
  constructor(env: Readonly<Record<string, string | undefined>>, private fetcher: typeof fetch = fetch) {
    if (typeof window !== 'undefined') throw Error('SERVER_ONLY');
    const u = new URL(env.SUPABASE_URL ?? '');
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) throw Error('NOTIFICATIONS_NOT_CONFIGURED');
    this.url = u.origin; this.key = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '';
    if (!this.key || env.COMMUTEGUARD_HISTORY_BACKEND !== 'supabase') throw Error('NOTIFICATIONS_REQUIRE_SUPABASE');
  }
  private async request(path: string, method = 'GET', body?: unknown): Promise<unknown> {
    try {
      const headers: Record<string,string> = { apikey: this.key, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' };
      if (!this.key.startsWith('sb_secret_')) headers.Authorization = `Bearer ${this.key}`;
      const r = await this.fetcher(`${this.url}/rest/v1/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw Error();
      const text = await r.text(); return text ? JSON.parse(text) : null;
    } catch { throw Error('NOTIFICATION_STORAGE_UNAVAILABLE'); }
  }
  async settings(): Promise<DepartureSettings> {
    const rows = await this.request('commute_settings?singleton=eq.true&select=departure_time,timezone,updated_at') as DepartureSettings[];
    const s = rows?.[0]; if (!s || s.timezone !== 'America/New_York' || !Number.isFinite(Date.parse(s.updated_at))) throw Error('INVALID_SETTINGS');
    validateTime(s.departure_time); return s;
  }
  async saveTime(time: string) { await this.request('rpc/cg_save_departure', 'POST', { p_departure: validateTime(time) }); }
  async subscription(): Promise<Subscription | null> {
    const rows = await this.request('commute_push_subscription?singleton=eq.true&select=endpoint,p256dh,auth') as Array<{endpoint:string;p256dh:string;auth:string}>;
    const s = rows?.[0]; return s ? validateSubscription({ endpoint: s.endpoint, keys: { p256dh:s.p256dh, auth:s.auth } }) : null;
  }
  async saveSubscription(value: Subscription) { const s = validateSubscription(value); await this.request('commute_push_subscription', 'POST', { singleton:true, endpoint:s.endpoint, ...s.keys, updated_at:new Date().toISOString() }); }
  async removeSubscription(endpoint: string) { await this.request(`commute_push_subscription?singleton=eq.true&endpoint=eq.${encodeURIComponent(endpoint)}`, 'DELETE'); }
  async claim(occurrence: string, departure: string) { return await this.request('rpc/cg_claim_notification', 'POST', { p_occurrence:occurrence, p_departure:departure }) === true; }
  async finish(occurrence: string, result: string) { await this.request(`commute_notification_occurrences?occurrence=eq.${encodeURIComponent(occurrence)}`, 'PATCH', { result }); }
  async heartbeat() { await this.request('commute_local_worker', 'POST', { singleton:true, heartbeat_at:new Date().toISOString() }); }
  async status() {
    const [settings, subscription, occurrences, worker] = await Promise.all([this.settings(), this.subscription(), this.request('commute_notification_occurrences?select=claimed_at,result&order=claimed_at.desc&limit=1'), this.request('commute_local_worker?select=heartbeat_at&limit=1')]);
    return { settings, subscribed:!!subscription, lastOccurrence:occurrences, worker };
  }
}
