/**
 * Consumption bounds for the Brain Server's spend-bearing routes (OI-090, OWASP LLM10 — unbounded
 * consumption). Companion to host-guard.ts (who may call) and access-authz.ts (who is calling);
 * this file answers HOW OFTEN and HOW MANY AT ONCE.
 *
 * WHAT IS BOUNDED. Three routes already cap each request (25 MB upload, maxTurns:8 / max_tokens
 * 16000 per agent call, a 20-hit search cap) but nothing capped the CALL RATE, so a stuck client
 * loop, a runaway script, or a hostile same-machine process could start an unbounded number of
 * Anthropic-billed agent turns and OM extractions, or pin the CPU with embedding searches:
 *
 *   POST /api/ai                  — SSE agent loop, real Anthropic spend per START, and each open
 *                                   stream holds a model turn for its lifetime → rate AND concurrency.
 *   POST /api/actions/om-extract  — one Anthropic call per PDF → rate.
 *   GET  /api/documents/search    — local @huggingface/transformers embedding; CPU/memory-bound,
 *                                   not dollar-bound → rate, looser.
 *
 * WHY IN-PROCESS STATE. This is a single long-lived Node process serving one user on loopback (or
 * one Cloudflare tunnel). A per-process bucket is the correct scope — there is no second instance to
 * share with, and keying by client address would collapse to 127.0.0.1 for every caller anyway. No
 * KV, no Redis, no new dependency.
 *
 * TOKEN BUCKET, CONTINUOUS REFILL. A bucket of `capacity` tokens refills at capacity/refillIntervalMs
 * tokens per millisecond, never above capacity. "10 per minute" therefore means a burst of 10, then
 * one every 6 s — and Retry-After quotes the wait for the NEXT token, not a whole window, so a
 * well-behaved client that honors it is admitted on its next try (rate-limit.test.ts proves this).
 *
 * CONCURRENCY FOLLOWS THE RESPONSE BODY, NOT THE HANDLER. streamSSE() returns its Response at once
 * and runs the agent loop detached, so `await next()` resolves before runAgent has done anything;
 * a slot released there would gate nothing. The slot is instead handed to the response body and
 * released when that body settles — read to the end, errored, or cancelled by the client
 * (@hono/node-server cancels the body reader on socket close). The wrapper FORWARDS that cancel to
 * the inner stream, because Hono's StreamingApi turns it into stream.abort() → the route's existing
 * AbortController; swallowing it would leave runAgent spending tokens for a client that is gone.
 * The `finally` still covers every path with no body to follow (a throw out of next(), a 204), and
 * HEAD — Hono answers HEAD by routing it as GET and discarding the body unread, so a slot that
 * followed that body would never return; the wrapper releases in `finally` for HEAD instead.
 *
 * Pure decision objects + thin Hono wrappers, mirroring host-guard.ts, so the arithmetic is
 * unit-testable with an injected clock (tests/unit/rate-limit.test.ts) and the mounted behavior is
 * integration-tested against a real Hono app (tests/unit/server-rate-limit.test.ts). Mount each
 * limiter on its OWN route AND its own METHOD — `app.on('POST', path, …)`, never `app.use(path, …)`,
 * which is method-agnostic and would meter (and, for HEAD, pin) requests no handler serves — AFTER
 * boundary/cors/accessAuthz and BEFORE the route, constructing a fresh instance per mount: an
 * instance reused across routes would count them against one bucket.
 *
 * FAIL-LOUD ON CONFIGURATION. A capacity or interval that could never limit (Infinity, NaN) or
 * never grant (0, negative) throws at construction — i.e. at server boot — rather than mounting a
 * limiter that is silently inert. Denials log server-side and return an opaque body.
 */
import type { MiddlewareHandler } from 'hono';

/**
 * The 429 body. Matches the route-handler convention on the very routes this guards —
 * om-extract's `c.json({ ok: false, error: … }, status)` — which is the shape the upload client
 * already parses (`if (!res.ok || !data.ok) throw new OmExtractError(data.error ?? …)`), so a
 * rate-limited upload surfaces as a readable message rather than "Extraction failed (429)".
 * (host-guard/access-authz use the bare `{ error }` shape; those guard every route, this one sits
 * on three handlers whose own errors carry `ok`.)
 */
export const RATE_LIMITED_BODY = Object.freeze({ ok: false, error: 'rate limited' } as const);

function assertPositiveInteger(name: string, v: number): void {
  if (!Number.isInteger(v) || v <= 0) throw new Error(`[rate-limit] ${name} must be a positive integer, got ${v}`);
}
function assertPositiveFinite(name: string, v: number): void {
  if (!Number.isFinite(v) || v <= 0) throw new Error(`[rate-limit] ${name} must be a positive finite number, got ${v}`);
}

export interface TokenBucketOptions {
  /** Maximum burst — and the number of tokens that accrue over one full `refillIntervalMs`. */
  capacity: number;
  /** Milliseconds for an empty bucket to refill to `capacity` (so the per-token wait is interval/capacity). */
  refillIntervalMs: number;
  /** Injected clock (ms). Defaults to Date.now; tests pass a controlled one. */
  now?: () => number;
}

export type ConsumeResult = { ok: true } | { ok: false; retryAfterMs: number };

export interface TokenBucket {
  /** Take one token if available. On refusal, the wait until the next whole token accrues. */
  tryConsume(): ConsumeResult;
  /** Tokens available right now (fractional) — diagnostics and tests. */
  available(): number;
}

