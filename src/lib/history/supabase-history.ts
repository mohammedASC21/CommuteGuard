import type { ObservationHistoryStore } from '../commute/types.js';
import type { ReliabilityFrame } from '../reliability/types.js';
import { PROVISIONAL_POLICY } from '../reliability/policy.js';
import { normalizedFrame } from './frame-codec.js';
import type { Claim, CollectionReason } from '../collector/collector.js';

export const DEFAULT_RETENTION_SECONDS = 86400;
export interface SupabaseHistoryOptions { url: string; secretKey: string; scope: string; retentionSeconds?: number; redactions?: readonly string[] }
/** Node/server only; transport never logs bodies, URLs, credentials, or original errors. */
export class SupabaseObservationHistory implements ObservationHistoryStore {
  private readonly base: string;
  private readonly retention: number;
  constructor(private readonly options: SupabaseHistoryOptions, private readonly fetcher: typeof fetch = fetch) {
    if (typeof window !== 'undefined') throw new Error('SERVER_HISTORY_ONLY');
    let url: URL;
    try { url = new URL(options.url); } catch { throw new Error('INVALID_HISTORY_CONFIGURATION'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['/', '/rest/v1', '/rest/v1/'].includes(url.pathname) || !options.secretKey.trim() || !/^[a-zA-Z0-9_:-]{10,200}$/.test(options.scope)) throw new Error('INVALID_HISTORY_CONFIGURATION');
    this.base = url.origin;
    this.retention = options.retentionSeconds ?? DEFAULT_RETENTION_SECONDS;
    if (!Number.isInteger(this.retention) || this.retention < PROVISIONAL_POLICY.historyWindowSeconds || this.retention > 604800) throw new Error('INVALID_HISTORY_RETENTION');
  }
  private async rpc(name: string, body: object): Promise<unknown> {
    try {
      const headers: Record<string, string> = { apikey: this.options.secretKey, 'Content-Type': 'application/json' };
      // Secret API keys authenticate through apikey; legacy JWT service_role keys also need bearer auth.
      if (!this.options.secretKey.startsWith('sb_secret_')) headers.Authorization = `Bearer ${this.options.secretKey}`;
      const response = await this.fetcher(`${this.base}/rest/v1/rpc/${name}`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(10000), redirect: 'error', cache: 'no-store' });
      if (!response.ok) throw new Error('HISTORY_REQUEST_FAILED');
      return response.status === 204 ? null : await response.json();
    } catch { throw new Error('HISTORY_STORAGE_UNAVAILABLE'); }
  }
  private safeFrame(frame: ReliabilityFrame): ReliabilityFrame & { acquisitionId: string } {
    const clean = normalizedFrame(frame);
    let body = JSON.stringify(clean);
    for (const key of [this.options.secretKey, ...(this.options.redactions ?? [])].filter(Boolean)) {
      for (const variant of [key, encodeURIComponent(key), JSON.stringify(key).slice(1, -1)]) if (body.includes(variant)) throw new Error('HISTORY_CREDENTIAL_REJECTED');
    }
    // Roundtrip strips undefined and severs all references; arbitrary extra fields were never selected.
    body = JSON.stringify(clean);
    return JSON.parse(body) as ReliabilityFrame & { acquisitionId: string };
  }
  async add(frame: ReliabilityFrame): Promise<void> {
    try {
      const clean = this.safeFrame(frame);
      await this.rpc('cg_append_frame', { p_scope: this.options.scope, p_acquisition_id: clean.acquisitionId, p_completed_at: clean.completedAt, p_frame: clean, p_retention_seconds: this.retention });
    } catch { throw new Error('HISTORY_WRITE_FAILED'); }
  }
  async prune(): Promise<void> {
    await this.rpc('cg_prune_history', { p_scope: this.options.scope, p_retention_seconds: this.retention });
  }
  async claimCollection(slot: string, id: string, token: string): Promise<Claim> {
    const value = await this.rpc('cg_claim_collection', { p_scope: this.options.scope, p_slot: slot, p_id: id, p_token: token });
    if (!value || typeof value !== 'object' || !('status' in value) || !['ACQUIRED', 'DUPLICATE_ACQUISITION', 'COLLECTION_IN_PROGRESS'].includes(String(value.status)) || !('gap' in value) || typeof value.gap !== 'boolean') throw new Error('INVALID_COLLECTION_CLAIM');
    return { status: value.status as Claim['status'], gap: value.gap };
  }
  async completeCollection(slot: string, token: string, frame: ReliabilityFrame, result: CollectionReason): Promise<void> {
    await this.rpc('cg_complete_collection', { p_scope: this.options.scope, p_slot: slot, p_token: token, p_frame: this.safeFrame(frame), p_result: result, p_retention_seconds: this.retention });
  }
  async collectionStatus(): Promise<{ state: string; lastCompletedAt: string | null; lastResult: string | null }> {
    const value = await this.rpc('cg_collection_status', { p_scope: this.options.scope });
    if (!value || typeof value !== 'object') throw new Error('INVALID_COLLECTION_STATUS');
    const row = value as Record<string, unknown>;
    const states = ['IN_PROGRESS', 'ABANDONED', 'COLLECTED', 'UPSTREAM_PARTIAL_FAILURE', 'UPSTREAM_FAILURE', 'UPSTREAM_ISSUES'];
    if (row.state !== undefined && !states.includes(String(row.state))) throw new Error('INVALID_COLLECTION_STATUS');
    if (row.lastCompletedAt != null && (typeof row.lastCompletedAt !== 'string' || !Number.isFinite(Date.parse(row.lastCompletedAt)))) throw new Error('INVALID_COLLECTION_STATUS');
    if (row.lastResult != null && !states.includes(String(row.lastResult))) throw new Error('INVALID_COLLECTION_STATUS');
    return { state: row.state === undefined ? 'NONE' : String(row.state), lastCompletedAt: row.lastCompletedAt == null ? null : String(row.lastCompletedAt), lastResult: row.lastResult == null ? null : String(row.lastResult) };
  }
  async getRecent(evaluatedAt: string): Promise<readonly ReliabilityFrame[]> {
    try {
      if (!Number.isFinite(Date.parse(evaluatedAt))) throw new Error();
      const rows = await this.rpc('cg_recent_frames', { p_scope: this.options.scope, p_evaluated_at: evaluatedAt, p_window_seconds: PROVISIONAL_POLICY.historyWindowSeconds, p_limit: 40 });
      if (!Array.isArray(rows) || rows.length > 40) throw new Error();
      const frames = rows.map(row => this.safeFrame(row));
      if (frames.some((f, i) => i > 0 && Date.parse(f.completedAt) < Date.parse(frames[i - 1]!.completedAt))) throw new Error();
      return frames;
    } catch { throw new Error('HISTORY_READ_FAILED'); }
  }
}
