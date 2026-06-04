/**
 * Cloudflare Pages Function — returns the Access-authenticated identity.
 *
 * Cloudflare Access injects `Cf-Access-Authenticated-User-Email` on every
 * authenticated request to the mirror. This echoes it as JSON so the client can
 * auto-pick a view profile on first load. No secrets, no request body, no
 * snapshot — only the already-authenticated email. When the header is absent
 * (local dev / direct hit) it returns `{ email: null }`. Inherits Cloudflare
 * Access on the same hostname.
 */
interface PagesContext {
  request: Request;
}

export function onRequestGet(context: PagesContext): Response {
  const email = context.request.headers.get('Cf-Access-Authenticated-User-Email');
  return new Response(JSON.stringify({ email: email ?? null }), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}