export function createTokenBucket(opts: TokenBucketOptions): TokenBucket {
  assertPositiveInteger('capacity', opts.capacity);
  assertPositiveFinite('refillIntervalMs', opts.refillIntervalMs);
  const now = opts.now ?? Date.now;
  const capacity = opts.capacity;
  const ratePerMs = capacity / opts.refillIntervalMs;
  let tokens = capacity;
  let stamp = now();

  const refill = (): void => {
    const t = now();
    // A rewound clock (NTP step, Modern Standby resume) must grant nothing and must not stall the
    // bucket forever: measure future refill from the rewound point.
    const elapsed = Math.max(0, t - stamp);
    stamp = t;
    tokens = Math.min(capacity, tokens + elapsed * ratePerMs);
  };

  return {
    tryConsume() {
      refill();
      if (tokens >= 1) {
        tokens -= 1;
        return { ok: true };
      }
      return { ok: false, retryAfterMs: Math.ceil((1 - tokens) / ratePerMs) };
    },
    available() {
      refill();
      return tokens;
    },
  };
}

/** Whole seconds for the Retry-After header — rounded UP, floor 1: `Retry-After: 0` invites an immediate retry. */
export function retryAfterSeconds(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}

export interface ConcurrencyGateOptions {
  /** Maximum simultaneously held slots. */
  max: number;
}

/** Idempotent: calling a release twice frees one slot, not two. */
export type Release = () => void;

export interface ConcurrencyGate {
  /** A release function if a slot was free, else null. */
  tryAcquire(): Release | null;
  active(): number;
}

export function createConcurrencyGate(opts: ConcurrencyGateOptions): ConcurrencyGate {
  assertPositiveInteger('max', opts.max);
  let active = 0;
  return {
    tryAcquire() {
      if (active >= opts.max) return null;
      active++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        active--;
      };
    },
    active: () => active,
  };
}

/**
 * Pass `body` through unchanged and call `release` exactly once when it settles — fully read,
 * errored, or cancelled by the consumer. A cancel is forwarded to the source (see header).
 */
export function holdUntilSettled(body: ReadableStream<Uint8Array>, release: Release): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let settled = false;
  const settle = (): void => {
    if (settled) return;
    settled = true;
    release();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (err) {
        if (!settled) {
          settle();
          controller.error(err);
        }
        return;
      }
      if (settled) return; // cancelled while the read was in flight — the consumer is gone
      if (chunk.done) {
        settle();
        controller.close();
        return;
      }
      controller.enqueue(chunk.value);
    },
    cancel(reason) {
      settle();
      return reader.cancel(reason).catch(() => undefined);
    },
  });
}

export type RateLimiterOptions = TokenBucketOptions;

/**
 * Hono middleware: one token per request on the mounted path; 429 + Retry-After when empty. Each
 * call owns a fresh bucket — mount one per route.
 */
export function createRateLimiter(opts: RateLimiterOptions): MiddlewareHandler {
  const bucket = createTokenBucket(opts);
  return async (c, next) => {
    const r = bucket.tryConsume();
    if (!r.ok) {
      const secs = retryAfterSeconds(r.retryAfterMs);
      console.warn(`[rate-limit] 429 rate on ${c.req.method} ${c.req.path} (retry in ${secs}s)`);
      c.header('Retry-After', String(secs));
      return c.json(RATE_LIMITED_BODY, 429);
    }
    return next();
  };
}

export interface ConcurrencyLimiterOptions extends ConcurrencyGateOptions {
  /** Retry-After hint on refusal. There is no exact figure — a slot frees when a stream ends. */
  retryAfterSeconds?: number;
}

/**
 * Hono middleware: at most `max` in-flight responses on the mounted path, where "in flight" lasts
 * until the response BODY settles (see header — streamSSE returns before the work is done). Each
 * call owns a fresh gate — mount one per route.
 */
export function createConcurrencyLimiter(opts: ConcurrencyLimiterOptions): MiddlewareHandler {
  const gate = createConcurrencyGate(opts);
  const hint = opts.retryAfterSeconds ?? 5;
  assertPositiveInteger('retryAfterSeconds', hint);
  return async (c, next) => {
    const release = gate.tryAcquire();
    if (!release) {
      console.warn(`[rate-limit] 429 concurrency on ${c.req.method} ${c.req.path} (${gate.active()} in flight)`);
      c.header('Retry-After', String(hint));
      return c.json(RATE_LIMITED_BODY, 429);
    }
    let handedOff = false;
    try {
      await next();
      const body = c.res.body;
      // HEAD never follows the body. Hono answers HEAD by dispatching the request as GET and then
      // building `new Response(null, res)` — the body the handler produced is DISCARDED, never read,
      // never cancelled, so a slot handed to it would never come back. This holds for a route that
      // is legitimately registered for HEAD too, so the guard is on the METHOD, not the path; the
      // method-scoped mounts in server/index.ts make it belt-and-braces, not the only defence.
      if (body && c.req.method !== 'HEAD') {
        c.res = new Response(holdUntilSettled(body, release), {
          status: c.res.status,
          statusText: c.res.statusText,
          headers: c.res.headers,
        });
        handedOff = true;
      }
    } finally {
      // Every exit with no body to follow — next() threw, a body-less response, or a HEAD whose body
      // Hono will drop — releases here. Once handed off, the body owns the release (idempotent
      // either way).
      if (!handedOff) release();
    }
  };
}
