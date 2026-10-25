import type { CommuteDecisionService } from '../lib/commute/service.js';

type Service = Pick<CommuteDecisionService, 'ingestLive' | 'assess'>;
/** Transport only: Phase 3 owns selection, assessment and recommendation. */
export function createCommuteHandler(service: () => Service, secret: () => string | undefined = () => undefined, backend?: () => string) {
  return async function GET() {
    const headers: Record<string, string> = { 'Cache-Control': 'no-store, max-age=0', 'Content-Type': 'application/json' };
    try {
      if (backend) headers['X-CommuteGuard-History'] = backend();
      const current = service();
      await current.ingestLive();
      const decision = await current.assess();
      let body = JSON.stringify(decision);
      const key = secret();
      if (key) for (const value of [key, encodeURIComponent(key), JSON.stringify(key).slice(1, -1)]) body = body.replaceAll(value, '[REDACTED]');
      return new Response(body, { headers });
    } catch {
      return new Response(JSON.stringify({ error: { code: 'COMMUTE_UNAVAILABLE', message: 'Current transit data could not be verified.' } }), { status: 503, headers });
    }
  };
}
