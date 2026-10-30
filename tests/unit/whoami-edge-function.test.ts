// @vitest-environment node
// tests/unit/whoami-edge-function.test.ts
//
// functions/api/whoami.ts must derive identity ONLY from a verified Cf-Access-Jwt-Assertion. The
// forgeable Cf-Access-Authenticated-User-Email header must never authenticate anyone. Synthetic RSA
// keys, issuer and AUD throughout — no real team domain, AUD or secret appears here.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { handleWhoami, onRequestGet, resetWhoamiCache, type WhoamiDeps } from '../../functions/api/whoami';
import { fetchAccessJwks, verifyAccessJwt, type Jwk } from '../../functions/_shared/access-jwt';

const ISSUER = 'https://example-team.cloudflareaccess.com';
const AUDIENCE = 'synthetic-aud-tag';
const NOW = 1_780_000_000;
const ENV = { ACCESS_REQUIRE: '1', ACCESS_ISSUER: ISSUER, ACCESS_AUD: AUDIENCE };

let privateKey: KeyObject;
let wrongKey: KeyObject;
let jwks: Jwk[];

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sign(payload: Record<string, unknown>, opts: { key?: KeyObject; kid?: string; alg?: string } = {}): string {
  const header = { alg: opts.alg ?? 'RS256', typ: 'JWT', kid: opts.kid ?? 'kid-1' };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signer = createSign('RSA-SHA256');
  signer.update(input);
  return `${input}.${b64url(signer.sign(opts.key ?? privateKey))}`;
}

const claims = (over: Record<string, unknown> = {}) => ({
  iss: ISSUER,
  aud: [AUDIENCE],
  email: 'verified.user@example.invalid',
  exp: NOW + 3600,
  nbf: NOW - 10,
  ...over,
});

function req(headers: Record<string, string>): Request {
  return new Request('https://mirror.example.invalid/api/whoami', { headers });
}

let fetchJwks: ReturnType<typeof vi.fn<WhoamiDeps['fetchJwks']>>;
const deps = (): WhoamiDeps => ({ fetchJwks, nowSeconds: () => NOW });

beforeAll(() => {
  const a = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const b = generateKeyPairSync('rsa', { modulusLength: 2048 });
  privateKey = a.privateKey;
  wrongKey = b.privateKey;
  jwks = [{ ...(a.publicKey.export({ format: 'jwk' }) as unknown as Jwk), kid: 'kid-1', alg: 'RS256' }];
});

