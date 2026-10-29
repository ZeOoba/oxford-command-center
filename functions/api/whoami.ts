/**
 * Cloudflare Pages Function — returns the Access-VERIFIED identity.
 *
 * The identity is derived ONLY from the signed `Cf-Access-Jwt-Assertion` JWT, verified the same way
 * server/access-authz.ts verifies it (see functions/_shared/access-jwt.ts). The plain
 * `Cf-Access-Authenticated-User-Email` header is deliberately NOT read: it is forgeable by anyone
 * who can reach the function without passing through Access (for example a `<hash>.pages.dev`
 * deployment URL the Access application does not cover). Do not add it back as a fallback.
 *
 * Config (Pages project environment variables; same names as the Brain Server):
 *  - ACCESS_REQUIRE  must be exactly '1' to verify. Anything else is the inert/local-dev mode that
 *                    access-authz also has: no verification is attempted AND no identity is returned
 *                    (`{ email: null }`, the pre-existing "no signal" shape) — never a header echo.
 *  - ACCESS_ISSUER   https://<team>.cloudflareaccess.com   (required when ACCESS_REQUIRE=1)
 *  - ACCESS_AUD      the Access application's AUD tag       (required when ACCESS_REQUIRE=1)
 *
 * Responses (bodies never say why; reasons are logged):
 *  - 200 { email }        verified identity
 *  - 200 { email: null }  ACCESS_REQUIRE not '1' (inert)
 *  - 403 { error }        JWT missing / invalid / expired / wrong audience or issuer
 *  - 503 { error }        ACCESS_REQUIRE=1 but issuer/aud unset, or the JWKS cannot be fetched
 */
import { fetchAccessJwks, verifyAccessJwt, type Jwk } from '../_shared/access-jwt';

interface Env {
  ACCESS_REQUIRE?: string;
  ACCESS_ISSUER?: string;
  ACCESS_AUD?: string;
}

interface PagesContext {
  request: Request;
  env?: Env;
}

export interface WhoamiDeps {
  fetchJwks: (issuer: string) => Promise<readonly Jwk[]>;
  nowSeconds: () => number;
}

const JWKS_TTL_SECONDS = 3600;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

/** Per-isolate JWKS cache. An expired or failed fetch is never served stale: it denies (503). */
let cached: { issuer: string; keys: readonly Jwk[]; fetchedAt: number } | null = null;

/** Test hook: drop the module-level JWKS cache. */
export function resetWhoamiCache(): void {
  cached = null;
}

export async function handleWhoami(context: PagesContext, deps: WhoamiDeps): Promise<Response> {
  const env = context.env ?? {};

  // Mirrors accessAuthzOptionsFromEnv: exactly '1' enables; anything else is inert. Inert never
  // yields an identity — the plain header is not consulted in any mode.
  if (env.ACCESS_REQUIRE !== '1') return json({ email: null });

  const issuer = env.ACCESS_ISSUER?.trim() ?? '';
  const audience = env.ACCESS_AUD?.trim() ?? '';
  if (!issuer || !audience || !issuer.startsWith('https://')) {
    console.error('[whoami] ACCESS_REQUIRE=1 but ACCESS_ISSUER (https) / ACCESS_AUD not set — denying');
    return json({ error: 'unavailable' }, 503);
  }

  const token = context.request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) {
    console.warn('[whoami] denied: no Cf-Access-Jwt-Assertion');
    return json({ error: 'forbidden' }, 403);
  }

  const now = deps.nowSeconds();
  let keys: readonly Jwk[];
  if (cached && cached.issuer === issuer && now - cached.fetchedAt < JWKS_TTL_SECONDS) {
    keys = cached.keys;
  } else {
    try {
      keys = await deps.fetchJwks(issuer);
    } catch (err) {
      console.error('[whoami] JWKS fetch failed — denying:', err);
      return json({ error: 'unavailable' }, 503);
    }
    if (!keys || keys.length === 0) {
      console.error('[whoami] JWKS empty — denying');
      return json({ error: 'unavailable' }, 503);
    }
    cached = { issuer, keys, fetchedAt: now };
  }

  const result = await verifyAccessJwt(token, keys, { audience, issuer, nowSeconds: now });
  if (!result.ok) {
    console.warn('[whoami] denied:', result.reason);
    return json({ error: 'forbidden' }, 403);
  }
  return json({ email: result.email });
}

export function onRequestGet(context: PagesContext): Promise<Response> {
  return handleWhoami(context, {
    fetchJwks: fetchAccessJwks,
    nowSeconds: () => Math.floor(Date.now() / 1000),
  });
}
