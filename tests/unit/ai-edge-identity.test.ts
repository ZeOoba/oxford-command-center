// @vitest-environment node
// tests/unit/ai-edge-identity.test.ts
//
// functions/api/ai.ts keyed its per-identity rate limit on the forgeable
// Cf-Access-Authenticated-User-Email header, so a caller that bypasses Access could rotate the header
// for an unlimited budget (or pin a victim's bucket). The key must come from the VERIFIED Access JWT
// (functions/_shared/access-identity.ts, the same path whoami uses), fail closed when ACCESS_REQUIRE=1
// and verification fails, and in inert mode fall back to the CF-Connecting-IP — never the header.
// Synthetic RSA keys, issuer and AUD throughout.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import {
  RATE_LIMIT_MAX,
  handleAiPost,
  onRequestPost,
  rateLimitKeyForIp,
  resetAiIdentityCache,
  resetRateLimit,
  type AiDeps,
} from '../../functions/api/ai';
import type { Jwk } from '../../functions/_shared/access-jwt';
import { runAgent } from '../../server/ai/agent';

vi.mock('../../server/ai/agent', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, runAgent: vi.fn(async (opts: { emit: (e: unknown) => unknown }) => { await opts.emit({ type: 'done', model: 'stub', refs: [] }); }) };
});

const ISSUER = 'https://example-team.cloudflareaccess.com';
const AUDIENCE = 'synthetic-aud-tag';
const NOW = 1_780_000_000;
const ACCESS = { ACCESS_REQUIRE: '1', ACCESS_ISSUER: ISSUER, ACCESS_AUD: AUDIENCE };

let privateKey: KeyObject;
let jwks: Jwk[];

