import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { isAllowedOrigin } from '../../server/cors-policy';
import { requestBoundary, allowedHosts } from '../../server/host-guard';
import { accessAuthz, accessAuthzOptionsFromEnv } from '../../server/access-authz';
import { createRateLimiter, createConcurrencyLimiter, RATE_LIMITED_BODY } from '../../server/rate-limit';
import { ORA_CLIENT_HEADER, ORA_CLIENT_HEADER_VALUE } from '../../src/contracts/client-header';

/**
 * OI-090 — consumption bounds on the three spend-bearing routes, at the level the finding asked
 * for: a real Hono app with the middleware stack mounted the way server/index.ts mounts it
 * (boundary → cors → accessAuthz → per-route, per-METHOD limiters → routes), with the SAME limits, probed with the request
 * shapes the web client actually sends. The limiter's own arithmetic lives in rate-limit.test.ts;
 * THIS file proves a rejected request never reaches the handler that would spend the money.
 *
 * Handler stand-ins count calls in place of runAgent / extractOmFields / searchDocuments — the
 * real ones need a workbook, an API key and a model download, none of which belong in a unit test,
 * and "was it called" is the whole question.
 */
const HOST_OK = 'localhost:8911';
const MINUTE = 60_000;
const WRITE_HEADERS = { host: HOST_OK, [ORA_CLIENT_HEADER]: ORA_CLIENT_HEADER_VALUE, 'content-type': 'application/json' };

function clock() {
  let t = 0;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

function buildApp(now: () => number) {
  const app = new Hono();
  let agentRuns = 0;
  let extracts = 0;
  let searches = 0;
  let aborts = 0;
  /** Resolvers for SSE streams parked in `hold` mode, in start order. */
  const parked: Array<() => void> = [];
  let hold = false;
  let explode = false;

  // Same mount order as server/index.ts: boundary → cors → accessAuthz → per-route limiters → routes.
  // accessAuthz is built from an EMPTY env, exactly as index.ts builds it when ACCESS_REQUIRE is
  // unset (localhost): a pass-through, mounted so the stack shape is faithful, not because it
  // decides anything here (its own behaviour lives in access-authz.test.ts).
  app.use('/api/*', requestBoundary({ allowedHosts: allowedHosts(8911) }));
  app.use('/api/*', cors({ origin: isAllowedOrigin }));
  app.use('/api/*', accessAuthz(accessAuthzOptionsFromEnv({})));
  // Method-scoped (app.on), as in index.ts — an app.use(path) mount is method-agnostic and would meter
  // requests no handler serves (see 'wrong-method requests …' below for what that cost).
  app.on(
    'POST',
    '/api/ai',
    createRateLimiter({ capacity: 10, refillIntervalMs: MINUTE, now }),
    createConcurrencyLimiter({ max: 3 }),
  );
  app.on('POST', '/api/actions/om-extract', createRateLimiter({ capacity: 5, refillIntervalMs: MINUTE, now }));
  app.on('GET', '/api/documents/search', createRateLimiter({ capacity: 90, refillIntervalMs: MINUTE, now }));

  app.post('/api/ai', (c) =>
    streamSSE(c, async (stream) => {
      agentRuns++;
      if (explode) throw new Error('agent blew up');
      const ac = new AbortController();
      ac.signal.addEventListener('abort', () => aborts++);
      stream.onAbort(() => ac.abort());
      await stream.writeSSE({ event: 'text', data: JSON.stringify({ type: 'text', delta: 'hi' }) });
      if (hold) await new Promise<void>((r) => parked.push(r));
      await stream.writeSSE({ event: 'done', data: JSON.stringify({ type: 'done' }) });
    }),
  );
  app.post('/api/actions/om-extract', (c) => {
    extracts++;
    return c.json({ ok: true, fields: {}, fieldCount: 0 });
  });
  app.get('/api/documents/search', (c) => {
    searches++;
    return c.json({ hits: [] });
  });

  const ai = (body: unknown = { question: 'q', history: [] }) =>
    app.request('/api/ai', { method: 'POST', headers: WRITE_HEADERS, body: JSON.stringify(body) });
  const omExtract = () => {
    const form = new FormData();
    form.append('file', new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'om.pdf', { type: 'application/pdf' }));
    return app.request('/api/actions/om-extract', {
      method: 'POST',
      headers: { host: HOST_OK, [ORA_CLIENT_HEADER]: ORA_CLIENT_HEADER_VALUE },
      body: form,
    });
  };
  const search = (q = 'lease') => app.request(`/api/documents/search?q=${q}`, { headers: { host: HOST_OK } });
  /**
   * A request with a method the route does NOT serve. Carries everything the boundary wants (a
   * non-safe method gets the client header) so the ONLY thing standing between it and the handler
   * is Hono's routing — a 403 here would mean the probe never got as far as the limiter mount.
   */
  const probe = (method: string, path: string) =>
    app.request(path, { method, headers: method === 'GET' || method === 'HEAD' ? { host: HOST_OK } : WRITE_HEADERS });

  return {
    app,
    ai,
    omExtract,
    search,
    probe,
    agentRuns: () => agentRuns,
    extracts: () => extracts,
    searches: () => searches,
    aborts: () => aborts,
    hold: (v: boolean) => (hold = v),
    explode: (v: boolean) => (explode = v),
    releaseOne: () => parked.shift()!(),
    releaseAll: () => {
      while (parked.length) parked.shift()!();
    },
  };
}

