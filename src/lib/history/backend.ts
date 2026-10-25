import { InMemoryObservationHistory } from '../commute/history.js';
import { DEFAULT_COMMUTE } from '../commute/types.js';
import type { CommuteConfiguration, ObservationHistoryStore } from '../commute/types.js';
import { PROVISIONAL_POLICY } from '../reliability/policy.js';
import { commuteScope } from './scope.js';
import { SupabaseObservationHistory } from './supabase-history.js';

export type HistoryBackendName = 'SUPABASE' | 'MEMORY' | 'NOT_CONFIGURED';
export interface HistoryBinding { backend: HistoryBackendName; scope: string; evidenceWindowSeconds: number; store: ObservationHistoryStore }
class UnavailableHistory implements ObservationHistoryStore {
  async add(): Promise<void> { throw new Error('HISTORY_NOT_CONFIGURED'); }
  async getRecent(): Promise<never> { throw new Error('HISTORY_NOT_CONFIGURED'); }
}
/** Shared server-side selection for web, CLI and inspection. Never falls back on a DB error. */
export function createHistoryBackend(env: Readonly<Record<string, string | undefined>>, config: Readonly<CommuteConfiguration> = DEFAULT_COMMUTE, fetcher: typeof fetch = fetch): HistoryBinding {
  if (typeof window !== 'undefined') throw new Error('SERVER_HISTORY_ONLY');
  const scope = commuteScope(config);
  const result = (backend: HistoryBackendName, store: ObservationHistoryStore): HistoryBinding => ({ backend, store, scope, evidenceWindowSeconds: PROVISIONAL_POLICY.historyWindowSeconds });
  const mode = env.COMMUTEGUARD_HISTORY_BACKEND?.trim().toLowerCase();
  if (mode === 'memory' && env.NODE_ENV !== 'production') return result('MEMORY', new InMemoryObservationHistory());
  if (mode && mode !== 'supabase') return result('NOT_CONFIGURED', new UnavailableHistory());
  const key = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
  if (!env.SUPABASE_URL || !key) return result('NOT_CONFIGURED', new UnavailableHistory());
  try {
    return result('SUPABASE', new SupabaseObservationHistory({ url: env.SUPABASE_URL, secretKey: key, scope,
      retentionSeconds: env.COMMUTEGUARD_HISTORY_RETENTION_SECONDS ? Number(env.COMMUTEGUARD_HISTORY_RETENTION_SECONDS) : undefined,
      redactions: [env.MTA_BUS_TIME_API_KEY, env.SUPABASE_SECRET_KEY, env.SUPABASE_SERVICE_ROLE_KEY, env.COMMUTEGUARD_CRON_SECRET].filter((s): s is string => !!s),
    }, fetcher));
  } catch { return result('NOT_CONFIGURED', new UnavailableHistory()); }
}
