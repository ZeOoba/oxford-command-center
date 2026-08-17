import { describe, it, expect } from 'vitest';
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

function accessAuthzMountLines(): number[] {
  return SOURCE.map((text, i) => ({ text, line: i + 1 }))
    .filter(({ text }) => /^\s*app\.use\(.*accessAuthz\s*\(/.test(text))
    .map(({ line }) => line);
}

describe('W2 — accessAuthz mount order in server/index.ts', () => {
  it('mounts accessAuthz exactly once', () => {
    expect(accessAuthzMountLines()).toHaveLength(1);
  });

  it('mounts it on the /api/* prefix', () => {
    const line = accessAuthzMountLines()[0]!;
    expect(SOURCE[line - 1]).toMatch(/app\.use\(\s*['"`]\/api\/\*['"`]/);
  });

  it('finds the API routes it is meant to guard (the scan itself is not silently empty)', () => {
    // A regex that matched nothing would make the ordering assertion below vacuously pass.
    expect(apiRouteLines().length).toBeGreaterThan(5);
  });

  it('registers EVERY /api route after the authorization middleware', () => {
    const mount = accessAuthzMountLines()[0]!;
    const early = apiRouteLines().filter((r) => r.line < mount);
    expect(
      early,
      `These /api routes are registered BEFORE accessAuthz (line ${mount}) and are therefore ` +
        `UNAUTHORIZED when ACCESS_REQUIRE=1:\n` +
        early.map((r) => `  server/index.ts:${r.line}  ${r.text}`).join('\n'),
    ).toEqual([]);
  });
});
