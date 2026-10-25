/** Local-only mutations need no account system. Reject remote Hosts, cross-origin requests and production. */
export function requireLocal(request: Request, mutation = false) {
  const url = new URL(request.url);
  if (process.env.NODE_ENV === 'production' || !['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw Error('LOCAL_ONLY');
  if (mutation && (request.headers.get('origin') !== url.origin || request.headers.get('content-type')?.split(';')[0] !== 'application/json')) throw Error('LOCAL_ONLY');
}
export async function localBody(request: Request): Promise<unknown> {
  const reader = request.body?.getReader(); if (!reader) throw Error('INVALID_BODY');
  let size = 0, text = '';
  const decoder = new TextDecoder();
  try {
    while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 4096) throw Error('INVALID_BODY'); text += decoder.decode(part.value, { stream:true }); }
    return JSON.parse(text + decoder.decode());
  } finally { await reader.cancel(); }
}
export function localReply(body: unknown, status = 200) { return Response.json(body, { status, headers:{'Cache-Control':'no-store'} }); }
