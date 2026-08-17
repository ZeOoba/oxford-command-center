import { describe, it, expect, beforeAll } from 'vitest';
import { generateKeyPairSync, createSign, type KeyObject } from 'node:crypto';
import { Hono } from 'hono';
import { verifyAccessJwt, isAllowedAccessEmail, accessAuthz, type Jwk } from '../../server/access-authz';

/**
 * W2 (Eric Live Phase 2) — app-level authorization on /api/*.
 *
 * Today the Brain Server asserts NOTHING about who is calling. Its only protection is that
 * serve() binds 127.0.0.1 (server/index.ts) — i.e. network position. Phase 2 puts a Cloudflare
 * tunnel in front of it, at which point "nothing reaches loopback except me" stops being true and
 * the full firm warehouse sits one Access misconfiguration away from the open internet.
 *
 * THE CENTRAL THREAT: `Cf-Access-Authenticated-User-Email` is a plain request header. Anything that
 * can reach the origin can set it to egoldberg@oxfordra.net and be trusted. Cloudflare's actual
 * proof of identity is the SIGNED `Cf-Access-Jwt-Assertion`. Trusting the email header is the
 * single most likely way to build this wrong, so it gets an explicit test below.
 *
 * Real RSA keys and real signatures throughout — a mocked verifier would test the mock.
 */

const ISSUER = 'https://spring-wood-ade4.cloudflareaccess.com';
const AUDIENCE = 'test-aud-tag';
const NOW = 1_780_000_000;

let privateKey: KeyObject;
let jwks: Jwk[];
let wrongPrivateKey: KeyObject;

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Sign a real RS256 JWT. `key` defaults to the trusted key; pass the wrong one to forge. */
function signJwt(payload: Record<string, unknown>, opts: { kid?: string; key?: KeyObject; alg?: string } = {}): string {
  const header = { alg: opts.alg ?? 'RS256', typ: 'JWT', kid: opts.kid ?? 'test-kid-1' };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  const sig = signer.sign(opts.key ?? privateKey);
  return `${signingInput}.${b64url(sig)}`;
}

function validPayload(overrides: Record<string, unknown> = {}) {
  return { iss: ISSUER, aud: [AUDIENCE], email: 'egoldberg@oxfordra.net', exp: NOW + 600, iat: NOW - 10, nbf: NOW - 10, ...overrides };
}

beforeAll(() => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  privateKey = pair.privateKey;
  const jwk = pair.publicKey.export({ format: 'jwk' }) as unknown as Jwk;
  jwks = [{ ...jwk, kid: 'test-kid-1', alg: 'RS256' }];
  wrongPrivateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
});

