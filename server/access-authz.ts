// server/access-authz.ts
//
// W2 (Eric Live Phase 2) — application-level authorization for /api/*.
//
// WHY THIS EXISTS. Until now the Brain Server's only access control was its network position:
// serve() binds 127.0.0.1, so nothing off-machine could reach it. Phase 2 puts a Cloudflare tunnel
// in front of that loopback listener, which retires network position as a security boundary — the
// warehouse (every property's financials, debt, and calibration history) becomes reachable by
// anything that can talk to the tunnel. This middleware is the replacement boundary.
//
// WHAT WE TRUST. Cloudflare Access forwards TWO things: `Cf-Access-Authenticated-User-Email` (a
// plain, trivially forgeable header) and `Cf-Access-Jwt-Assertion` (a JWT signed by the Access
// team's private key). We verify ONLY the signed assertion. Trusting the email header would mean
// anyone who reaches the origin — directly, through a misrouted ingress, or via a future
// same-machine process — can assert any identity by typing it. The header is not read at all here,
// deliberately: reading it "as a fallback" is how that hole gets reintroduced.
//
// FAIL-CLOSED EVERYWHERE. Unverifiable token, unknown key, unfetchable JWKS, unparseable claims —
// all deny. There is no code path in which an error results in the request proceeding.
//
// NO NEW DEPENDENCY. RS256 verification uses node:crypto (already used elsewhere in this repo)
// rather than pulling a JWT library into a repo that gates install scripts.
import { createPublicKey, createVerify } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';

/** An RSA public key in JWK form, as published at /cdn-cgi/access/certs. */
export interface Jwk {
  kty: string;
  n: string;
  e: string;
  kid?: string;
  alg?: string;
}

export type VerifyResult = { ok: true; email: string } | { ok: false; reason: string };

interface VerifyOptions {
  /** The Access application's AUD tag. */
  audience: string;
  /** e.g. https://spring-wood-ade4.cloudflareaccess.com */
  issuer: string;
  /** Injected so tests are deterministic and never depend on wall-clock. */
  nowSeconds: number;
  /** Tolerance for clock skew between Cloudflare's edge and this host. */
  clockSkewSeconds?: number;
}

