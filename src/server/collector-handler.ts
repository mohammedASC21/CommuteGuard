import { createHash, timingSafeEqual } from 'node:crypto';
import type { CollectionResult } from '../lib/collector/collector.js';
async function smallBody(request: Request): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 256) { await reader.cancel(); throw new Error(); }
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { reader.releaseLock(); }
}
/** Authentication precedes parsing, configuration, DB calls and MTA calls. No raw error output. */
export function createCollectorHandler(secret: () => string | undefined, collect: (intendedAt: string) => Promise<CollectionResult>) {
  return async (request: Request): Promise<Response> => {
    const json = (body: object, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
    const expected = secret();
    if (!expected || expected.length < 32) return json({ accepted: false, collected: false, reason: 'COLLECTOR_NOT_CONFIGURED' }, 503);
    const supplied = request.headers.get('authorization') ?? '';
    const digest = (s: string) => createHash('sha256').update(s).digest();
    if (!timingSafeEqual(digest(supplied), digest(`Bearer ${expected}`))) return json({ accepted: false, collected: false, reason: 'UNAUTHORIZED' }, 401);
    // Only a tiny fixed-format body is needed; never echo it or headers.
    if (Number(request.headers.get('content-length') ?? 0) > 256) return json({ accepted: false, collected: false, reason: 'INVALID_REQUEST' }, 400);
    let intendedAt: string;
    try {
      const text = await smallBody(request);
      const body: unknown = JSON.parse(text);
      if (!body || typeof body !== 'object' || !('scheduledAt' in body) || typeof body.scheduledAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(body.scheduledAt) || !Number.isFinite(Date.parse(body.scheduledAt))) throw new Error();
      intendedAt = body.scheduledAt;
    } catch { return json({ accepted: false, collected: false, reason: 'INVALID_REQUEST' }, 400); }
    try {
      const result = await collect(intendedAt);
      return json(result, result.reason === 'STORAGE_FAILURE' ? 503 : 200);
    } catch { return json({ accepted: false, collected: false, reason: 'COLLECTION_UNAVAILABLE' }, 503); }
  };
}