beforeEach(() => {
  resetWhoamiCache();
  fetchJwks = vi.fn<WhoamiDeps['fetchJwks']>(async () => jwks);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('whoami edge function', () => {
  it('returns the email from a valid, verified JWT', async () => {
    const res = await handleWhoami({ request: req({ 'Cf-Access-Jwt-Assertion': sign(claims()) }), env: ENV }, deps());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: 'verified.user@example.invalid' });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('uses the VERIFIED claim, ignoring a conflicting plain header', async () => {
    const res = await handleWhoami(
      {
        request: req({
          'Cf-Access-Jwt-Assertion': sign(claims()),
          'Cf-Access-Authenticated-User-Email': 'attacker@example.invalid',
        }),
        env: ENV,
      },
      deps(),
    );
    expect(await res.json()).toEqual({ email: 'verified.user@example.invalid' });
  });

  it('header-only forgery does NOT authenticate (config enabled)', async () => {
    const res = await handleWhoami(
      { request: req({ 'Cf-Access-Authenticated-User-Email': 'forged@example.invalid' }), env: ENV },
      deps(),
    );
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(text).not.toContain('forged@example.invalid');
    expect(JSON.parse(text)).not.toHaveProperty('email');
  });

  it('header-only forgery yields no identity when inert (ACCESS_REQUIRE unset or empty)', async () => {
    for (const env of [{}, { ACCESS_REQUIRE: '' }, undefined]) {
      const res = await handleWhoami(
        { request: req({ 'Cf-Access-Authenticated-User-Email': 'forged@example.invalid' }), env },
        deps(),
      );
      expect(await res.json()).toEqual({ email: null });
    }
    expect(fetchJwks).not.toHaveBeenCalled();
  });

  // Adversarial review 2026-10-30 (C5): a set-but-malformed ACCESS_REQUIRE ('true', '1 ') used to go
  // silently inert, so an operator who meant to enforce Access got no verification at all.
  it.each(['true', '1 ', ' 1', 'TRUE', 'yes', '0'])(
    'fails closed (503, no identity) when ACCESS_REQUIRE is set but not exactly "1" (%j)',
    async (value) => {
      const res = await handleWhoami(
        {
          request: req({ 'Cf-Access-Jwt-Assertion': sign(claims()), 'Cf-Access-Authenticated-User-Email': 'forged@example.invalid' }),
          env: { ...ENV, ACCESS_REQUIRE: value },
        },
        deps(),
      );
      expect(res.status).toBe(503);
      const body = await res.text();
      expect(body).not.toContain('verified.user@example.invalid');
      expect(body).not.toContain('forged@example.invalid');
      expect(fetchJwks).not.toHaveBeenCalled();
    },
  );

  it('missing JWT header -> 403, no identity', async () => {
    const res = await handleWhoami({ request: req({}), env: ENV }, deps());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden' });
  });

  it.each([
    ['expired', claims({ exp: NOW - 1 })],
    ['wrong audience', claims({ aud: ['some-other-aud'] })],
    ['wrong issuer', claims({ iss: 'https://other-team.cloudflareaccess.com' })],
    ['missing exp', (() => { const c = claims(); delete (c as Record<string, unknown>).exp; return c; })()],
    ['not yet valid', claims({ nbf: NOW + 3600 })],
    ['missing email', claims({ email: '' })],
  ])('rejects %s -> 403', async (_name, payload) => {
    const res = await handleWhoami({ request: req({ 'Cf-Access-Jwt-Assertion': sign(payload) }), env: ENV }, deps());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden' });
  });

  it('rejects a token signed by a different key', async () => {
    const res = await handleWhoami(
      { request: req({ 'Cf-Access-Jwt-Assertion': sign(claims(), { key: wrongKey }) }), env: ENV },
      deps(),
    );
    expect(res.status).toBe(403);
  });

  it('rejects a tampered payload (signature no longer matches)', async () => {
    const [h, , s] = sign(claims()).split('.');
    const forgedPayload = b64url(JSON.stringify(claims({ email: 'attacker@example.invalid' })));
    const res = await handleWhoami(
      { request: req({ 'Cf-Access-Jwt-Assertion': `${h}.${forgedPayload}.${s}` }), env: ENV },
      deps(),
    );
    expect(res.status).toBe(403);
  });

  it('rejects a tampered signature', async () => {
    const t = sign(claims());
    const flipped = t.slice(0, -4) + (t.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    const res = await handleWhoami({ request: req({ 'Cf-Access-Jwt-Assertion': flipped }), env: ENV }, deps());
    expect(res.status).toBe(403);
  });

  it('rejects alg:none, HS256, unknown kid, missing kid and garbage', async () => {
    const none = `${b64url(JSON.stringify({ alg: 'none', kid: 'kid-1' }))}.${b64url(JSON.stringify(claims()))}.`;
    const hs = sign(claims(), { alg: 'HS256' });
    const unknownKid = sign(claims(), { kid: 'nope' });
    const noKid = (() => {
      const input = `${b64url(JSON.stringify({ alg: 'RS256' }))}.${b64url(JSON.stringify(claims()))}`;
      const s = createSign('RSA-SHA256');
      s.update(input);
      return `${input}.${b64url(s.sign(privateKey))}`;
    })();
    for (const t of [none, hs, unknownKid, noKid, 'not-a-jwt', 'a.b.c', '...']) {
      const res = await handleWhoami({ request: req({ 'Cf-Access-Jwt-Assertion': t }), env: ENV }, deps());
      expect(res.status).toBe(403);
    }
  });

  it('fails closed (503, no identity) when ACCESS_REQUIRE=1 but issuer/aud are missing', async () => {
    const token = sign(claims());
    for (const env of [
      { ACCESS_REQUIRE: '1' },
      { ACCESS_REQUIRE: '1', ACCESS_ISSUER: ISSUER },
      { ACCESS_REQUIRE: '1', ACCESS_AUD: AUDIENCE },
      { ACCESS_REQUIRE: '1', ACCESS_ISSUER: 'http://insecure.example.invalid', ACCESS_AUD: AUDIENCE },
    ]) {
      const res = await handleWhoami({ request: req({ 'Cf-Access-Jwt-Assertion': token }), env }, deps());
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'unavailable' });
    }
  });

  it('fails closed (503) when the JWKS cannot be fetched or is empty', async () => {
    const token = sign(claims());
    fetchJwks.mockRejectedValueOnce(new Error('network'));
    expect((await handleWhoami({ request: req({ 'Cf-Access-Jwt-Assertion': token }), env: ENV }, deps())).status).toBe(503);
    fetchJwks.mockResolvedValueOnce([]);
    expect((await handleWhoami({ request: req({ 'Cf-Access-Jwt-Assertion': token }), env: ENV }, deps())).status).toBe(503);
  });

  it('caches the JWKS within the TTL', async () => {
    const token = sign(claims());
    await handleWhoami({ request: req({ 'Cf-Access-Jwt-Assertion': token }), env: ENV }, deps());
    await handleWhoami({ request: req({ 'Cf-Access-Jwt-Assertion': token }), env: ENV }, deps());
    expect(fetchJwks).toHaveBeenCalledTimes(1);
  });
});

describe('verifyAccessJwt parity details', () => {
  const opts = { audience: AUDIENCE, issuer: ISSUER, nowSeconds: NOW };

  it('accepts a string aud and tolerates nbf skew, but enforces exp exactly', async () => {
    expect((await verifyAccessJwt(sign(claims({ aud: AUDIENCE })), jwks, opts)).ok).toBe(true);
    expect((await verifyAccessJwt(sign(claims({ nbf: NOW + 30 })), jwks, opts)).ok).toBe(true);
    expect((await verifyAccessJwt(sign(claims({ nbf: NOW + 61 })), jwks, opts)).ok).toBe(false);
    expect((await verifyAccessJwt(sign(claims({ exp: NOW })), jwks, opts)).ok).toBe(true);
    expect((await verifyAccessJwt(sign(claims({ exp: NOW - 1 })), jwks, opts)).ok).toBe(false);
  });

  it('rejects a malformed JWK without throwing', async () => {
    const bad: Jwk[] = [{ kty: 'RSA', n: '!!', e: 'AQAB', kid: 'kid-1' }];
    expect(await verifyAccessJwt(sign(claims()), bad, opts)).toMatchObject({ ok: false });
  });
});

// Review follow-up 2026-10-30: three paths #510 shipped untested.
describe('whoami — onRequestGet wiring, JWKS TTL and fetcher URL', () => {
  it('onRequestGet converts Date.now() milliseconds to whole seconds before verifying', async () => {
    // exp is enforced exactly. A ms clock would read as ~1000x later and reject this token as expired;
    // a non-floored clock at NOW + 0.999 s would still accept it, so pin exp to NOW.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW * 1000 + 999);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ keys: jwks }), { status: 200 })));
    try {
      const ok = await onRequestGet({ request: req({ 'Cf-Access-Jwt-Assertion': sign(claims({ exp: NOW })) }), env: ENV });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ email: 'verified.user@example.invalid' });
      const expired = await onRequestGet({ request: req({ 'Cf-Access-Jwt-Assertion': sign(claims({ exp: NOW - 1 })) }), env: ENV });
      expect(expired.status).toBe(403);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('re-fetches the JWKS once the 1h TTL has elapsed, not before', async () => {
    let now = NOW;
    const ttlDeps = (): WhoamiDeps => ({ fetchJwks, nowSeconds: () => now });
    const token = sign(claims({ exp: NOW + 7200 }));
    await handleWhoami({ request: req({ 'Cf-Access-Jwt-Assertion': token }), env: ENV }, ttlDeps());
    now = NOW + 3599;
    await handleWhoami({ request: req({ 'Cf-Access-Jwt-Assertion': token }), env: ENV }, ttlDeps());
    expect(fetchJwks).toHaveBeenCalledTimes(1);
    now = NOW + 3600;
    const res = await handleWhoami({ request: req({ 'Cf-Access-Jwt-Assertion': token }), env: ENV }, ttlDeps());
    expect(res.status).toBe(200);
    expect(fetchJwks).toHaveBeenCalledTimes(2);
  });

  it('fetchAccessJwks reads <issuer>/cdn-cgi/access/certs (trailing slashes stripped) and fails on a bad body', async () => {
    const fetchStub = vi.fn(async () => new Response(JSON.stringify({ keys: jwks }), { status: 200 }));
    vi.stubGlobal('fetch', fetchStub);
    try {
      expect(await fetchAccessJwks(`${ISSUER}//`)).toEqual(jwks);
      expect(fetchStub).toHaveBeenCalledWith(`${ISSUER}/cdn-cgi/access/certs`);
      fetchStub.mockResolvedValueOnce(new Response('{}', { status: 200 }));
      await expect(fetchAccessJwks(ISSUER)).rejects.toThrow(/no keys/);
      fetchStub.mockResolvedValueOnce(new Response('', { status: 500 }));
      await expect(fetchAccessJwks(ISSUER)).rejects.toThrow(/500/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
