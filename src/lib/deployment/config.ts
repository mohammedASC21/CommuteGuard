import { isIP } from 'node:net';
import { createHistoryBackend } from '../history/backend.js';
import { collectionSchedule } from '../collector/schedule.js';

export function productionOrigin(value: string | undefined): string {
  try {
    const url = new URL(value ?? '');
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || url.pathname !== '/' || isIP(host) || host.startsWith('[') || !host.includes('.') || /(^|\.)(localhost|local|internal|test|invalid)$/.test(host) || !/^[a-z0-9.-]+$/.test(host)) throw new Error();
    return url.origin;
  } catch { throw new Error('INVALID_PRODUCTION_ORIGIN'); }
}
export function collectionUrl(origin: string): string { return new URL('/api/internal/commute/collect', productionOrigin(origin)).href; }
export interface DeploymentCheck { ready: boolean; issues: string[] }
/** Reports names/codes only. Does not return, mutate, log or fetch any environment value. */
export function checkProductionEnvironment(env: Readonly<Record<string, string | undefined>>, requireOrigin = true): DeploymentCheck {
  const issues: string[] = [];
  if (!env.MTA_BUS_TIME_API_KEY?.trim()) issues.push('MISSING_MTA_BUS_TIME_API_KEY');
  if (env.MTA_STOP_ID !== '103617' || env.MTA_DIRECTION_ID !== '1') issues.push('INVALID_BX28_STOP_DIRECTION');
  if (env.COMMUTEGUARD_HISTORY_BACKEND !== 'supabase') issues.push('REQUIRE_EXPLICIT_SUPABASE_BACKEND');
  if (createHistoryBackend({ ...env, NODE_ENV: 'production' }).backend !== 'SUPABASE') issues.push('INVALID_SUPABASE_CONFIGURATION');
  const secret = env.COMMUTEGUARD_CRON_SECRET;
  if (!secret || !/^[A-Za-z0-9_-]{32,256}$/.test(secret)) issues.push('INVALID_COMMUTEGUARD_CRON_SECRET');
  if (secret && [env.MTA_BUS_TIME_API_KEY, env.SUPABASE_SECRET_KEY, env.SUPABASE_SERVICE_ROLE_KEY, env.VERCEL_TOKEN, env.SUPABASE_DB_PASSWORD].filter(Boolean).includes(secret)) issues.push('CRON_SECRET_MUST_BE_DEDICATED');
  if (Object.keys(env).some(name => name.startsWith('NEXT_PUBLIC_') && /MTA|SUPABASE|CRON|SECRET|TOKEN|PASSWORD/.test(name))) issues.push('FORBIDDEN_PUBLIC_CREDENTIAL_VARIABLE');
  try {
    const s = collectionSchedule(env);
    if (s.days.join(',') !== 'MONDAY,WEDNESDAY' || s.departure !== '10:30' || s.minutesBefore !== 7 || s.intervalSeconds !== 30) issues.push('SCHEDULE_DIFFERS_FROM_CONFIRMED_MVP');
  } catch { issues.push('INVALID_COLLECTION_SCHEDULE'); }
  if (requireOrigin || env.COMMUTEGUARD_PRODUCTION_URL) try { productionOrigin(env.COMMUTEGUARD_PRODUCTION_URL); } catch { issues.push('INVALID_COMMUTEGUARD_PRODUCTION_URL'); }
  return { ready: issues.length === 0, issues };
}
export function assertProductionCollectionEnvironment(env: Readonly<Record<string, string | undefined>>): void {
  if (env.NODE_ENV === 'production' && !checkProductionEnvironment(env, false).ready) throw new Error('PRODUCTION_CONFIGURATION_UNAVAILABLE');
}
