import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  createTokenBucket,
  retryAfterSeconds,
  createConcurrencyGate,
  holdUntilSettled,
  createRateLimiter,
  createConcurrencyLimiter,
  RATE_LIMITED_BODY,
} from '../../server/rate-limit';

/**
 * OI-090 (OWASP LLM10, unbounded consumption) — the limiter's OWN logic, isolated from the server.
 * Companion to server-rate-limit.test.ts, which proves the middleware is actually in front of the
 * three spend-bearing routes in server/index.ts. Every clock here is INJECTED (the server-side
 * convention — access-authz's nowSeconds, brief/run's now) rather than vi.useFakeTimers: nothing in
 * these assertions may depend on how fast the test box is.
 */
const MINUTE = 60_000;

function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms), set: (ms: number) => (t = ms) };
}

describe('createTokenBucket — refill / consume boundaries', () => {
  it('starts full and grants exactly `capacity` tokens with no time passing', () => {
    const c = clock();
    const b = createTokenBucket({ capacity: 5, refillIntervalMs: MINUTE, now: c.now });
    for (let i = 0; i < 5; i++) expect(b.tryConsume()).toEqual({ ok: true });
    expect(b.available()).toBe(0);
  });

  it('rejects the (capacity + 1)th request and quotes the wait for ONE token, not a full refill', () => {
    const c = clock();
    const b = createTokenBucket({ capacity: 5, refillIntervalMs: MINUTE, now: c.now });
    for (let i = 0; i < 5; i++) b.tryConsume();
    // 5 tokens per 60s → one token every 12s.
    expect(b.tryConsume()).toEqual({ ok: false, retryAfterMs: 12_000 });
  });

  it('is still empty a hair before the next token accrues, and grants exactly one on the boundary', () => {
    const c = clock();
    const b = createTokenBucket({ capacity: 5, refillIntervalMs: MINUTE, now: c.now });
    for (let i = 0; i < 5; i++) b.tryConsume();
    c.advance(11_999);
    expect(b.tryConsume()).toEqual({ ok: false, retryAfterMs: 1 });
    c.advance(1);
    expect(b.tryConsume()).toEqual({ ok: true });
    expect(b.tryConsume().ok).toBe(false); // exactly one, not two
  });

  it('refills to capacity over the full interval and never above it (a long idle is not a bigger burst)', () => {
    const c = clock();
    const b = createTokenBucket({ capacity: 5, refillIntervalMs: MINUTE, now: c.now });
    for (let i = 0; i < 5; i++) b.tryConsume();
    c.advance(MINUTE * 10);
    expect(b.available()).toBe(5);
    for (let i = 0; i < 5; i++) expect(b.tryConsume().ok).toBe(true);
    expect(b.tryConsume().ok).toBe(false);
  });

  it('refills continuously (a partial interval yields a partial token), and a fraction is not a grant', () => {
    const c = clock();
    const b = createTokenBucket({ capacity: 10, refillIntervalMs: MINUTE, now: c.now });
    for (let i = 0; i < 10; i++) b.tryConsume();
    c.advance(3_000); // half of a 6s token
    expect(b.available()).toBeCloseTo(0.5, 9);
    expect(b.tryConsume()).toEqual({ ok: false, retryAfterMs: 3_000 });
  });

  it('a clock that goes backwards (NTP step, Modern Standby resume) grants nothing and does not corrupt the bucket', () => {
    const c = clock(1_000_000);
    const b = createTokenBucket({ capacity: 3, refillIntervalMs: MINUTE, now: c.now });
    for (let i = 0; i < 3; i++) b.tryConsume();
    c.set(0);
    expect(b.tryConsume().ok).toBe(false);
    expect(b.available()).toBe(0);
    // Time resumes from the rewound point: refill is measured from there, not from the old stamp.
    c.advance(20_000);
    expect(b.tryConsume()).toEqual({ ok: true });
  });

  it.each([
    [{ capacity: 0, refillIntervalMs: MINUTE }],
    [{ capacity: -1, refillIntervalMs: MINUTE }],
    [{ capacity: 2.5, refillIntervalMs: MINUTE }],
    [{ capacity: Number.NaN, refillIntervalMs: MINUTE }],
    [{ capacity: Number.POSITIVE_INFINITY, refillIntervalMs: MINUTE }],
    [{ capacity: 5, refillIntervalMs: 0 }],
    [{ capacity: 5, refillIntervalMs: -1 }],
    [{ capacity: 5, refillIntervalMs: Number.NaN }],
    [{ capacity: 5, refillIntervalMs: Number.POSITIVE_INFINITY }],
  ])('refuses to construct a bucket that could never limit or never grant: %o', (opts) => {
    expect(() => createTokenBucket(opts)).toThrow();
  });

  it('two separately constructed buckets do not share state', () => {
    const c = clock();
    const a = createTokenBucket({ capacity: 2, refillIntervalMs: MINUTE, now: c.now });
    const b = createTokenBucket({ capacity: 2, refillIntervalMs: MINUTE, now: c.now });
    a.tryConsume();
    a.tryConsume();
    expect(a.tryConsume().ok).toBe(false);
    expect(b.available()).toBe(2);
    expect(b.tryConsume().ok).toBe(true);
  });
});