async function expectRateLimited(res: Response) {
  expect(res.status).toBe(429);
  expect(res.headers.get('Retry-After')).toMatch(/^\d+$/);
  expect(Number(res.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);
  expect(await res.json()).toEqual(RATE_LIMITED_BODY);
}

describe('/api/ai — 10 starts per minute', () => {
  it('serves 10 sequential agent turns, 429s the 11th, and runAgent is never entered for it', async () => {
    const t = buildApp(clock().now);
    for (let i = 0; i < 10; i++) {
      const res = await t.ai();
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('"type":"done"'); // drain: a finished stream frees its slot
    }
    expect(t.agentRuns()).toBe(10);
    await expectRateLimited(await t.ai());
    expect(t.agentRuns()).toBe(10);
  });

  it('Retry-After is honest: waiting exactly that long admits exactly one more turn', async () => {
    const c = clock();
    const t = buildApp(c.now);
    for (let i = 0; i < 10; i++) await (await t.ai()).text();
    const denied = await t.ai();
    expect(denied.status).toBe(429);
    const wait = Number(denied.headers.get('Retry-After'));
    expect(wait).toBeLessThanOrEqual(6); // 10/min → a token every 6s
    c.advance(wait * 1000);
    const ok = await t.ai();
    expect(ok.status).toBe(200);
    await ok.text();
    expect((await t.ai()).status).toBe(429);
  });

  it('a full minute of quiet restores the whole burst', async () => {
    const c = clock();
    const t = buildApp(c.now);
    for (let i = 0; i < 10; i++) await (await t.ai()).text();
    c.advance(MINUTE);
    for (let i = 0; i < 10; i++) {
      const res = await t.ai();
      expect(res.status).toBe(200);
      await res.text();
    }
    expect(t.agentRuns()).toBe(20);
  });

  it('a CORS preflight does not spend a token (cors() answers it before the limiter runs)', async () => {
    const t = buildApp(clock().now);
    for (let i = 0; i < 10; i++) {
      const pre = await t.app.request('/api/ai', {
        method: 'OPTIONS',
        headers: {
          host: HOST_OK,
          origin: 'http://localhost:5273',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': `content-type,${ORA_CLIENT_HEADER.toLowerCase()}`,
        },
      });
      expect(pre.status).toBe(204);
    }
    for (let i = 0; i < 10; i++) {
      const res = await t.ai();
      expect(res.status).toBe(200);
      await res.text();
    }
    expect(t.agentRuns()).toBe(10);
  });
});

describe('/api/ai — at most 3 concurrent streams', () => {
  it('429s the 4th stream while 3 are open, without entering runAgent', async () => {
    const t = buildApp(clock().now);
    t.hold(true);
    const open = [await t.ai(), await t.ai(), await t.ai()];
    expect(open.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(t.agentRuns()).toBe(3);
    await expectRateLimited(await t.ai());
    expect(t.agentRuns()).toBe(3);
    t.releaseAll();
    for (const r of open) await r.text();
  });

  it('a finished stream frees its slot for the next caller', async () => {
    const t = buildApp(clock().now);
    t.hold(true);
    const open = [await t.ai(), await t.ai(), await t.ai()];
    expect((await t.ai()).status).toBe(429);
    t.releaseOne();
    await open[0]!.text(); // the first stream runs to completion and is drained
    const next = await t.ai();
    expect(next.status).toBe(200);
    expect(t.agentRuns()).toBe(4);
    t.releaseAll();
    for (const r of [...open.slice(1), next]) await r.text();
  });

  it('a client that disconnects mid-stream frees its slot AND still aborts the agent (existing onAbort path intact)', async () => {
    const t = buildApp(clock().now);
    t.hold(true);
    const open = [await t.ai(), await t.ai(), await t.ai()];
    expect((await t.ai()).status).toBe(429);
    // What @hono/node-server does on socket close: cancel the response body reader.
    await open[0]!.body!.cancel('client went away');
    expect(t.aborts()).toBe(1);
    const next = await t.ai();
    expect(next.status).toBe(200);
    t.releaseAll();
    await next.text();
    for (const r of open.slice(1)) await r.text();
  });

  it('a handler that THROWS releases its slot — a 4th stream after 3 failures is NOT blocked (no leak)', async () => {
    const t = buildApp(clock().now);
    t.explode(true);
    for (let i = 0; i < 3; i++) {
      const res = await t.ai();
      // streamSSE's run() catches the throw and closes the stream; the HTTP status was already 200.
      expect(res.status).toBe(200);
      await res.text();
    }
    expect(t.agentRuns()).toBe(3);
    t.explode(false);
    const fourth = await t.ai();
    expect(fourth.status).toBe(200);
    expect(await fourth.text()).toContain('"type":"done"');
    expect(t.agentRuns()).toBe(4);
  });

  it('the rate limiter runs FIRST: a rate-limited request never takes (or leaks) a concurrency slot', async () => {
    const t = buildApp(clock().now);
    t.hold(true);
    const open = [await t.ai(), await t.ai(), await t.ai()]; // 3 slots held, 7 tokens left
    for (let i = 0; i < 7; i++) expect((await t.ai()).status).toBe(429); // concurrency 429s, spend tokens
    // Tokens are now 0; the concurrency gate is still full. Release everything …
    t.releaseAll();
    for (const r of open) await r.text();
    // … and the next request is refused by the RATE limiter, whose Retry-After is the 6s token wait,
    // proving the rejection came from the bucket and no slot accounting was disturbed.
    const res = await t.ai();
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('Retry-After'))).toBe(6);
  });
});

