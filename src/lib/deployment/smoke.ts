import { checkProductionEnvironment, collectionUrl, productionOrigin } from './config.js';
import { collectionSchedule, collectionWindow } from '../collector/schedule.js';
/** Explicit administrative smoke. No force-window switch and no raw response logging. */
export async function productionSmoke(env: Readonly<Record<string, string | undefined>>, fetcher: typeof fetch = fetch, now = new Date().toISOString()) {
  if (!checkProductionEnvironment(env).ready) throw new Error('PRODUCTION_CONFIGURATION_UNAVAILABLE');
  const origin = productionOrigin(env.COMMUTEGUARD_PRODUCTION_URL), url = collectionUrl(origin);
  const headers = { 'Content-Type': 'application/json' };
  const invoke = (auth?: string) => fetcher(url, { method: 'POST', headers: { ...headers, ...(auth ? { Authorization: auth } : {}) }, body: JSON.stringify({ scheduledAt: now }), signal: AbortSignal.timeout(65000), redirect: 'error', cache: 'no-store' });
  const noAuth = await invoke(), wrong = await invoke('Bearer INVALID_SMOKE_CREDENTIAL');
  if (noAuth.status !== 401 || wrong.status !== 401) throw new Error('PRODUCTION_AUTH_CHECK_FAILED');
  const allowed = collectionWindow(now, collectionSchedule(env)).allowed;
  const authenticated = await invoke(`Bearer ${env.COMMUTEGUARD_CRON_SECRET}`);
  const outcome: unknown = await authenticated.json();
  if (!authenticated.ok || !outcome || typeof outcome !== 'object' || !('reason' in outcome) || !('collected' in outcome)) throw new Error('PRODUCTION_COLLECTION_CHECK_FAILED');
  const codes = ['OUTSIDE_COLLECTION_WINDOW','INVALID_SCHEDULE_SLOT','COLLECTED','DUPLICATE_ACQUISITION','COLLECTION_IN_PROGRESS','UPSTREAM_PARTIAL_FAILURE','UPSTREAM_FAILURE','UPSTREAM_ISSUES'];
  if (!codes.includes(String(outcome.reason)) || (!allowed && (outcome.reason !== 'OUTSIDE_COLLECTION_WINDOW' || outcome.collected !== false))) throw new Error('PRODUCTION_WINDOW_CHECK_FAILED');
  const web = await fetcher(`${origin}/api/commute`, { cache: 'no-store', signal: AbortSignal.timeout(65000), redirect: 'error' });
  const body: unknown = await web.json();
  if (!web.ok || web.headers.get('X-CommuteGuard-History') !== 'SUPABASE' || !body || typeof body !== 'object') throw new Error('PRODUCTION_WEB_CHECK_FAILED');
  const d = body as { primaryLeg?: { route?: string; stop?: { id?: string }; directionId?: string; status?: string }; dataHealth?: { history?: string }; evaluatedAt?: string };
  if (d.primaryLeg?.route !== 'Bx28' || d.primaryLeg.stop?.id !== 'MTA_103617' || d.primaryLeg.directionId !== '1' || !['VERIFIED','UNVERIFIED','HIGH_GHOST_RISK'].includes(d.primaryLeg.status ?? '') || d.dataHealth?.history !== 'OK' || !Number.isFinite(Date.parse(d.evaluatedAt ?? ''))) throw new Error('PRODUCTION_WEB_CHECK_FAILED');
  return { productionSmoke: 'PASS', origin, backend: 'SUPABASE', persistentHistory: 'PASS', authentication: 'PASS', insideCollectionWindow: allowed, collectionReason: String(outcome.reason), liveStatus: d.primaryLeg.status!, evaluatedAt: d.evaluatedAt! };
}
