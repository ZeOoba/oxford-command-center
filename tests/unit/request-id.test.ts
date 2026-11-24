// @vitest-environment node
// Review round 2 (2026-11-24): request ids, so a 500 on screen can be matched to its server log line.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { acceptRequestId, requestId, requestIdOf, REQUEST_ID_HEADER } from '../../server/request-id';
import { jsonErrorHandler, warehouseJsonError } from '../../server/warehouse/json-errors';

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

describe('server/index.ts registration', () => {
  it('registers requestId on every path before the request boundary and any route', () => {
    const src = readFileSync(join(process.cwd(), 'server', 'index.ts'), 'utf-8');
    const use = src.indexOf("app.use('*', requestId);");
    expect(use).toBeGreaterThan(-1);
    expect(use).toBeLessThan(src.indexOf("app.use('/api/*', boundary);"));
    expect(use).toBeLessThan(src.search(/app\.(get|post|put|delete|route)\(/));
  });
});
