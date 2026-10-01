import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { accessAuthz } from '../../server/access-authz';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * W2 mount-order guard (Eric Live Phase 2).
 *
 * accessAuthz only protects what is registered AFTER it. Hono evaluates middleware and routes in
 * registration order, so a single `app.route('/api/...')` added above the accessAuthz line is
 * exempt from authorization — with no test failure, no type error, and no runtime symptom. On a
 * tunnelled server that is a silent, unauthenticated hole straight into the warehouse.
 *
 * The unit tests in access-authz.test.ts prove the middleware DENIES correctly. This proves it is
 * actually IN FRONT of every API route, by enumerating the real source rather than spot-checking a
 * couple of paths — the enumeration the Phase 2 plan's done bar requires.
 *
 * Asserted structurally against source text because the alternative (booting the server and
 * probing each route) needs a workbook, a warehouse DB, and network, none of which belong in a
 * unit test — and would test far less precisely than "is it registered before everything".
 */
const SOURCE = readFileSync(join(process.cwd(), 'server', 'index.ts'), 'utf8').split(/\r?\n/);

/** Lines that register an /api handler or sub-router (as opposed to bare middleware). */
function apiRouteLines(): { line: number; text: string }[] {
  const re = /^\s*app\.(route|get|post|put|patch|delete|all)\(\s*['"`]\/api/;
  return SOURCE.map((text, i) => ({ line: i + 1, text: text.trim() })).filter((l) => re.test(l.text));
}

/** The single line that BUILDS the gate: `const accessGate = accessAuthz(...)`. */
function accessAuthzBuildLines(): number[] {
  return SOURCE.map((text, i) => ({ text, line: i + 1 }))
    .filter(({ text }) => /^\s*const\s+accessGate\s*=\s*accessAuthz\s*\(/.test(text))
    .map(({ line }) => line);
}

/** Every `app.use(<path>, accessGate)` mount of that one instance, with its path. */
function accessGateMounts(): { line: number; path: string }[] {
  const re = /^\s*app\.use\(\s*['"`]([^'"`]+)['"`]\s*,\s*accessGate\s*\)/;
  return SOURCE.map((text, i) => ({ m: re.exec(text), line: i + 1 })).filter((x) => x.m !== null).map((x) => ({ line: x.line, path: x.m![1]! }));
}

/** Any OTHER accessAuthz(...) construction: a second instance would split the JWKS cache and could drift. */
function strayAccessAuthzCalls(): number[] {
  return SOURCE.map((text, i) => ({ text, line: i + 1 }))
    .filter(({ text }) => /accessAuthz\s*\(/.test(text) && !/^\s*(\/\/|\*|import)/.test(text) && !/const\s+accessGate\s*=/.test(text))
    .map(({ line }) => line);
}

const mountLine = (path: string): number => accessGateMounts().find((m) => m.path === path)?.line ?? -1;

describe('W2 — accessAuthz mount order in server/index.ts', () => {
  it('builds the gate exactly once and has no other accessAuthz(...) construction', () => {
    expect(accessAuthzBuildLines()).toHaveLength(1);
    expect(strayAccessAuthzCalls()).toEqual([]);
  });

  it('mounts that one gate on /api/* exactly once', () => {
    expect(accessGateMounts().filter((m) => m.path === '/api/*')).toHaveLength(1);
  });

  // cc-audit-army 2026-09-28 (sse-bypasses-access-authz): /sse lives OUTSIDE /api/* and streams the same
  // confidential BrainState, so /api/*-only gating left it behind the host/origin boundary alone.
  it('ALSO mounts the SAME gate on /sse exactly once, before the /sse route is registered', () => {
    expect(accessGateMounts().filter((m) => m.path === '/sse')).toHaveLength(1);
    const sseRoute = SOURCE.findIndex((t) => /^\s*app\.get\(\s*['"`]\/sse['"`]/.test(t)) + 1;
    expect(sseRoute).toBeGreaterThan(0);
    expect(mountLine('/sse')).toBeGreaterThan(0);
    expect(mountLine('/sse')).toBeLessThan(sseRoute);
  });

  it('builds the gate before mounting it', () => {
    expect(accessAuthzBuildLines()[0]!).toBeLessThan(mountLine('/api/*'));
  });

  it('finds the API routes it is meant to guard (the scan itself is not silently empty)', () => {
    // A regex that matched nothing would make the ordering assertion below vacuously pass.
    expect(apiRouteLines().length).toBeGreaterThan(5);
  });

  it('registers EVERY /api route after the authorization middleware', () => {
    const mount = mountLine('/api/*');
    const early = apiRouteLines().filter((r) => r.line < mount);
    expect(
      early,
      `These /api routes are registered BEFORE accessAuthz (line ${mount}) and are therefore ` +
        `UNAUTHORIZED when ACCESS_REQUIRE=1:\n` +
        early.map((r) => `  server/index.ts:${r.line}  ${r.text}`).join('\n'),
    ).toEqual([]);
  });
});

// Behavior, not just structure: an enabled gate on /sse must refuse an unauthenticated stream BEFORE the
// handler runs (a handler that ran would already have written confidential state to the socket).
describe('accessAuthz on /sse (behavioral)', () => {
  const app = new Hono();
  let handlerRan = false;
  const gate = accessAuthz({ enabled: true, issuer: 'https://example.cloudflareaccess.com', audience: 'aud', allowlist: ['a@example.test'], fetchJwks: async () => [] });
  app.use('/sse', gate);
  app.get('/sse', (c) => streamSSE(c, async (stream) => { handlerRan = true; await stream.writeSSE({ event: 'state', data: 'confidential' }); }));

  it('403s a request with no Cf-Access-Jwt-Assertion and never runs the stream handler', async () => {
    const res = await app.request('/sse');
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain('confidential');
    expect(handlerRan).toBe(false);
  });

  it('denies a garbage assertion too (not just a missing one)', async () => {
    const res = await app.request('/sse', { headers: { 'Cf-Access-Jwt-Assertion': 'not.a.jwt' } });
    expect(res.status).toBeGreaterThanOrEqual(400); // denied (403 bad token, or 503 when the key set is unusable): never 200
    expect(await res.text()).not.toContain('confidential');
    expect(handlerRan).toBe(false);
  });
});
