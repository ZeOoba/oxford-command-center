import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { isAllowedOrigin } from '../../server/cors-policy';
import { requestBoundary, allowedHosts } from '../../server/host-guard';
import { ORA_CLIENT_HEADER, ORA_CLIENT_HEADER_VALUE } from '../../src/contracts/client-header';

/**
 * OI-050 — request-boundary regression test, at the level the audit asked for: a real Hono app
 * instance with the boundary mounted the way server/index.ts mounts it (boundary → cors → routes),
 * probed with the exact request shapes a hostile page can produce. The pure-function matrix lives
 * in host-guard.test.ts; THIS file proves the middleware actually stops the handler.
 *
 * Why `cors()` alone was not enough (the finding): Hono's cors() only decides what
 * Access-Control-Allow-Origin header to SET. It never rejects a request. A DNS-rebound page is
 * same-origin to the browser (no Origin header, no CORS at all) and a "simple" cross-site POST is
 * executed server-side before the browser withholds the response. Both reached the handlers.
 */
const HOST_OK = 'localhost:8911';
const HOST_FOREIGN = 'attacker.example:8911'; // what a DNS-rebound page actually sends as Host
const ORIGIN_DEV = 'http://localhost:5273'; // Vite dev server (proxies with changeOrigin: true)
const ORIGIN_FOREIGN = 'https://app.oxfordra.net.evil.invalid';

function buildApp() {
  const app = new Hono();
  let reads = 0;
  let writes = 0;
  let stage = 'initial';

  // Same mount order as server/index.ts. The boundary MUST come first.
  app.use('/api/*', requestBoundary({ allowedHosts: allowedHosts(8911) }));
  app.use('/api/*', cors({ origin: isAllowedOrigin }));

  app.get('/api/snapshot', (c) => {
    reads++;
    return c.json({ snapshot: { secret: 'full confidential portfolio' } });
  });
  app.post('/api/actions/deal-stage', async (c) => {
    writes++;
    const body = (await c.req.json().catch(() => ({}))) as { stage?: string };
    stage = body.stage ?? stage;
    return c.json({ ok: true });
  });

  return {
    app,
    reads: () => reads,
    writes: () => writes,
    stage: () => stage,
  };
}

describe('request boundary — DNS rebinding (foreign Host)', () => {
  it('403s a GET whose Host is not this server, and the handler never runs', async () => {
    const t = buildApp();
    const res = await t.app.request('/api/snapshot', { headers: { host: HOST_FOREIGN } });
    expect(res.status).toBe(403);
    expect(t.reads()).toBe(0);
    expect(await res.text()).not.toContain('confidential');
  });

  it('403s a request with NO Host header at all (fail-closed)', async () => {
    const t = buildApp();
    const res = await t.app.request('/api/snapshot');
    expect(res.status).toBe(403);
    expect(t.reads()).toBe(0);
  });

  it('403s a foreign-Host write even when it carries the client header and a localhost Origin', async () => {
    const t = buildApp();
    const res = await t.app.request('/api/actions/deal-stage', {
      method: 'POST',
      headers: {
        host: HOST_FOREIGN,
        origin: ORIGIN_DEV,
        [ORA_CLIENT_HEADER]: ORA_CLIENT_HEADER_VALUE,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ stage: 'hijacked' }),
    });
    expect(res.status).toBe(403);
    expect(t.writes()).toBe(0);
    expect(t.stage()).toBe('initial');
  });

  it('serves a plain same-origin GET with the right Host (the localhost dev path is unchanged)', async () => {
    const t = buildApp();
    const res = await t.app.request('/api/snapshot', { headers: { host: HOST_OK } });
    expect(res.status).toBe(200);
    expect(t.reads()).toBe(1);
  });
});

describe('request boundary — foreign Origin on a write', () => {
  it('403s a POST with a foreign Origin and leaves state untouched (not merely un-CORSed)', async () => {
    const t = buildApp();
    const res = await t.app.request('/api/actions/deal-stage', {
      method: 'POST',
      headers: {
        host: HOST_OK,
        origin: ORIGIN_FOREIGN,
        [ORA_CLIENT_HEADER]: ORA_CLIENT_HEADER_VALUE,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ stage: 'hijacked' }),
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(t.writes()).toBe(0);
    expect(t.stage()).toBe('initial');
  });

  it('403s a foreign-Origin GET too — the response must not even be computed', async () => {
    const t = buildApp();
    const res = await t.app.request('/api/snapshot', { headers: { host: HOST_OK, origin: ORIGIN_FOREIGN } });
    expect(res.status).toBe(403);
    expect(t.reads()).toBe(0);
  });
});

describe('request boundary — simple cross-site POST (no preflight)', () => {
  it('403s a POST missing the client header — the text/plain "simple request" shape', async () => {
    const t = buildApp();
    // No Origin (a same-origin-looking rebound page, or a non-browser client), no custom header,
    // text/plain body: exactly the shape a browser sends WITHOUT a preflight.
    const res = await t.app.request('/api/actions/deal-stage', {
      method: 'POST',
      headers: { host: HOST_OK, 'content-type': 'text/plain' },
      body: JSON.stringify({ stage: 'hijacked' }),
    });
    expect(res.status).toBe(403);
    expect(t.writes()).toBe(0);
    expect(t.stage()).toBe('initial');
  });

  it('403s a POST missing the client header even with application/json and a localhost Origin', async () => {
    const t = buildApp();
    const res = await t.app.request('/api/actions/deal-stage', {
      method: 'POST',
      headers: { host: HOST_OK, origin: ORIGIN_DEV, 'content-type': 'application/json' },
      body: JSON.stringify({ stage: 'hijacked' }),
    });
    expect(res.status).toBe(403);
    expect(t.writes()).toBe(0);
  });

  it('serves a legitimate first-party write: right Host, localhost Origin, client header present', async () => {
    const t = buildApp();
    const res = await t.app.request('/api/actions/deal-stage', {
      method: 'POST',
      headers: {
        host: HOST_OK,
        origin: ORIGIN_DEV,
        [ORA_CLIENT_HEADER]: ORA_CLIENT_HEADER_VALUE,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ stage: 'loi' }),
    });
    expect(res.status).toBe(200);
    expect(t.writes()).toBe(1);
    expect(t.stage()).toBe('loi');
  });

  it('serves a first-party write with NO Origin header (same-origin POST from a non-Origin-sending client)', async () => {
    const t = buildApp();
    const res = await t.app.request('/api/actions/deal-stage', {
      method: 'POST',
      headers: { host: HOST_OK, [ORA_CLIENT_HEADER]: ORA_CLIENT_HEADER_VALUE, 'content-type': 'application/json' },
      body: JSON.stringify({ stage: 'loi' }),
    });
    expect(res.status).toBe(200);
    expect(t.stage()).toBe('loi');
  });
});