describe('verifyAccessJwt — signature and claim validation', () => {
  const opts = () => ({ audience: AUDIENCE, issuer: ISSUER, nowSeconds: NOW });

  it('accepts a correctly signed, unexpired token for the right aud/iss', () => {
    const r = verifyAccessJwt(signJwt(validPayload()), jwks, opts());
    expect(r).toEqual({ ok: true, email: 'egoldberg@oxfordra.net' });
  });

  it('REJECTS a token signed by a key that is not in the JWKS (forgery)', () => {
    const r = verifyAccessJwt(signJwt(validPayload(), { key: wrongPrivateKey }), jwks, opts());
    expect(r.ok).toBe(false);
  });

  it('REJECTS a tampered payload whose signature no longer matches', () => {
    const token = signJwt(validPayload());
    const [h, , s] = token.split('.');
    const forged = `${h}.${b64url(JSON.stringify(validPayload({ email: 'attacker@evil.invalid' })))}.${s}`;
    const r = verifyAccessJwt(forged, jwks, opts());
    expect(r.ok).toBe(false);
  });

  /**
   * Expiry is enforced EXACTLY — no clock-skew grace. Skew tolerance on `exp` would extend a
   * credential's usable life past its stated end; the same tolerance on `nbf` (asserted below)
   * only avoids falsely denying a freshly-minted token. See the asymmetry note in access-authz.ts.
   */
  it('REJECTS a token expired by one second (no skew grace on exp)', () => {
    const r = verifyAccessJwt(signJwt(validPayload({ exp: NOW - 1 })), jwks, opts());
    expect(r.ok).toBe(false);
  });

  it('REJECTS a long-expired token', () => {
    const r = verifyAccessJwt(signJwt(validPayload({ exp: NOW - 86_400 })), jwks, opts());
    expect(r.ok).toBe(false);
  });

  it('accepts a token that is still valid by one second', () => {
    const r = verifyAccessJwt(signJwt(validPayload({ exp: NOW + 1 })), jwks, opts());
    expect(r.ok).toBe(true);
  });

  /** The protective half of the asymmetry: a slightly-ahead issuer must not cause a false denial. */
  it('tolerates small clock skew on nbf', () => {
    const r = verifyAccessJwt(signJwt(validPayload({ nbf: NOW + 30 })), jwks, opts());
    expect(r.ok).toBe(true);
  });

  it('REJECTS a not-yet-valid (nbf in the future) token', () => {
    const r = verifyAccessJwt(signJwt(validPayload({ nbf: NOW + 300 })), jwks, opts());
    expect(r.ok).toBe(false);
  });

  it('REJECTS a token minted for a different Access application (aud mismatch)', () => {
    const r = verifyAccessJwt(signJwt(validPayload({ aud: ['some-other-app'] })), jwks, opts());
    expect(r.ok).toBe(false);
  });

  it('REJECTS a token from a different Access team (iss mismatch)', () => {
    const r = verifyAccessJwt(signJwt(validPayload({ iss: 'https://attacker.cloudflareaccess.com' })), jwks, opts());
    expect(r.ok).toBe(false);
  });

  /**
   * `alg: "none"` is the classic JWT bypass — a token with no signature that a naive verifier
   * treats as valid because it never checks the algorithm.
   */
  it('REJECTS alg=none', () => {
    const header = b64url(JSON.stringify({ alg: 'none', typ: 'JWT', kid: 'test-kid-1' }));
    const r = verifyAccessJwt(`${header}.${b64url(JSON.stringify(validPayload()))}.`, jwks, opts());
    expect(r.ok).toBe(false);
  });

  /** An HMAC token whose "key" is the public key — the RS256→HS256 confusion attack. */
  it('REJECTS an HS256 token (algorithm confusion)', () => {
    const r = verifyAccessJwt(signJwt(validPayload(), { alg: 'HS256' }), jwks, opts());
    expect(r.ok).toBe(false);
  });

  it('REJECTS a token whose kid matches no key in the JWKS', () => {
    const r = verifyAccessJwt(signJwt(validPayload(), { kid: 'unknown-kid' }), jwks, opts());
    expect(r.ok).toBe(false);
  });

  it('FAILS CLOSED on an empty JWKS (keys unavailable ⇒ deny, never allow)', () => {
    const r = verifyAccessJwt(signJwt(validPayload()), [], opts());
    expect(r.ok).toBe(false);
  });

  it('REJECTS structurally malformed tokens', () => {
    for (const bad of ['', 'not-a-jwt', 'a.b', 'a.b.c.d']) {
      expect(verifyAccessJwt(bad, jwks, opts()).ok).toBe(false);
    }
  });

  it('REJECTS a token with no email claim', () => {
    const p = validPayload();
    delete (p as Record<string, unknown>).email;
    expect(verifyAccessJwt(signJwt(p), jwks, opts()).ok).toBe(false);
  });
});

describe('isAllowedAccessEmail', () => {
  const allow = ['ggoldberg@oxfordra.net', 'egoldberg@oxfordra.net'];

  it('allows a roster member', () => {
    expect(isAllowedAccessEmail('egoldberg@oxfordra.net', allow)).toBe(true);
  });

  it('is case-insensitive (Access may echo different casing than the roster)', () => {
    expect(isAllowedAccessEmail('EGoldberg@Oxfordra.net', allow)).toBe(true);
  });

  it('denies a valid Access identity that is not on the roster', () => {
    expect(isAllowedAccessEmail('someone@oxfordra.net', allow)).toBe(false);
  });

  it('denies on an empty roster rather than defaulting to open', () => {
    expect(isAllowedAccessEmail('egoldberg@oxfordra.net', [])).toBe(false);
  });

  /** Substring/suffix confusion: a lookalike domain must not satisfy the roster. */
  it('denies lookalike addresses', () => {
    expect(isAllowedAccessEmail('egoldberg@oxfordra.net.evil.invalid', allow)).toBe(false);
    expect(isAllowedAccessEmail('xegoldberg@oxfordra.net', allow)).toBe(false);
  });
});