function decodeB64Url(segment: string): Buffer {
  return Buffer.from(segment.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function parseJsonSegment(segment: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(decodeB64Url(segment).toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** `aud` is a string or an array of strings depending on the issuer; normalize before comparing. */
function audienceMatches(aud: unknown, expected: string): boolean {
  if (typeof aud === 'string') return aud === expected;
  if (Array.isArray(aud)) return aud.some((a) => typeof a === 'string' && a === expected);
  return false;
}

/**
 * Verify a Cloudflare Access JWT against a JWKS. Pure — no I/O, no clock, no globals — so the
 * security-critical logic is testable with real keys and real signatures.
 */
export function verifyAccessJwt(token: string, jwks: readonly Jwk[], opts: VerifyOptions): VerifyResult {
  const skew = opts.clockSkewSeconds ?? 60;

  if (typeof token !== 'string' || token.length === 0) return { ok: false, reason: 'missing token' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed token' };
  const headerSeg = parts[0];
  const payloadSeg = parts[1];
  const sigSeg = parts[2];
  // An empty signature segment is structurally valid (it is what `alg: "none"` produces) and is
  // rejected below by the algorithm pin, not here.
  if (!headerSeg || !payloadSeg || sigSeg === undefined) return { ok: false, reason: 'malformed token' };

  const header = parseJsonSegment(headerSeg);
  if (!header) return { ok: false, reason: 'malformed header' };

  // Algorithm is pinned, not read-and-obeyed. This single check defeats both `alg: "none"` and the
  // RS256->HS256 confusion attack, in which a token is HMAC-signed with the public key as the
  // secret and a verifier that dispatches on the header's own algorithm accepts it.
  if (header.alg !== 'RS256') return { ok: false, reason: 'unsupported alg' };

  const kid = typeof header.kid === 'string' ? header.kid : null;
  // An unkeyed token cannot be matched to a specific published key; refuse rather than trying
  // every key, which would let a rotated-out key keep authorizing.
  if (!kid) return { ok: false, reason: 'missing kid' };

  const jwk = jwks.find((k) => k.kid === kid);
  if (!jwk) return { ok: false, reason: 'unknown kid' };

  let signatureValid = false;
  try {
    const key = createPublicKey({ key: jwk as unknown as Record<string, unknown>, format: 'jwk' });
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${headerSeg}.${payloadSeg}`);
    signatureValid = verifier.verify(key, decodeB64Url(sigSeg));
  } catch {
    // A malformed JWK or signature buffer must deny, never throw past this boundary.
    return { ok: false, reason: 'signature check failed' };
  }
  if (!signatureValid) return { ok: false, reason: 'bad signature' };

  const claims = parseJsonSegment(payloadSeg);
  if (!claims) return { ok: false, reason: 'malformed claims' };

  if (claims.iss !== opts.issuer) return { ok: false, reason: 'issuer mismatch' };
  if (!audienceMatches(claims.aud, opts.audience)) return { ok: false, reason: 'audience mismatch' };

  // exp is REQUIRED: a token without one never expires, which is indistinguishable from a
  // permanent credential if it ever leaks.
  if (typeof claims.exp !== 'number') return { ok: false, reason: 'missing exp' };

  // Clock-skew tolerance is applied ASYMMETRICALLY, on purpose.
  //
  // On `nbf` it is protective: if Cloudflare's edge clock runs slightly ahead of this host, a
  // freshly-minted, entirely legitimate token would otherwise be rejected for a few seconds.
  //
  // On `exp` it would be the opposite — it would keep honoring a credential AFTER it expired,
  // extending its usable lifetime by the tolerance. Access tokens last hours, so refusing the
  // final seconds costs nothing real (the user re-authenticates), whereas honoring an expired
  // assertion is a genuine, if brief, widening of the credential window. Expiry is therefore
  // enforced exactly.
  if (opts.nowSeconds > claims.exp) return { ok: false, reason: 'expired' };
  if (typeof claims.nbf === 'number' && opts.nowSeconds < claims.nbf - skew) {
    return { ok: false, reason: 'not yet valid' };
  }

  const email = typeof claims.email === 'string' ? claims.email.trim() : '';
  if (!email) return { ok: false, reason: 'missing email claim' };

  return { ok: true, email };
}

/**
 * Exact, case-insensitive roster membership. Deliberately NOT a domain or suffix rule: an
 * `endsWith('@oxfordra.net')` check would authorize every current and future mailbox in the tenant,
 * and a substring check would authorize `egoldberg@oxfordra.net.evil.invalid`.
 */
export function isAllowedAccessEmail(email: string, allowlist: readonly string[]): boolean {
  if (!email || allowlist.length === 0) return false;
  const normalized = email.trim().toLowerCase();
  return allowlist.some((allowed) => allowed.trim().toLowerCase() === normalized);
}

export interface AccessAuthzOptions {
  /** Off by default so `npm run dev` on localhost is unaffected. Turned on for the tunnel. */
  enabled: boolean;
  audience: string;
  issuer: string;
  allowlist: readonly string[];
  fetchJwks: () => Promise<readonly Jwk[]>;
  nowSeconds?: () => number;
  /** How long a successfully fetched JWKS is reused before refetching. */
  jwksTtlSeconds?: number;
}

/**
 * Hono middleware. Mount on `/api/*` BEFORE the route mounts so no handler can run first.
 *
 * Status codes are distinguished on purpose: 403 means "we checked and you may not", 503 means
 * "we could not check". Collapsing them would make an outage look like an authorization failure
 * during an incident. Neither response body says WHY — denial reasons are logged server-side, not
 * returned, so the endpoint can't be used to enumerate the roster or probe claim validation.
 */
export function accessAuthz(opts: AccessAuthzOptions): MiddlewareHandler {
  const now = opts.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  const ttl = opts.jwksTtlSeconds ?? 3600;
  let cached: { keys: readonly Jwk[]; fetchedAt: number } | null = null;

  return async (c, next) => {
    if (!opts.enabled) return next();

    const token = c.req.header('Cf-Access-Jwt-Assertion');
    if (!token) {
      console.warn('[access-authz] denied: no Cf-Access-Jwt-Assertion on', c.req.path);
      return c.json({ error: 'forbidden' }, 403);
    }

    let keys: readonly Jwk[];
    if (cached && now() - cached.fetchedAt < ttl) {
      keys = cached.keys;
    } else {
      try {
        keys = await opts.fetchJwks();
      } catch (err) {
        // Deny while the keys are unreachable. Serving from an expired cache or waving the request
        // through would mean a JWKS outage silently disables authorization.
        console.error('[access-authz] JWKS fetch failed — denying:', err);
        return c.json({ error: 'unavailable' }, 503);
      }
      if (!keys || keys.length === 0) {
        console.error('[access-authz] JWKS empty — denying');
        return c.json({ error: 'unavailable' }, 503);
      }
      cached = { keys, fetchedAt: now() };
    }

    const result = verifyAccessJwt(token, keys, {
      audience: opts.audience,
      issuer: opts.issuer,
      nowSeconds: now(),
    });
    if (!result.ok) {
      console.warn('[access-authz] denied:', result.reason, 'on', c.req.path);
      return c.json({ error: 'forbidden' }, 403);
    }
    if (!isAllowedAccessEmail(result.email, opts.allowlist)) {
      console.warn('[access-authz] denied: identity not on roster, path', c.req.path);
      return c.json({ error: 'forbidden' }, 403);
    }

    c.set('accessEmail', result.email);
    return next();
  };
}

/** Fetch the Access team's signing keys. Separate from the middleware so it can be swapped in tests. */
export function cloudflareJwksFetcher(issuer: string): () => Promise<readonly Jwk[]> {
  return async () => {
    const res = await fetch(`${issuer.replace(/\/+$/, '')}/cdn-cgi/access/certs`);
    if (!res.ok) throw new Error(`JWKS fetch returned ${res.status}`);
    const body = (await res.json()) as { keys?: Jwk[] };
    if (!Array.isArray(body.keys)) throw new Error('JWKS response has no keys array');
    return body.keys;
  };
}

/**
 * Build options from the environment.
 *
 * REQUIRE_ACCESS must be exactly '1' to enable — same strictness as shouldBakeWarehouse, so '0'
 * genuinely disables rather than reading as a truthy string. When enabled, the issuer/audience/
 * roster are REQUIRED: a misconfigured deployment must refuse to start rather than boot with
 * authorization silently inert, which is the failure mode that would look fine in every log.
 */
export function accessAuthzOptionsFromEnv(env: Record<string, string | undefined>): AccessAuthzOptions {
  const enabled = env.ACCESS_REQUIRE === '1';
  const issuer = env.ACCESS_ISSUER?.trim() ?? '';
  const audience = env.ACCESS_AUD?.trim() ?? '';
  const allowlist = (env.ACCESS_ALLOWLIST ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (enabled) {
    const missing = [
      !issuer && 'ACCESS_ISSUER',
      !audience && 'ACCESS_AUD',
      allowlist.length === 0 && 'ACCESS_ALLOWLIST',
    ].filter(Boolean);
    if (missing.length) {
      throw new Error(
        `ACCESS_REQUIRE=1 but ${missing.join(', ')} not set — refusing to start with authorization inert.`,
      );
    }
  }

  return { enabled, issuer, audience, allowlist, fetchJwks: cloudflareJwksFetcher(issuer) };
}