describe('request boundary — CORS preflight interplay', () => {
  it('lets a localhost preflight through to cors(), which reflects the custom header as allowed', async () => {
    const t = buildApp();
    const res = await t.app.request('/api/actions/deal-stage', {
      method: 'OPTIONS',
      headers: {
        host: HOST_OK,
        origin: ORIGIN_DEV,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': `content-type,${ORA_CLIENT_HEADER.toLowerCase()}`,
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN_DEV);
    expect(res.headers.get('Access-Control-Allow-Headers')?.toLowerCase()).toContain(ORA_CLIENT_HEADER.toLowerCase());
  });

  it('refuses a foreign preflight outright (403, no Access-Control-Allow-Origin)', async () => {
    const t = buildApp();
    const res = await t.app.request('/api/actions/deal-stage', {
      method: 'OPTIONS',
      headers: {
        host: HOST_OK,
        origin: ORIGIN_FOREIGN,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': ORA_CLIENT_HEADER.toLowerCase(),
      },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

describe('request boundary — response hygiene', () => {
  it('does not echo the offending Host or Origin in the 403 body', async () => {
    const t = buildApp();
    const res = await t.app.request('/api/snapshot', { headers: { host: HOST_FOREIGN, origin: ORIGIN_FOREIGN } });
    const body = await res.text();
    expect(body).not.toContain('attacker.example');
    expect(body).not.toContain('evil.invalid');
  });
});

/**
 * Mount-order guard, in the style of access-authz-mount.test.ts: the boundary only protects what is
 * registered after it. Asserted against the real source so a future `app.route` or a reordered
 * `cors()` line cannot silently move ahead of the check.
 */
describe('OI-050 — requestBoundary mount order in server/index.ts', () => {
  const SOURCE = readFileSync(join(process.cwd(), 'server', 'index.ts'), 'utf8').split(/\r?\n/);
  const lines = (re: RegExp) =>
    SOURCE.map((text, i) => ({ text: text.trim(), line: i + 1 })).filter(({ text }) => re.test(text));

  const boundaryApiMount = () => lines(/^app\.use\(\s*['"`]\/api\/\*['"`]\s*,\s*boundary\s*\)/);
  const boundarySseMount = () => lines(/^app\.use\(\s*['"`]\/sse['"`]\s*,\s*boundary\s*\)/);
  const corsMount = () => lines(/^app\.use\(.*\bcors\s*\(/);
  const authzMount = () => lines(/^app\.use\(.*accessAuthz\s*\(/);
  const apiRoutes = () => lines(/^app\.(route|get|post|put|patch|delete|all)\(\s*['"`]\/api/);
  const sseRoute = () => lines(/^app\.get\(\s*['"`]\/sse['"`]/);

  it('mounts the boundary exactly once on /api/* and once on /sse', () => {
    expect(boundaryApiMount()).toHaveLength(1);
    expect(boundarySseMount()).toHaveLength(1);
  });

  it('mounts the boundary BEFORE cors() and BEFORE accessAuthz', () => {
    const b = boundaryApiMount()[0]!.line;
    expect(corsMount()).toHaveLength(1);
    expect(authzMount()).toHaveLength(1);
    expect(b).toBeLessThan(corsMount()[0]!.line);
    expect(b).toBeLessThan(authzMount()[0]!.line);
  });

  it('registers EVERY /api route and the /sse route after the boundary', () => {
    expect(apiRoutes().length).toBeGreaterThan(5); // the scan itself is not vacuous
    expect(sseRoute()).toHaveLength(1);
    const b = boundaryApiMount()[0]!.line;
    const early = apiRoutes().filter((r) => r.line < b);
    expect(early, `routes registered BEFORE the boundary:\n${early.map((r) => `  server/index.ts:${r.line}  ${r.text}`).join('\n')}`).toEqual([]);
    expect(sseRoute()[0]!.line).toBeGreaterThan(boundarySseMount()[0]!.line);
  });
});