describe('accessAuthz middleware — mounted on /api/*', () => {
  function appWith(enabled: boolean) {
    const app = new Hono();
    let handlerRan = false;
    app.use('/api/*', accessAuthz({
      enabled,
      audience: AUDIENCE,
      issuer: ISSUER,
      allowlist: ['ggoldberg@oxfordra.net', 'egoldberg@oxfordra.net'],
      fetchJwks: async () => jwks,
      nowSeconds: () => NOW,
    }));
    app.get('/api/warehouse/metrics', (c) => { handlerRan = true; return c.json({ secret: 'firm financials' }); });
    return { app, ran: () => handlerRan };
  }

  it('403s a request with NO Access assertion, and the handler never runs', async () => {
    const { app, ran } = appWith(true);
    const res = await app.request('/api/warehouse/metrics');
    expect(res.status).toBe(403);
    expect(ran()).toBe(false);
  });

  /**
   * THE CENTRAL THREAT. A bare email header with no signed assertion must be worthless. If this
   * test ever passes with a 200, the tunnel is an open door to the warehouse.
   */
  it('403s when only the spoofable email header is present (no signed JWT)', async () => {
    const { app, ran } = appWith(true);
    const res = await app.request('/api/warehouse/metrics', {
      headers: { 'Cf-Access-Authenticated-User-Email': 'egoldberg@oxfordra.net' },
    });
    expect(res.status).toBe(403);
    expect(ran()).toBe(false);
  });

  it('allows a valid signed assertion for an allowlisted identity', async () => {
    const { app, ran } = appWith(true);
    const res = await app.request('/api/warehouse/metrics', {
      headers: { 'Cf-Access-Jwt-Assertion': signJwt(validPayload()) },
    });
    expect(res.status).toBe(200);
    expect(ran()).toBe(true);
  });

  it('403s a validly signed assertion for an identity NOT on the roster', async () => {
    const { app, ran } = appWith(true);
    const res = await app.request('/api/warehouse/metrics', {
      headers: { 'Cf-Access-Jwt-Assertion': signJwt(validPayload({ email: 'contractor@oxfordra.net' })) },
    });
    expect(res.status).toBe(403);
    expect(ran()).toBe(false);
  });

  /** Gabriel's `npm run dev` sends no Access headers. Enabling this must not break local work. */
  it('is transparent when disabled (localhost dev path unchanged)', async () => {
    const { app, ran } = appWith(false);
    const res = await app.request('/api/warehouse/metrics');
    expect(res.status).toBe(200);
    expect(ran()).toBe(true);
  });

  /** JWKS fetch failure must deny, not fall back to the header or to open. */
  it('FAILS CLOSED when the JWKS cannot be fetched', async () => {
    const app = new Hono();
    let handlerRan = false;
    app.use('/api/*', accessAuthz({
      enabled: true,
      audience: AUDIENCE,
      issuer: ISSUER,
      allowlist: ['egoldberg@oxfordra.net'],
      fetchJwks: async () => { throw new Error('network down'); },
      nowSeconds: () => NOW,
    }));
    app.get('/api/warehouse/metrics', (c) => { handlerRan = true; return c.json({ ok: true }); });
    const res = await app.request('/api/warehouse/metrics', {
      headers: { 'Cf-Access-Jwt-Assertion': signJwt(validPayload()) },
    });
    expect(res.status).toBe(503);
    expect(handlerRan).toBe(false);
  });

  it('does not leak the reason for denial in the response body', async () => {
    const { app } = appWith(true);
    const res = await app.request('/api/warehouse/metrics', {
      headers: { 'Cf-Access-Jwt-Assertion': signJwt(validPayload({ email: 'contractor@oxfordra.net' })) },
    });
    const body = await res.text();
    expect(body).not.toContain('contractor@oxfordra.net');
    expect(body.toLowerCase()).not.toContain('allowlist');
  });
});
