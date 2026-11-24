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

/** The id requestId() assigned to this request, or null when the middleware did not run (e.g. a unit-test app). */
export function requestIdOf(c: Context): string | null {
  const v = c.get('requestId' as never) as unknown;
  return typeof v === 'string' ? v : null;
}