describe('retryAfterSeconds', () => {
  it('rounds UP to whole seconds and never advertises 0 (a client that retries immediately is still refused)', () => {
    expect(retryAfterSeconds(1)).toBe(1);
    expect(retryAfterSeconds(999)).toBe(1);
    expect(retryAfterSeconds(1_000)).toBe(1);
    expect(retryAfterSeconds(1_001)).toBe(2);
    expect(retryAfterSeconds(12_000)).toBe(12);
    expect(retryAfterSeconds(0)).toBe(1);
  });
});

describe('createConcurrencyGate', () => {
  it('hands out exactly `max` slots and refuses the next', () => {
    const g = createConcurrencyGate({ max: 3 });
    const r1 = g.tryAcquire();
    const r2 = g.tryAcquire();
    const r3 = g.tryAcquire();
    expect([r1, r2, r3].every((r) => typeof r === 'function')).toBe(true);
    expect(g.active()).toBe(3);
    expect(g.tryAcquire()).toBeNull();
  });

  it('a release frees exactly one slot, and releasing twice does not free two (idempotent)', () => {
    const g = createConcurrencyGate({ max: 1 });
    const release = g.tryAcquire()!;
    expect(g.tryAcquire()).toBeNull();
    release();
    release(); // second call must be a no-op, or the count goes negative and the gate stops gating
    expect(g.active()).toBe(0);
    expect(g.tryAcquire()).not.toBeNull();
    expect(g.tryAcquire()).toBeNull();
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('refuses max=%s', (max) => {
    expect(() => createConcurrencyGate({ max })).toThrow();
  });

  it('two gates do not share a counter', () => {
    const a = createConcurrencyGate({ max: 1 });
    const b = createConcurrencyGate({ max: 1 });
    a.tryAcquire();
    expect(a.tryAcquire()).toBeNull();
    expect(b.tryAcquire()).not.toBeNull();
  });
});

/** A ReadableStream the test controls: push chunks, close, or error it at will. */
function controllable() {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  let cancelledWith: unknown = 'never';
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctl = c;
    },
    cancel(reason) {
      cancelledWith = reason;
    },
  });
  return {
    stream,
    push: (s: string) => ctl.enqueue(new TextEncoder().encode(s)),
    close: () => ctl.close(),
    error: (e: unknown) => ctl.error(e),
    cancelledWith: () => cancelledWith,
  };
}

describe('holdUntilSettled — the slot follows the response BODY, not the handler return', () => {
  it('releases exactly once when the body is read to completion, and only then', async () => {
    const src = controllable();
    let released = 0;
    const wrapped = holdUntilSettled(src.stream, () => released++);
    const reader = wrapped.getReader();
    src.push('a');
    expect((await reader.read()).done).toBe(false);
    expect(released).toBe(0); // still streaming — slot held
    src.close();
    expect((await reader.read()).done).toBe(true);
    expect(released).toBe(1);
  });

  it('releases when the source errors mid-stream, and surfaces the error to the consumer', async () => {
    const src = controllable();
    let released = 0;
    const reader = holdUntilSettled(src.stream, () => released++).getReader();
    src.error(new Error('upstream died'));
    await expect(reader.read()).rejects.toThrow('upstream died');
    expect(released).toBe(1);
  });

  it('releases on consumer cancel (client disconnect) AND forwards the cancel to the source', async () => {
    // Forwarding is load-bearing: @hono/node-server cancels the body reader on socket close, and
    // Hono's StreamingApi turns THAT cancel into stream.abort() → the route's AbortController. A
    // wrapper that swallowed cancel would leave runAgent burning tokens for a client that is gone.
    const src = controllable();
    let released = 0;
    const wrapped = holdUntilSettled(src.stream, () => released++);
    await wrapped.cancel('client gone');
    expect(released).toBe(1);
    expect(src.cancelledWith()).toBe('client gone');
  });

  it('passes bytes through unchanged', async () => {
    const src = controllable();
    const wrapped = holdUntilSettled(src.stream, () => {});
    src.push('hello ');
    src.push('world');
    src.close();
    expect(await new Response(wrapped).text()).toBe('hello world');
  });
});

/**
 * Middleware-level behavior on a minimal Hono app (in-process, no I/O — still a unit test). The
 * real mount composition with boundary/cors and the actual limits lives in server-rate-limit.test.ts.
 */