describe('/api/actions/om-extract — 5 uploads per minute', () => {
  it('accepts 5 uploads, 429s the 6th, and extractOmFields is never called for it (no Anthropic spend)', async () => {
    const t = buildApp(clock().now);
    for (let i = 0; i < 5; i++) {
      const res = await t.omExtract();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, fields: {}, fieldCount: 0 });
    }
    expect(t.extracts()).toBe(5);
    const denied = await t.omExtract();
    await expectRateLimited(denied);
    expect(t.extracts()).toBe(5);
  });

  it('the 429 body is the shape the upload client already parses (`ok` + `error`)', async () => {
    const t = buildApp(clock().now);
    for (let i = 0; i < 5; i++) await (await t.omExtract()).text();
    const body = (await (await t.omExtract()).json()) as { ok?: boolean; error?: string };
    // src/modules/acquisitions/acquisition-score.ts: `if (!res.ok || !data.ok) throw new OmExtractError(data.error ?? …)`
    expect(body.ok).toBe(false);
    expect(typeof body.error).toBe('string');
  });
});

describe('/api/documents/search — 90 queries per minute', () => {
  it('serves 90 searches, 429s the 91st, and the embedder is never invoked for it', async () => {
    const t = buildApp(clock().now);
    for (let i = 0; i < 90; i++) {
      const res = await t.search(`q${i}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ hits: [] });
    }
    expect(t.searches()).toBe(90);
    await expectRateLimited(await t.search('q91'));
    expect(t.searches()).toBe(90);
  });
});

describe('limits are per route — exhausting one never touches another', () => {
  it('an exhausted om-extract bucket leaves /api/ai and /api/documents/search untouched', async () => {
    const t = buildApp(clock().now);
    for (let i = 0; i < 5; i++) await (await t.omExtract()).text();
    expect((await t.omExtract()).status).toBe(429);
    const ai = await t.ai();
    expect(ai.status).toBe(200);
    await ai.text();
    expect((await t.search()).status).toBe(200);
  });

  it('an exhausted /api/ai bucket leaves om-extract and search untouched', async () => {
    const t = buildApp(clock().now);
    for (let i = 0; i < 10; i++) await (await t.ai()).text();
    expect((await t.ai()).status).toBe(429);
    expect((await t.omExtract()).status).toBe(200);
    expect((await t.search()).status).toBe(200);
  });
});

describe('no path spelling reaches the handler around the limiter', () => {
  // The limiter is registered on the literal path. If Hono matched the ROUTE on some variant the
  // MIDDLEWARE did not (or vice versa), that spelling would be an unmetered door. The invariant that
  // matters is not "each variant 404s" but "once the bucket is empty, no variant runs the handler".
  it.each(['/api/ai/', '/API/AI', '/api/%61i', '/api/./ai', '//api/ai', '/api//ai', '/api/ai?x=1', '/api/ai#frag'])(
    'exhausted bucket + %s → runAgent is not entered',
    async (path) => {
      const t = buildApp(clock().now);
      for (let i = 0; i < 10; i++) await (await t.ai()).text();
      expect(t.agentRuns()).toBe(10);
      const res = await t.app.request(path, { method: 'POST', headers: WRITE_HEADERS, body: '{}' });
      expect([404, 429]).toContain(res.status);
      await res.text();
      expect(t.agentRuns()).toBe(10);
    },
  );
});

/**
 * REFUTE finding on the first cut, which mounted the limiters with app.use(path, …). app.use is
 * method-agnostic: GET /api/ai matched the limiter chain, spent a token, then 404'd because no
 * handler serves GET there — a free drain of the rate budget. Worse, Hono answers HEAD by routing
 * it as GET and returning `new Response(null, res)`: the wrapped body that carried the concurrency
 * slot was discarded unread, so three unauthenticated `HEAD /api/ai` (HEAD is a safe method — the
 * boundary asks nothing of it) pinned the gate at 3-in-flight until restart. Reproduced against a
 * real @hono/node-server. The fix is app.on(METHOD, path, …) so a wrong-method request never enters
 * the chain; these tests hold the line.
 */
describe('wrong-method requests never enter the limiter chain', () => {
  it('HEAD /api/ai ×3 does NOT poison the concurrency gate — the next POST streams and runAgent runs', async () => {
    const t = buildApp(clock().now);
    for (let i = 0; i < 3; i++) {
      const res = await t.probe('HEAD', '/api/ai');
      expect(res.status).toBe(404);
      expect(await res.text()).toBe(''); // body-less, as HEAD must be — nothing here could ever be read
    }
    expect(t.agentRuns()).toBe(0);
    const post = await t.ai();
    expect(post.status).toBe(200);
    expect(await post.text()).toContain('"type":"done"');
    expect(t.agentRuns()).toBe(1);
  });

  it('even 10 HEADs (more than max-3) leave all three slots free', async () => {
    const t = buildApp(clock().now);
    for (let i = 0; i < 10; i++) expect((await t.probe('HEAD', '/api/ai')).status).toBe(404);
    t.hold(true);
    const open = [await t.ai(), await t.ai(), await t.ai()];
    expect(open.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(t.agentRuns()).toBe(3);
    t.releaseAll();
    for (const r of open) await r.text();
  });

  it('GET /api/ai does not spend a token — the full 10-turn budget survives 10 wrong-method probes', async () => {
    const t = buildApp(clock().now);
    for (let i = 0; i < 10; i++) expect((await t.probe('GET', '/api/ai')).status).toBe(404);
    expect(t.agentRuns()).toBe(0);
    for (let i = 0; i < 10; i++) {
      const res = await t.ai();
      expect(res.status, `legitimate POST #${i + 1} was refused after wrong-method probes`).toBe(200);
      await res.text();
    }
    expect(t.agentRuns()).toBe(10);
    expect((await t.ai()).status).toBe(429); // and the bucket itself still limits
  });

  it('GET /api/actions/om-extract does not spend a token — the full 5-upload budget survives', async () => {
    const t = buildApp(clock().now);
    for (let i = 0; i < 5; i++) expect((await t.probe('GET', '/api/actions/om-extract')).status).toBe(404);
    for (let i = 0; i < 5; i++) expect((await t.omExtract()).status).toBe(200);
    expect(t.extracts()).toBe(5);
    expect((await t.omExtract()).status).toBe(429);
  });

  it('POST /api/documents/search does not spend a token — the full 90-query budget survives', async () => {
    const t = buildApp(clock().now);
    for (let i = 0; i < 90; i++) expect((await t.probe('POST', '/api/documents/search')).status).toBe(404);
    for (let i = 0; i < 90; i++) expect((await t.search(`q${i}`)).status).toBe(200);
    expect(t.searches()).toBe(90);
    expect((await t.search('q91')).status).toBe(429);
  });

  it.each(['PUT', 'PATCH', 'DELETE'])('%s /api/ai is a plain 404 with no token spent and no slot taken', async (method) => {
    const t = buildApp(clock().now);
    for (let i = 0; i < 10; i++) expect((await t.probe(method, '/api/ai')).status).toBe(404);
    for (let i = 0; i < 10; i++) await (await t.ai()).text();
    expect(t.agentRuns()).toBe(10);
  });
});

/**
 * Belt-and-braces inside createConcurrencyLimiter itself, independent of how it is mounted: HEAD
 * never hands the slot to the body. Probed on a route that legitimately SERVES GET — so HEAD routes
 * to a real handler, produces a real body, and Hono then drops that body unread — which is the one
 * case the method-scoped mounts above cannot cover if a HEAD-served route is ever limited.
 */
describe('createConcurrencyLimiter — HEAD releases via finally, never via the (never-read) body', () => {
  function gated(max: number) {
    const app = new Hono();
    let hits = 0;
    app.use('/thing', createConcurrencyLimiter({ max }));
    app.get('/thing', (c) => {
      hits++;
      return c.text('a body Hono will strip for HEAD');
    });
    return { app, hits: () => hits };
  }

  it('HEAD ×3 on a GET route with max 1 leaves the slot free for the next GET', async () => {
    const { app, hits } = gated(1);
    for (let i = 0; i < 3; i++) {
      const res = await app.request('/thing', { method: 'HEAD' });
      expect(res.status).toBe(200); // HEAD reports GET's status …
      expect(await res.text()).toBe(''); // … with the body stripped — this is the unread body
    }
    expect(hits()).toBe(3);
    const get = await app.request('/thing');
    expect(get.status).toBe(200);
    expect(await get.text()).toBe('a body Hono will strip for HEAD');
    expect(hits()).toBe(4);
  });

  it('GET on the same route still holds its slot until the body is read (the guard is HEAD-only)', async () => {
    const { app } = gated(1);
    const first = await app.request('/thing');
    expect(first.status).toBe(200);
    expect((await app.request('/thing')).status).toBe(429); // body unread → slot held
    await first.text();
    expect((await app.request('/thing')).status).toBe(200); // drained → released
  });
});

describe('the boundary still runs first — a refused request is 403, not a spent token', () => {
  it('foreign-Host POSTs to /api/ai are 403 by the boundary and do not drain the bucket', async () => {
    const t = buildApp(clock().now);
    for (let i = 0; i < 10; i++) {
      const res = await t.app.request('/api/ai', {
        method: 'POST',
        headers: { ...WRITE_HEADERS, host: 'attacker.example:8911' },
        body: '{}',
      });
      expect(res.status).toBe(403);
    }
    for (let i = 0; i < 10; i++) {
      const res = await t.ai();
      expect(res.status).toBe(200);
      await res.text();
    }
    expect(t.agentRuns()).toBe(10);
  });
});

/**
 * Mount guard, in the style of access-authz-mount.test.ts / server-boundary.test.ts: the limiters
 * only protect what is registered after them, and only with the limits the finding ratified.
 * Asserted against the real source so a reordered line, a shared limiter instance, or a quietly
 * loosened number cannot land without a test failing.
 */
describe('OI-090 — limiter mounts in server/index.ts', () => {
  const SOURCE = readFileSync(join(process.cwd(), 'server', 'index.ts'), 'utf8').split(/\r?\n/);
  const lines = (re: RegExp) =>
    SOURCE.map((text, i) => ({ text: text.trim(), line: i + 1 })).filter(({ text }) => re.test(text));
  const only = (re: RegExp, what: string) => {
    const found = lines(re);
    expect(found, `expected exactly one line matching ${what}`).toHaveLength(1);
    return found[0]!;
  };

  // Every top-level app.use(...) / app.on(...) statement, a multi-line one joined so the whole
  // statement can be matched.
  const statements = (() => {
    const src = SOURCE.join('\n');
    const out: Array<{ text: string; line: number }> = [];
    const re = /^app\.(?:use|on)\(([\s\S]*?)\);$/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      // Collapse whitespace, including the newline+indent after `(` and before `)` that a multi-line
      // mount carries, so `app.on(\n  'POST',\n  '/api/ai',\n …\n);` reads as `app.on('POST', '/api/ai', …);`.
      const text = m[0].replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')');
      out.push({ text, line: src.slice(0, m.index).split('\n').length });
    }
    return out;
  })();
  /** The limiter routes and the ONE method each actually serves — the mount must name that method. */
  const LIMITED: ReadonlyArray<{ method: 'GET' | 'POST'; path: string }> = [
    { method: 'POST', path: '/api/ai' },
    { method: 'POST', path: '/api/actions/om-extract' },
    { method: 'GET', path: '/api/documents/search' },
  ];
  const stmt = (path: string) => {
    const { method } = LIMITED.find((r) => r.path === path)!;
    const found = statements.filter((s) => s.text.startsWith(`app.on('${method}', '${path}',`));
    expect(found, `expected exactly one app.on('${method}', '${path}', …) statement`).toHaveLength(1);
    return found[0]!;
  };

  const boundaryMount = () => only(/^app\.use\(\s*['"`]\/api\/\*['"`]\s*,\s*boundary\s*\)/, 'the /api/* boundary mount');
  const corsMount = () => only(/^app\.use\(.*\bcors\s*\(/, 'the cors() mount');
  const authzMount = () => only(/^app\.use\(\s*['"`]\/api\/\*['"`]\s*,\s*accessGate\s*\)/, 'the accessAuthz mount (the shared accessGate on /api/*)');

  it('mounts a fresh 10/min bucket AND a fresh max-3 gate on POST /api/ai, in that order', () => {
    const s = stmt('/api/ai');
    expect(s.text).toMatch(/createRateLimiter\(\{ capacity: 10, refillIntervalMs: 60_000 \}\)/);
    expect(s.text).toMatch(/createConcurrencyLimiter\(\{ max: 3 \}\)/);
    expect(s.text.indexOf('createRateLimiter')).toBeLessThan(s.text.indexOf('createConcurrencyLimiter'));
  });

  it('mounts a fresh 5/min bucket on POST /api/actions/om-extract', () => {
    expect(stmt('/api/actions/om-extract').text).toMatch(
      /createRateLimiter\(\{ capacity: 5, refillIntervalMs: 60_000 \}\)/,
    );
  });

  it('mounts a fresh 90/min bucket on GET /api/documents/search', () => {
    expect(stmt('/api/documents/search').text).toMatch(
      /createRateLimiter\(\{ capacity: 90, refillIntervalMs: 60_000 \}\)/,
    );
  });

  it('never mounts a limiter method-agnostically — no app.use(...) statement carries one (the HEAD/GET drain)', () => {
    const agnostic = statements.filter((s) => s.text.startsWith('app.use(') && /create(RateLimiter|ConcurrencyLimiter)\(/.test(s.text));
    expect(agnostic, 'app.use is method-agnostic: a wrong-method request would spend a token / pin a slot').toEqual([]);
    for (const { path } of LIMITED) {
      expect(statements.filter((s) => s.text.startsWith(`app.use('${path}'`))).toEqual([]);
    }
  });

  it('never hoists a limiter into a shared variable (a reused instance would double-count across routes)', () => {
    expect(lines(/^(const|let|var)\s+\w+\s*=\s*create(RateLimiter|ConcurrencyLimiter)\(/)).toEqual([]);
    expect(lines(/create(RateLimiter|ConcurrencyLimiter)\(/).length).toBe(4);
  });

  it('mounts every limiter AFTER boundary, cors and accessAuthz', () => {
    const floor = Math.max(boundaryMount().line, corsMount().line, authzMount().line);
    for (const { path } of LIMITED) {
      expect(stmt(path).line, `${path} limiter must be mounted after line ${floor}`).toBeGreaterThan(floor);
    }
  });

  it('mounts every limiter BEFORE the route it guards, on the SAME method the route registers', () => {
    const route = (re: RegExp, what: string) => only(re, what).line;
    // The method in the mount is cross-checked against the verb of the route registration itself
    // (app.post / app.get), so a mount on the wrong method — which would guard nothing — cannot land.
    const verb = { GET: 'get', POST: 'post' } as const;
    for (const { method, path } of LIMITED) {
      const escaped = path.replace(/[/.]/g, '\\$&');
      const routeLine = route(new RegExp(`^app\\.${verb[method]}\\(\\s*['"\`]${escaped}['"\`]`), `${method} ${path}`);
      expect(stmt(path).line, `${method} ${path} limiter must be mounted before its route at line ${routeLine}`).toBeLessThan(routeLine);
    }
  });
});