const b64url = (input: Buffer | string) =>
  Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function sign(payload: Record<string, unknown>): string {
  const input = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'kid-1' }))}.${b64url(JSON.stringify(payload))}`;
  const signer = createSign('RSA-SHA256');
  signer.update(input);
  return `${input}.${b64url(signer.sign(privateKey))}`;
}
const token = (email: string, over: Record<string, unknown> = {}) =>
  sign({ iss: ISSUER, aud: [AUDIENCE], email, exp: NOW + 3600, nbf: NOW - 10, ...over });

let fetchJwks: ReturnType<typeof vi.fn<AiDeps['fetchJwks']>>;
const deps = (): AiDeps => ({ fetchJwks, nowSeconds: () => NOW });

function ctx(headers: Record<string, string>, env: Record<string, string> = {}) {
  const request = new Request('https://mirror.test/api/ai', { method: 'POST', body: JSON.stringify({ question: 'q' }), headers });
  return {
    request,
    env: { ...env, ASSETS: { fetch: async () => new Response('nope', { status: 404 }) } },
  } as unknown as Parameters<typeof handleAiPost>[0];
}

async function exhaust(headers: Record<string, string>, env: Record<string, string> = {}) {
  for (let i = 0; i < RATE_LIMIT_MAX; i++) expect((await handleAiPost(ctx(headers, env), deps())).status).toBe(200);
}

beforeAll(() => {
  const kp = generateKeyPairSync('rsa', { modulusLength: 2048 });
  privateKey = kp.privateKey;
  jwks = [{ ...(kp.publicKey.export({ format: 'jwk' }) as unknown as Jwk), kid: 'kid-1', alg: 'RS256' }];
});

beforeEach(() => {
  resetRateLimit();
  resetAiIdentityCache();
  fetchJwks = vi.fn<AiDeps['fetchJwks']>(async () => jwks);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('functions/api/ai — verified rate-limit identity (ACCESS_REQUIRE=1)', () => {
  it('keys the budget on the verified JWT email; rotating the plain header does not reset it', async () => {
    const jwt = token('verified.user@example.invalid');
    await exhaust({ 'Cf-Access-Jwt-Assertion': jwt, 'cf-access-authenticated-user-email': 'a@example.invalid' }, ACCESS);
    const res = await handleAiPost(
      ctx({ 'Cf-Access-Jwt-Assertion': jwt, 'cf-access-authenticated-user-email': 'fresh@example.invalid' }, ACCESS),
      deps(),
    );
    expect(res.status).toBe(429);
    // a different VERIFIED user has an independent budget
    expect((await handleAiPost(ctx({ 'Cf-Access-Jwt-Assertion': token('other@example.invalid') }, ACCESS), deps())).status).toBe(200);
  });

  it('a forged header cannot exhaust a verified user\'s budget', async () => {
    const victim = 'verified.user@example.invalid';
    // header-only requests are refused outright, so they never touch any bucket
    for (let i = 0; i < RATE_LIMIT_MAX + 1; i++) {
      expect((await handleAiPost(ctx({ 'cf-access-authenticated-user-email': victim }, ACCESS), deps())).status).toBe(403);
    }
    expect((await handleAiPost(ctx({ 'Cf-Access-Jwt-Assertion': token(victim) }, ACCESS), deps())).status).toBe(200);
  });

  it.each([
    // Factories: the signing key only exists once beforeAll has run.
    ['no JWT (header only)', () => ({ 'cf-access-authenticated-user-email': 'forged@example.invalid' })],
    ['expired JWT', () => ({ 'Cf-Access-Jwt-Assertion': token('u@example.invalid', { exp: NOW - 1 }) })],
    ['wrong audience', () => ({ 'Cf-Access-Jwt-Assertion': token('u@example.invalid', { aud: ['other'] }) })],
    ['garbage JWT', () => ({ 'Cf-Access-Jwt-Assertion': 'a.b.c' })],
  ])('fails closed with 403 on %s, before any model call', async (_name, headers) => {
    const res = await handleAiPost(ctx(headers(), ACCESS), deps());
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(text).not.toContain('forged@example.invalid');
    expect(res.headers.get('content-type')).not.toContain('text/event-stream');
  });

  it('fails closed with 503 when Access config is incomplete or the JWKS is unavailable', async () => {
    const jwt = token('u@example.invalid');
    const envs: Array<Record<string, string>> = [{ ACCESS_REQUIRE: '1' }, { ACCESS_REQUIRE: '1', ACCESS_ISSUER: ISSUER }, { ...ACCESS, ACCESS_ISSUER: 'http://insecure.example.invalid' }];
    for (const env of envs) {
      expect((await handleAiPost(ctx({ 'Cf-Access-Jwt-Assertion': jwt }, env), deps())).status).toBe(503);
    }
    fetchJwks.mockRejectedValueOnce(new Error('network'));
    expect((await handleAiPost(ctx({ 'Cf-Access-Jwt-Assertion': jwt }, ACCESS), deps())).status).toBe(503);
  });
});

describe('functions/api/ai — inert mode (ACCESS_REQUIRE not "1")', () => {
  it('keys on CF-Connecting-IP and ignores the plain email header entirely', async () => {
    await exhaust({ 'cf-connecting-ip': '198.51.100.7', 'cf-access-authenticated-user-email': 'a@example.invalid' });
    // a rotated header on the same IP is still over budget
    const res = await handleAiPost(
      ctx({ 'cf-connecting-ip': '198.51.100.7', 'cf-access-authenticated-user-email': 'b@example.invalid' }),
      deps(),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
    // another IP is unaffected
    expect((await handleAiPost(ctx({ 'cf-connecting-ip': '198.51.100.8' }), deps())).status).toBe(200);
    expect(fetchJwks).not.toHaveBeenCalled();
  });

  it('a JWT is not verified (nor trusted) in inert mode: the IP key still applies', async () => {
    await exhaust({ 'cf-connecting-ip': '198.51.100.9', 'Cf-Access-Jwt-Assertion': token('u@example.invalid') });
    expect((await handleAiPost(ctx({ 'cf-connecting-ip': '198.51.100.9', 'Cf-Access-Jwt-Assertion': token('v@example.invalid') }), deps())).status).toBe(429);
    expect(fetchJwks).not.toHaveBeenCalled();
  });
});

// Adversarial review 2026-10-30 (C5): inert mode keyed on the exact cf-connecting-ip, so one IPv6
// /64 (what a single subscriber is routinely given) held ~2^64 independent budgets.
describe('rateLimitKeyForIp — IPv6 collapses to its /64', () => {
  it.each([
    ['198.51.100.7', 'ip:198.51.100.7'],
    ['2001:db8:1:2::1', 'ip6:2001:db8:1:2::/64'],
    ['2001:DB8:0001:0002:aaaa:bbbb:cccc:dddd', 'ip6:2001:db8:1:2::/64'],
    ['2001:db8::', 'ip6:2001:db8:0:0::/64'],
    ['2001:db8::5:6:7:8', 'ip6:2001:db8:0:0::/64'],
    ['1::4:5:6:7:8', 'ip6:1:0:0:4::/64'],
    ['1:2:3::7:8', 'ip6:1:2:3:0::/64'],
    ['1:2:3:4:5:6:7:8', 'ip6:1:2:3:4::/64'],
    ['::', 'ip6:0:0:0:0::/64'],
    ['::1', 'ip6:0:0:0:0::/64'],
    ['fe80::1%eth0', 'ip6:fe80:0:0:0::/64'],
    ['::ffff:198.51.100.7', 'ip:198.51.100.7'],
    ['', 'ip:unknown'],
    [null, 'ip:unknown'],
  ])('%j -> %j', (ip, key) => {
    expect(rateLimitKeyForIp(ip)).toBe(key);
  });

  it('addresses in the same /64 share one budget; the next /64 is independent', async () => {
    await exhaust({ 'cf-connecting-ip': '2001:db8:1:2::1' });
    expect((await handleAiPost(ctx({ 'cf-connecting-ip': '2001:db8:1:2:ffff:ffff:ffff:fffe' }), deps())).status).toBe(429);
    expect((await handleAiPost(ctx({ 'cf-connecting-ip': '2001:0db8:0001:0002:0:0:0:9' }), deps())).status).toBe(429);
    expect((await handleAiPost(ctx({ 'cf-connecting-ip': '2001:db8:1:3::1' }), deps())).status).toBe(200);
  });
});

// Adversarial review 2026-10-30 (C5): ACCESS_REQUIRE set to anything but exactly '1' went inert.
describe('functions/api/ai — malformed ACCESS_REQUIRE fails closed', () => {
  beforeEach(() => {
    vi.mocked(runAgent).mockClear();
  });

  it.each(['true', '1 ', ' 1', 'TRUE', 'yes', '0'])('503 when ACCESS_REQUIRE=%j, before the body or the model', async (value) => {
    const res = await handleAiPost(ctx({ 'Cf-Access-Jwt-Assertion': token('u@example.invalid') }, { ...ACCESS, ACCESS_REQUIRE: value }), deps());
    expect(res.status).toBe(503);
    expect(fetchJwks).not.toHaveBeenCalled();
    expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
  });

  it('unset or empty ACCESS_REQUIRE is still inert (IP key)', async () => {
    for (const env of [{}, { ACCESS_REQUIRE: '' }] as Array<Record<string, string>>) {
      expect((await handleAiPost(ctx({ 'cf-connecting-ip': '198.51.100.20' }, env), deps())).status).toBe(200);
    }
  });
});

// C2t: deny must precede the body parse, the snapshot read and the model. An invalid body yields 400
// once a caller is admitted, so a 403/503 on the same body proves the order.
describe('functions/api/ai — deny precedes body parse, snapshot read and model', () => {
  function badBodyCtx(headers: Record<string, string>, env: Record<string, string>) {
    const assets = vi.fn(async () => new Response('{}', { status: 200 }));
    const request = new Request('https://mirror.test/api/ai', { method: 'POST', body: JSON.stringify({ question: 42 }), headers });
    return { assets, context: { request, env: { ...env, ASSETS: { fetch: assets } } } as unknown as Parameters<typeof handleAiPost>[0] };
  }

  beforeEach(() => {
    vi.mocked(runAgent).mockClear();
  });

  it('the invalid body really is a 400 once the caller is admitted', async () => {
    const { assets, context } = badBodyCtx({ 'cf-connecting-ip': '198.51.100.30' }, {});
    expect((await handleAiPost(context, deps())).status).toBe(400);
    expect(assets).not.toHaveBeenCalled();
  });

  it.each([
    ['403: no JWT', () => ({}), () => ACCESS, 403],
    ['403: expired JWT', () => ({ 'Cf-Access-Jwt-Assertion': token('u@example.invalid', { exp: NOW - 1 }) }), () => ACCESS, 403],
    ['503: config incomplete', () => ({ 'Cf-Access-Jwt-Assertion': token('u@example.invalid') }), () => ({ ACCESS_REQUIRE: '1' }), 503],
    ['503: malformed ACCESS_REQUIRE', () => ({ 'Cf-Access-Jwt-Assertion': token('u@example.invalid') }), () => ({ ...ACCESS, ACCESS_REQUIRE: 'true' }), 503],
  ] as const)('%s: no ASSETS.fetch, no runAgent, no 400', async (_name, headers, env, status) => {
    const { assets, context } = badBodyCtx(headers(), env());
    const res = await handleAiPost(context, deps());
    expect(res.status).toBe(status);
    expect(assets).not.toHaveBeenCalled();
    expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
  });

  it('503: an unavailable JWKS also stops before ASSETS.fetch and runAgent', async () => {
    fetchJwks.mockRejectedValueOnce(new Error('network'));
    const { assets, context } = badBodyCtx({ 'Cf-Access-Jwt-Assertion': token('u@example.invalid') }, ACCESS);
    expect((await handleAiPost(context, deps())).status).toBe(503);
    expect(assets).not.toHaveBeenCalled();
    expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
  });
});

// The production entry point wires nowSeconds as Math.floor(Date.now() / 1000). A milliseconds clock
// would read every token as expired; this pins the seconds wiring through onRequestPost.
describe('functions/api/ai — onRequestPost clock wiring (verified mode)', () => {
  it('verifies against the wall clock in SECONDS', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ keys: jwks }), { status: 200 })));
    try {
      vi.setSystemTime(NOW * 1000 + 999); // floor -> NOW
      const ok = await onRequestPost(ctx({ 'Cf-Access-Jwt-Assertion': token('clock@example.invalid', { exp: NOW + 60 }) }, ACCESS));
      expect(ok.status).toBe(200);
      const expired = await onRequestPost(ctx({ 'Cf-Access-Jwt-Assertion': token('clock@example.invalid', { exp: NOW - 1 }) }, ACCESS));
      expect(expired.status).toBe(403);
      vi.setSystemTime((NOW + 61) * 1000); // past exp
      const later = await onRequestPost(ctx({ 'Cf-Access-Jwt-Assertion': token('clock@example.invalid', { exp: NOW + 60 }) }, ACCESS));
      expect(later.status).toBe(403);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});