describe('createRateLimiter middleware', () => {
  function build(now: () => number) {
    const app = new Hono();
    let hits = 0;
    app.use('/x', createRateLimiter({ capacity: 2, refillIntervalMs: MINUTE, now }));
    app.get('/x', (c) => {
      hits++;
      return c.json({ ok: true });
    });
    return { app, hits: () => hits };
  }

  it('lets `capacity` requests through, then 429s with the repo error shape and a Retry-After', async () => {
    const c = clock();
    const t = build(c.now);
    expect((await t.app.request('/x')).status).toBe(200);
    expect((await t.app.request('/x')).status).toBe(200);
    const res = await t.app.request('/x');
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('30'); // 2 per 60s → one token per 30s
    expect(res.headers.get('Content-Type')).toContain('application/json');
    expect(await res.json()).toEqual(RATE_LIMITED_BODY);
    expect(RATE_LIMITED_BODY).toEqual({ ok: false, error: 'rate limited' });
    expect(t.hits()).toBe(2);
  });

  it('a request under the limit carries no Retry-After and is otherwise untouched', async () => {
    const t = build(clock().now);
    const res = await t.app.request('/x');
    expect(res.status).toBe(200);
    expect(res.headers.get('Retry-After')).toBeNull();
    expect(await res.json()).toEqual({ ok: true });
  });

  it('honors its own Retry-After: waiting the advertised seconds yields exactly one more grant', async () => {
    const c = clock();
    const t = build(c.now);
    await t.app.request('/x');
    await t.app.request('/x');
    const denied = await t.app.request('/x');
    c.advance(Number(denied.headers.get('Retry-After')) * 1000);
    expect((await t.app.request('/x')).status).toBe(200);
    expect((await t.app.request('/x')).status).toBe(429);
  });

  it('each factory call is an independent bucket', async () => {
    const c = clock();
    const app = new Hono();
    app.use('/a', createRateLimiter({ capacity: 1, refillIntervalMs: MINUTE, now: c.now }));
    app.use('/b', createRateLimiter({ capacity: 1, refillIntervalMs: MINUTE, now: c.now }));
    app.get('/a', (c) => c.text('a'));
    app.get('/b', (c) => c.text('b'));
    expect((await app.request('/a')).status).toBe(200);
    expect((await app.request('/a')).status).toBe(429);
    expect((await app.request('/b')).status).toBe(200);
  });
});

describe('createConcurrencyLimiter middleware', () => {
  it('releases the slot when the downstream handler returns normally (non-streaming body)', async () => {
    const app = new Hono();
    app.use('/x', createConcurrencyLimiter({ max: 1 }));
    app.get('/x', (c) => c.json({ ok: true }));
    const r1 = await app.request('/x');
    expect(r1.status).toBe(200);
    await r1.text(); // node-server always drains the body; the test must too
    expect((await app.request('/x')).status).toBe(200);
  });

  it('releases the slot when the downstream handler THROWS (Hono turns it into a 500)', async () => {
    const app = new Hono();
    app.use('/x', createConcurrencyLimiter({ max: 1 }));
    app.get('/x', () => {
      throw new Error('handler exploded');
    });
    app.get('/ok', (c) => c.text('fine'));
    const r1 = await app.request('/x');
    expect(r1.status).toBe(500);
    await r1.text();
    // Not leaked: the next request still gets the single slot.
    const r2 = await app.request('/x');
    expect(r2.status).toBe(500);
    await r2.text();
  });

  it('releases in finally when next() itself rejects (a non-Error throw that Hono does not convert)', async () => {
    const mw = createConcurrencyLimiter({ max: 1 });
    // Hand-built context: the middleware only touches c.res / c.header / c.json / c.req on the
    // REJECT path, which this test never reaches — it exercises the finally.
    const c = { res: new Response(null), req: { method: 'GET', path: '/x' } } as unknown as Parameters<typeof mw>[0];
    await expect(mw(c, async () => Promise.reject('not-an-Error'))).rejects.toBe('not-an-Error');
    // Slot must be free again: a second call reaches next() instead of 429ing.
    let reached = false;
    await mw(c, async () => {
      reached = true;
    });
    expect(reached).toBe(true);
  });

  it('releases in finally for a body-less response (204), where there is no stream to follow', async () => {
    const app = new Hono();
    app.use('/x', createConcurrencyLimiter({ max: 1 }));
    app.get('/x', (c) => c.body(null, 204));
    expect((await app.request('/x')).status).toBe(204);
    expect((await app.request('/x')).status).toBe(204);
  });

  it('holds the slot for the LIFETIME of an SSE stream, not just until the handler returns', async () => {
    const app = new Hono();
    let releaseStream!: () => void;
    const held = new Promise<void>((r) => (releaseStream = r));
    app.use('/sse', createConcurrencyLimiter({ max: 1 }));
    app.post('/sse', (c) =>
      streamSSE(c, async (stream) => {
        await stream.writeSSE({ event: 'text', data: 'first' });
        await held;
        await stream.writeSSE({ event: 'done', data: 'bye' });
      }),
    );
    const first = await app.request('/sse', { method: 'POST' });
    expect(first.status).toBe(200); // handler HAS returned (streamSSE returns immediately) …
    const second = await app.request('/sse', { method: 'POST' });
    expect(second.status).toBe(429); // … but the slot is still held by the open stream
    expect(await second.json()).toEqual(RATE_LIMITED_BODY);
    expect(second.headers.get('Retry-After')).toMatch(/^\d+$/);
    releaseStream();
    expect(await first.text()).toContain('bye');
    const third = await app.request('/sse', { method: 'POST' });
    expect(third.status).toBe(200);
    await third.text();
  });
});
