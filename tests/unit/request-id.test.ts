// @vitest-environment node
// Review round 2 (2026-11-24): request ids, so a 500 on screen can be matched to its server log line.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { acceptRequestId, requestId, requestIdOf, REQUEST_ID_HEADER } from '../../server/request-id';
import { jsonErrorHandler, routeFailure, warehouseJsonError, withRequestId } from '../../server/warehouse/json-errors';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Same shape as server/index.ts: root middleware + root onError, and a SIBLING sub-app with its own onError. */
function makeApp() {
  const app = new Hono();
  app.onError(jsonErrorHandler('server'));
  app.use('*', requestId);
  app.get('/ok', (c) => c.json({ id: requestIdOf(c) }));
  app.get('/raw', () => new Response('plain', { status: 200 }));
  app.get('/boom', () => {
    throw new Error('root failure');
  });
  const sub = new Hono();
  sub.onError(warehouseJsonError);
  sub.get('/boom', () => {
    throw new Error('SQLITE_ERROR: no such table secret_table');
  });
  app.route('/api/warehouse', sub);
  return app;
}

afterEach(() => vi.restoreAllMocks());

describe('acceptRequestId', () => {
  it('keeps a short plain incoming id', () => {
    expect(acceptRequestId('abc-123_X.y')).toBe('abc-123_X.y');
  });
  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['a newline (log forging)', 'abc\nERROR fake line'],
    ['a space', 'a b'],
    ['too long', 'x'.repeat(65)],
  ])('replaces %s with a fresh UUID', (_label, v) => {
    expect(acceptRequestId(v)).toMatch(UUID);
  });
});

describe('requestId middleware', () => {
  it('sets X-Request-Id on a normal response and exposes the same id to the handler', async () => {
    const res = await makeApp().request('/ok');
    const id = res.headers.get(REQUEST_ID_HEADER);
    expect(id).toMatch(UUID);
    expect(((await res.json()) as { id: string }).id).toBe(id);
  });

  it('sets the header on a raw Response too', async () => {
    const res = await makeApp().request('/raw');
    expect(res.headers.get(REQUEST_ID_HEADER)).toMatch(UUID);
  });

  it('sets the header on a redirect (immutable headers) without changing status or location', async () => {
    const app = new Hono();
    app.use('*', requestId);
    app.get('/go', () => Response.redirect('http://127.0.0.1/elsewhere', 302));
    const res = await app.request('/go');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('http://127.0.0.1/elsewhere');
    expect(res.headers.get(REQUEST_ID_HEADER)).toMatch(UUID);
  });

  it('echoes a safe incoming id and replaces an unsafe one', async () => {
    const app = makeApp();
    const kept = await app.request('/ok', { headers: { [REQUEST_ID_HEADER]: 'trace-42' } });
    expect(kept.headers.get(REQUEST_ID_HEADER)).toBe('trace-42');
    const replaced = await app.request('/ok', { headers: { [REQUEST_ID_HEADER]: 'a b c' } });
    expect(replaced.headers.get(REQUEST_ID_HEADER)).toMatch(UUID);
  });

  it.each([
    ['a root route', '/boom', '[server]'],
    ['a sibling warehouse sub-app', '/api/warehouse/boom', '[warehouse]'],
  ])('a 500 from %s carries the id in header, body and log line, and still hides the raw error', async (_l, path, tag) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await makeApp().request(path);
    expect(res.status).toBe(500);
    const id = res.headers.get(REQUEST_ID_HEADER)!;
    expect(id).toMatch(UUID);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: 'internal error', requestId: id });
    expect(JSON.stringify(body)).not.toMatch(/SQLITE|secret_table|root failure/);
    const line = String(log.mock.calls[0]?.[0]);
    expect(line).toContain(tag);
    expect(line).toContain(`request=${id}`);
  });

  it('without the middleware the 500 body is unchanged (no requestId key)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = new Hono();
    app.onError(jsonErrorHandler('server'));
    app.get('/boom', () => {
      throw new Error('x');
    });
    const res = await app.request('/boom');
    expect(await res.json()).toEqual({ error: 'internal error' });
  });
});

