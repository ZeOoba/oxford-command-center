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
 *  - ACCESS_REQUIRE  must be exactly '1' to verify. Unset, empty or '0' is the inert/local-dev mode:
 *                    no verification is attempted AND no identity is returned (`{ email: null }`,
 *                    the pre-existing "no signal" shape) — never a header echo. Any other value
 *                    ('true', '1 ', 'yes') is a config error and fails closed with 503.
 *  - ACCESS_ISSUER   https://<team>.cloudflareaccess.com   (required when ACCESS_REQUIRE=1)
 *  - ACCESS_AUD      the Access application's AUD tag       (required when ACCESS_REQUIRE=1)
 *
 * Responses (bodies never say why; reasons are logged):
 *  - 200 { email }        verified identity
 *  - 200 { email: null }  ACCESS_REQUIRE unset, empty or '0' (inert)
 *  - 403 { error }        JWT missing / invalid / expired / wrong audience or issuer
 *  - 503 { error }        ACCESS_REQUIRE set but not '1' or '0', ACCESS_REQUIRE=1 but issuer/aud unset, or
 *                         the JWKS cannot be fetched
 */
import { createAccessIdentityResolver, type AccessEnv, type AccessIdentityDeps } from '../_shared/access-identity';
import { fetchAccessJwks } from '../_shared/access-jwt';

interface PagesContext {
  request: Request;
  env?: AccessEnv;
}

export type WhoamiDeps = AccessIdentityDeps;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

/** Per-isolate JWKS cache (inside the resolver). An expired or failed fetch is never served stale. */
const accessIdentity = createAccessIdentityResolver();

/** Test hook: drop the module-level JWKS cache. */
export function resetWhoamiCache(): void {
  accessIdentity.reset();
}

export async function handleWhoami(context: PagesContext, deps: WhoamiDeps): Promise<Response> {
  const who = await accessIdentity.resolve(context.request, context.env, deps);
  // Inert never yields an identity — the plain header is not consulted in any mode.
  if (who.kind === 'inert') return json({ email: null });
  if (who.kind === 'denied') {
    if (who.status === 503) console.error('[whoami] denying:', who.reason);
    else console.warn('[whoami] denied:', who.reason);
    return json({ error: who.status === 503 ? 'unavailable' : 'forbidden' }, who.status);
  }
  return json({ email: who.email });
}

export function onRequestGet(context: PagesContext): Promise<Response> {
  return handleWhoami(context, {
    fetchJwks: fetchAccessJwks,
    nowSeconds: () => Math.floor(Date.now() / 1000),
  });
}
