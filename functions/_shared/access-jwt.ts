/**
 * Cloudflare Access JWT verification for the Pages runtime (Workers: WebCrypto only, no node:*).
 *
 * This mirrors server/access-authz.ts `verifyAccessJwt` check-for-check so the edge and the Brain
 * Server accept and reject the same tokens: RS256 pinned (defeats alg:none and RS256->HS256
 * confusion), kid required and matched against the published JWKS, signature verified before the
 * claims are trusted, then issuer, audience, required exp (enforced exactly) and nbf (with the
 * same 60 s asymmetric skew tolerance). It is a separate file only because server/access-authz.ts
 * imports node:crypto and hono types and is Architect-owned / refute-gated; keep the two in step.
 *
 * Fail closed everywhere: any parse, key-import or verify error returns { ok: false }.
 */

/** An RSA public key in JWK form, as published at /cdn-cgi/access/certs. */
export interface Jwk {
  kty: string;
  n: string;
  e: string;
  kid?: string;
  alg?: string;
}

export type VerifyResult = { ok: true; email: string } | { ok: false; reason: string };

export interface VerifyOptions {
  /** The Access application's AUD tag. */
  audience: string;
  /** e.g. https://<team>.cloudflareaccess.com */
  issuer: string;
  /** Injected so tests are deterministic and never depend on wall-clock. */
  nowSeconds: number;
  /** Tolerance for clock skew between Cloudflare's edge and this host (applied to nbf only). */
  clockSkewSeconds?: number;
}

const B64URL = /^[A-Za-z0-9_-]*$/;

function decodeB64Url(segment: string): Uint8Array<ArrayBuffer> | null {
  if (!B64URL.test(segment)) return null;
  try {
    const b64 = segment.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const out = new Uint8Array(new ArrayBuffer(bin.length));
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function parseJsonSegment(segment: string): Record<string, unknown> | null {
  const bytes = decodeB64Url(segment);
  if (!bytes) return null;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
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

export async function verifyAccessJwt(
  token: string,
  jwks: readonly Jwk[],
  opts: VerifyOptions,
): Promise<VerifyResult> {
  const skew = opts.clockSkewSeconds ?? 60;

  if (typeof token !== 'string' || token.length === 0) return { ok: false, reason: 'missing token' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed token' };
  const [headerSeg, payloadSeg, sigSeg] = parts;
  if (!headerSeg || !payloadSeg || sigSeg === undefined) return { ok: false, reason: 'malformed token' };

  const header = parseJsonSegment(headerSeg);
  if (!header) return { ok: false, reason: 'malformed header' };

  // Algorithm is pinned, not read-and-obeyed (alg:none, RS256->HS256 confusion).
  if (header.alg !== 'RS256') return { ok: false, reason: 'unsupported alg' };

  const kid = typeof header.kid === 'string' ? header.kid : null;
  if (!kid) return { ok: false, reason: 'missing kid' };

  const jwk = jwks.find((k) => k.kid === kid);
  if (!jwk) return { ok: false, reason: 'unknown kid' };

  const sig = decodeB64Url(sigSeg);
  if (!sig || sig.length === 0) return { ok: false, reason: 'bad signature' };

  let signatureValid = false;
  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    signatureValid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      sig,
      new TextEncoder().encode(`${headerSeg}.${payloadSeg}`),
    );
  } catch {
    return { ok: false, reason: 'signature check failed' };
  }
  if (!signatureValid) return { ok: false, reason: 'bad signature' };

  const claims = parseJsonSegment(payloadSeg);
  if (!claims) return { ok: false, reason: 'malformed claims' };

  if (claims.iss !== opts.issuer) return { ok: false, reason: 'issuer mismatch' };
  if (!audienceMatches(claims.aud, opts.audience)) return { ok: false, reason: 'audience mismatch' };

  // exp is REQUIRED and enforced exactly; skew is applied to nbf only (see server/access-authz.ts).
  if (typeof claims.exp !== 'number') return { ok: false, reason: 'missing exp' };
  if (opts.nowSeconds > claims.exp) return { ok: false, reason: 'expired' };
  if (typeof claims.nbf === 'number' && opts.nowSeconds < claims.nbf - skew) {
    return { ok: false, reason: 'not yet valid' };
  }

  const email = typeof claims.email === 'string' ? claims.email.trim() : '';
  if (!email) return { ok: false, reason: 'missing email claim' };

  return { ok: true, email };
}

/** Fetch the Access team's signing keys from `<issuer>/cdn-cgi/access/certs`. */
export async function fetchAccessJwks(issuer: string): Promise<readonly Jwk[]> {
  const res = await fetch(`${issuer.replace(/\/+$/, '')}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`JWKS fetch returned ${res.status}`);
  const body = (await res.json()) as { keys?: Jwk[] };
  if (!Array.isArray(body.keys)) throw new Error('JWKS response has no keys array');
  return body.keys;
}