// Follow-up (2026-11-24): the hand-written catch-to-500 sites carry the id too.
describe('routeFailure / withRequestId (hand-written 500s)', () => {
  function app(withMw: boolean) {
    const a = new Hono();
    if (withMw) a.use('*', requestId);
    a.get('/caught', (c) => {
      try {
        throw new Error('SQLITE_ERROR: no such table secret_table');
      } catch (err) {
        return routeFailure(c, '[debt-api] /scores error:', err, 'debt scoring failed');
      }
    });
    a.get('/save', (c) => c.json(withRequestId(c, { ok: false, error: 'overlay persistence failed' } as const), 500));
    return a;
  }

  it('a caught failure logs prefix + id and the message only, and answers the generic body + id', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await app(true).request('/caught');
    const id = res.headers.get(REQUEST_ID_HEADER)!;
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'debt scoring failed', requestId: id });
    expect(log).toHaveBeenCalledWith(`[debt-api] /scores error: request=${id}`, 'SQLITE_ERROR: no such table secret_table');
  });

  it('without the middleware both the log call and the body are exactly as before', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await app(false).request('/caught');
    expect(await res.json()).toEqual({ error: 'debt scoring failed' });
    expect(log).toHaveBeenCalledWith('[debt-api] /scores error:', 'SQLITE_ERROR: no such table secret_table');
    expect(await (await app(false).request('/save')).json()).toEqual({ ok: false, error: 'overlay persistence failed' });
  });

  it('a save-failure body keeps its fields and gains the id', async () => {
    const res = await app(true).request('/save');
    expect(await res.json()).toEqual({ ok: false, error: 'overlay persistence failed', requestId: res.headers.get(REQUEST_ID_HEADER) });
  });

  // Scope: literal `c.json(..., 500)` calls. Raw `new Response(..., {status: 500})` and status
  // passthroughs are covered by the middleware backstop below instead (refute wf_177c442a-67f).
  it('every literal c.json(..., 500) in server/ goes through the helpers', () => {
    const files = ['server/index.ts', 'server/property-financials/property-financials-api.ts', ...readdirSync(join(process.cwd(), 'server', 'warehouse')).filter((f) => f.endsWith('.ts')).map((f) => `server/warehouse/${f}`)];
    const bare: string[] = [];
    for (const f of files) {
      if (f.endsWith('json-errors.ts')) continue;
      readFileSync(join(process.cwd(), f), 'utf-8').split(/\r?\n/).forEach((line, i) => {
        if (/c\.json\([^)]*,\s*500\)/.test(line) && !/withRequestId\(/.test(line)) bare.push(`${f}:${i + 1}`);
      });
    }
    expect(bare).toEqual([]);
  });
});

// Backstop (refute wf_177c442a-67f): 5xx JSON bodies built without the helpers still get the id.
describe('requestId backstop for raw 5xx JSON bodies', () => {
  function app() {
    const a = new Hono();
    a.use('*', requestId);
    a.get('/raw500', () => new Response(JSON.stringify({ error: 'briefing generation failed' }), { status: 500, headers: { 'content-type': 'application/json' } }));
    a.get('/raw500len', () => new Response('{"error":"x"}', { status: 500, headers: { 'content-type': 'application/json', 'content-length': '13' } }));
    a.get('/passthrough', (c) => c.json({ ok: false, error: 'AI extraction requires a key' }, 500 as 403 | 500));
    a.get('/503', (c) => c.json({ error: 'warehouse unavailable' }, 503));
    a.get('/text500', () => new Response('plain failure', { status: 500, headers: { 'content-type': 'text/plain' } }));
    a.get('/array500', () => new Response('[1,2]', { status: 500, headers: { 'content-type': 'application/json' } }));
    a.get('/bad400', (c) => c.json({ error: 'invalid' }, 400));
    a.get('/has', (c) => c.json({ error: 'e', requestId: 'own' }, 500));
    return a;
  }

  it.each(['/raw500', '/raw500len', '/passthrough', '/503'])('%s gains the id, keeping status and fields', async (path) => {
    const res = await app().request(path);
    const id = res.headers.get(REQUEST_ID_HEADER);
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(body.requestId).toBe(id);
    expect(body.error).toBeTruthy();
    expect(res.headers.get('content-length')).toBeNull();
  });

  it('writes one correlation log line per 5xx (method, quoted path, status, id) and none for 4xx', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const a = app();
    const res = await a.request('/raw500');
    const id = res.headers.get(REQUEST_ID_HEADER)!;
    expect(log.mock.calls.map((c) => String(c[0]))).toContain(`[request] 500 GET "/raw500" request=${id}`);
    log.mockClear();
    await a.request('/bad400');
    expect(log).not.toHaveBeenCalled();
  });

  it('leaves non-JSON, array, 4xx and already-tagged bodies exactly as they were', async () => {
    const a = app();
    expect(await (await a.request('/text500')).text()).toBe('plain failure');
    expect(await (await a.request('/array500')).text()).toBe('[1,2]');
    expect(await (await a.request('/bad400')).json()).toEqual({ error: 'invalid' });
    expect(await (await a.request('/has')).json()).toEqual({ error: 'e', requestId: 'own' });
  });
});

describe('server/index.ts registration', () => {
  it('registers requestId on every path before the request boundary and any route', () => {
    const src = readFileSync(join(process.cwd(), 'server', 'index.ts'), 'utf-8');
    const use = src.indexOf("app.use('*', requestId);");
    expect(use).toBeGreaterThan(-1);
    expect(use).toBeLessThan(src.indexOf("app.use('/api/*', boundary);"));
    expect(use).toBeLessThan(src.search(/app\.(get|post|put|delete|route)\(/));
  });
});
