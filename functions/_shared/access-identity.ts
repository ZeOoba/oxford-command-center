/**
 * The Access-VERIFIED caller identity for a Pages Function, shared by functions/api/whoami.ts and
 * functions/api/ai.ts so both read identity the same way.
 *
 * The identity comes ONLY from the signed `Cf-Access-Jwt-Assertion` JWT, verified by
 * verifyAccessJwt (functions/_shared/access-jwt.ts, kept in step with server/access-authz.ts). The
 * plain `Cf-Access-Authenticated-User-Email` header is never read: anyone who reaches the function
 * without passing through Access (for example a `<hash>.pages.dev` URL the Access application does
 * not cover) can set it.
 *
 * Config (Pages environment variables; same names as the Brain Server):
 *  - ACCESS_REQUIRE  exactly '1' verifies. Unset or empty is inert: no verification, no identity.
 *                    Any other value ('true', '1 ', '0') fails closed: `denied` 503 (config error).
 *  - ACCESS_ISSUER   https://<team>.cloudflareaccess.com   (required when ACCESS_REQUIRE=1)
 *  - ACCESS_AUD      the Access application's AUD tag       (required when ACCESS_REQUIRE=1)
 *
 * Fail closed: with ACCESS_REQUIRE=1, a missing / invalid / expired token is `denied` 403, and
 * missing config or an unfetchable / empty JWKS is `denied` 503. Reasons are for logs only.
 */
import { verifyAccessJwt, type Jwk } from './access-jwt';

export interface AccessEnv {
  ACCESS_REQUIRE?: string;
  ACCESS_ISSUER?: string;
  ACCESS_AUD?: string;
}

export interface AccessIdentityDeps {
  fetchJwks: (issuer: string) => Promise<readonly Jwk[]>;
  nowSeconds: () => number;
}

export type AccessIdentity =
  | { kind: 'inert' }
  | { kind: 'verified'; email: string }
  | { kind: 'denied'; status: 403 | 503; reason: string };

/** How long a fetched JWKS is reused before it is fetched again. */
export const JWKS_TTL_SECONDS = 3600;

export interface AccessIdentityResolver {
  resolve(request: Request, env: AccessEnv | undefined, deps: AccessIdentityDeps): Promise<AccessIdentity>;
  /** Test hook: drop this resolver's JWKS cache. */
  reset(): void;
}

/** A resolver with its own per-isolate JWKS cache. An expired or failed fetch is never served stale. */
export function createAccessIdentityResolver(): AccessIdentityResolver {
  let cached: { issuer: string; keys: readonly Jwk[]; fetchedAt: number } | null = null;

  return {
    reset() {
      cached = null;
    },
    async resolve(request, env, deps) {
      const e = env ?? {};
      // Exactly '1' enables; unset or empty is inert. Any OTHER value ('true', '1 ', '0') is a
      // misconfiguration and fails closed (adversarial review 2026-10-30, C5): an operator who set
      // ACCESS_REQUIRE meant to enforce Access, and silently going inert would drop verification.
      if (e.ACCESS_REQUIRE === undefined || e.ACCESS_REQUIRE === '') return { kind: 'inert' };
      if (e.ACCESS_REQUIRE !== '1') {
        return { kind: 'denied', status: 503, reason: 'ACCESS_REQUIRE is set but not exactly "1"' };
      }

      const issuer = e.ACCESS_ISSUER?.trim() ?? '';
      const audience = e.ACCESS_AUD?.trim() ?? '';
      if (!issuer || !audience || !issuer.startsWith('https://')) {
        return { kind: 'denied', status: 503, reason: 'ACCESS_REQUIRE=1 but ACCESS_ISSUER (https) / ACCESS_AUD not set' };
      }

      const token = request.headers.get('Cf-Access-Jwt-Assertion');
      if (!token) return { kind: 'denied', status: 403, reason: 'no Cf-Access-Jwt-Assertion' };

      const now = deps.nowSeconds();
      let keys: readonly Jwk[];
      if (cached && cached.issuer === issuer && now - cached.fetchedAt < JWKS_TTL_SECONDS) {
        keys = cached.keys;
      } else {
        try {
          keys = await deps.fetchJwks(issuer);
        } catch (err) {
          return { kind: 'denied', status: 503, reason: `JWKS fetch failed: ${err instanceof Error ? err.message : String(err)}` };
        }
        if (!keys || keys.length === 0) return { kind: 'denied', status: 503, reason: 'JWKS empty' };
        cached = { issuer, keys, fetchedAt: now };
      }

      const result = await verifyAccessJwt(token, keys, { audience, issuer, nowSeconds: now });
      if (!result.ok) return { kind: 'denied', status: 403, reason: result.reason };
      return { kind: 'verified', email: result.email };
    },
  };
}
