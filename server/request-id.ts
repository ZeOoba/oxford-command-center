// server/request-id.ts
//
// Request IDs (review round 2, 2026-11-24; index.ts registration approved by Gabriel in-turn).
// Every request gets an id, echoed as the X-Request-Id response header and carried on the error
// log line and the JSON 500 body (warehouse/json-errors.ts), so a failure on screen can be matched
// to its server log line.
//
// An incoming X-Request-Id is reused only when it is short and plain ([A-Za-z0-9._-], 1-64 chars):
// it is written into log lines, so anything else (newlines, spaces, long strings) is replaced with a
// fresh id instead of being trusted.
import { randomUUID } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';

export const REQUEST_ID_HEADER = 'X-Request-Id';
const SAFE_ID = /^[A-Za-z0-9._-]{1,64}$/;

export function acceptRequestId(incoming: string | undefined | null): string {
  return incoming && SAFE_ID.test(incoming) ? incoming : randomUUID();
}

export const requestId: MiddlewareHandler = async (c, next) => {
  const id = acceptRequestId(c.req.header(REQUEST_ID_HEADER));
  c.set('requestId' as never, id as never);
  await next();
  if (c.res.status >= 500) {
    // One correlation line per 5xx, whoever built the response (refute wf_9c0867f7-c0e: raw-Response
    // sites and the overlay save failures logged without the id). The path is JSON-quoted (Hono
    // decodes it, so a crafted %0A could otherwise forge a line); never the query string or body.
    console.error(`[request] ${c.res.status} ${c.req.method} ${JSON.stringify(c.req.path)} request=${id}`);
  }
  await addIdToJsonServerError(c, id);
  try {
    c.res.headers.set(REQUEST_ID_HEADER, id);
  } catch {
    // Immutable headers (Response.redirect, a proxied fetch Response): copy the response so it still
    // carries the id (refute wf_f4a4140a-880, low). Same status, body stream and other headers.
    const copy = new Response(c.res.body, c.res);
    copy.headers.set(REQUEST_ID_HEADER, id);
    c.res = copy;
  }
};

/**
 * Backstop for 5xx JSON bodies built without the helpers (raw `new Response(...)` in safeBriefing,
 * the IC memo export, lease-market's guarded(), om-extract's status passthrough...): when the body
 * is a small JSON object with no requestId yet, add it (refute wf_177c442a-67f, 2026-11-24). Same
 * status and headers; content-length dropped because the body grew. Anything else (non-JSON, an
 * array, a stream over 64 KB, unparseable) is left exactly as it was.
 */
const MAX_REWRITE_BYTES = 64 * 1024;
async function addIdToJsonServerError(c: Context, id: string): Promise<void> {
  const res = c.res;
  if (res.status < 500 || !(res.headers.get('content-type') ?? '').toLowerCase().includes('application/json')) return;
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > MAX_REWRITE_BYTES) return;
  let body: unknown;
  try {
    const text = await res.clone().text();
    if (text.length > MAX_REWRITE_BYTES) return;
    body = JSON.parse(text);
  } catch {
    return;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body) || 'requestId' in body) return;
  const headers = new Headers(res.headers);
  headers.delete('content-length');
  c.res = undefined;
  c.res = new Response(JSON.stringify({ ...(body as Record<string, unknown>), requestId: id }), {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

/** The id requestId() assigned to this request, or null when the middleware did not run (e.g. a unit-test app). */
export function requestIdOf(c: Context): string | null {
  const v = c.get('requestId' as never) as unknown;
  return typeof v === 'string' ? v : null;
}
