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
import { extraAllowedHostsFromEnv } from './host-guard';

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
 * ACCESS_REQUIRE mirrors the edge rule (functions/_shared/access-identity.ts): unset, '' or '0' is
 * inert (local dev), exactly '1' enables, and ANY other value ('true', '1 ', 'yes', a typo) refuses
 * to start. It used to read `=== '1'`, so a malformed value booted with authorization silently inert
 * while the edge failed closed on the same input (audit 2026-11-08, brain-authz-fail-open-tunnel).
 *
 * A tunnelled deployment (BRAIN_ALLOWED_HOSTS non-empty — same parse as host-guard.ts
 * extraAllowedHostsFromEnv) must run with ACCESS_REQUIRE=1: once a non-loopback Host is admitted,
 * loopback binding is no longer the boundary and the Access assertion is the only identity check.
 *
 * BRAIN_HOST_AUTH is the one explicit exception (Gabriel-approved 2026-11-09): the live server is
 * reached through Tailscale Serve, not Cloudflare Access. See parseBrainHostAuth / isTailnetHost. With
 * BRAIN_HOST_AUTH=tailnet, extra hosts are admitted without ACCESS_REQUIRE=1 ONLY if every one is a
 * *.ts.net name; the tailnet ACL is then the authorization boundary and one startup line says so.
 * tailnet + ACCESS_REQUIRE=1 is allowed and means Access is enforced as well (every request must also
 * carry a verified Cf-Access-Jwt-Assertion, which plain Tailscale Serve traffic does not, so it 403s).
 *
 * When enabled, the issuer/audience/roster are REQUIRED. Every misconfiguration refuses to start
 * rather than booting with authorization silently inert — the failure mode that looks fine in every log.
 *
 * `log` receives the single startup line describing the host-auth boundary (tailnet mode only).
 */
export function accessAuthzOptionsFromEnv(
  env: Record<string, string | undefined>,
  log: (message: string) => void = (m) => console.warn(m),
): AccessAuthzOptions {
  const hostAuth = parseBrainHostAuth(env.BRAIN_HOST_AUTH);
  const raw = env.ACCESS_REQUIRE;
  if (raw !== undefined && raw !== '' && raw !== '0' && raw !== '1') {
    throw new Error(
      `ACCESS_REQUIRE is set but is neither "1" nor "0" — refusing to start rather than guess (authorization would be inert).`,
    );
  }
  const enabled = raw === '1';
  const extraHosts = extraAllowedHostsFromEnv(env);
  if (hostAuth === 'tailnet') {
    const foreign = extraHosts.filter((h) => !isTailnetHost(h));
    if (foreign.length > 0) {
      throw new Error(
        `BRAIN_HOST_AUTH=tailnet but BRAIN_ALLOWED_HOSTS contains ${foreign.length} host(s) that are not *.ts.net names (${foreign
          .map((h) => JSON.stringify(h))
          .join(', ')}) — refusing to start: only tailnet hosts may skip ACCESS_REQUIRE.`,
      );
    }
  } else if (extraHosts.length > 0 && !enabled) {
    throw new Error(
      'BRAIN_ALLOWED_HOSTS admits non-loopback hosts but ACCESS_REQUIRE is not "1" — refusing to start with the tunnel unauthenticated.',
    );
  }
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

  if (hostAuth === 'tailnet') {
    log(
      extraHosts.length === 0
        ? '[access-authz] BRAIN_HOST_AUTH=tailnet with no extra hosts — loopback only.'
        : `[access-authz] BRAIN_HOST_AUTH=tailnet: the tailnet ACL is the authorization boundary for ${extraHosts.join(', ')}` +
            (enabled
              ? ' — Cloudflare Access is enforced as well (ACCESS_REQUIRE=1).'
              : ' — no Cloudflare Access check (ACCESS_REQUIRE off). Tailscale Funnel must stay off for this node.'),
    );
  }

  return { enabled, issuer, audience, allowlist, fetchJwks: cloudflareJwksFetcher(issuer) };
}

export type BrainHostAuth = 'default' | 'tailnet';

/**
 * BRAIN_HOST_AUTH: unset or '' = default (the ACCESS_REQUIRE rule above); exactly 'tailnet' = the
 * tailnet opt-in. ANY other value — including 'Tailnet', ' tailnet', 'access' — refuses to start, the
 * same strictness as ACCESS_REQUIRE: a typo must never silently select a mode.
 */
export function parseBrainHostAuth(raw: string | undefined): BrainHostAuth {
  if (raw === undefined || raw === '') return 'default';
  if (raw === 'tailnet') return 'tailnet';
  throw new Error(
    `BRAIN_HOST_AUTH is set to ${JSON.stringify(raw)} but the only accepted value is "tailnet" — refusing to start rather than guess.`,
  );
}

/** One DNS label: LDH, 1–63 chars, no leading/trailing hyphen. ASCII only — IDN must be punycode. */
const DNS_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
/** <one or more labels>.ts.net, optional :port. Anchored: no trailing dot, no userinfo/path, no wildcard. */
const TAILNET_AUTHORITY = new RegExp(String.raw`^(?:${DNS_LABEL}\.)+ts\.net(?::([1-9][0-9]{0,4}))?$`);

/**
 * True when `authority` (a BRAIN_ALLOWED_HOSTS entry, compared lower-cased like host-guard does) is a
 * Tailscale MagicDNS name: at least one whole label before a final `ts.net`, optional port 1–65535.
 * `ts.net.evil.com`, `evilts.net`, `ts.net`, `x.ts.net.` and anything with non-LDH characters are not.
 */
export function isTailnetHost(authority: string): boolean {
  const m = TAILNET_AUTHORITY.exec(authority.toLowerCase());
  if (!m) return false;
  const port = m[1];
  return port === undefined || Number(port) <= 65535;
}
