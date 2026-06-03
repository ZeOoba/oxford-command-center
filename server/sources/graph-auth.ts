/**
 * Microsoft Graph auth (Phase 6) — resolves a bearer token for the M365 adapters.
 *
 * Two modes, in precedence order:
 *  1. GRAPH_TOKEN — a pre-obtained bearer (delegated, short-lived). Useful for a quick manual test.
 *  2. App-registration client-credentials — GRAPH_TENANT_ID + GRAPH_CLIENT_ID + GRAPH_CLIENT_SECRET.
 *     This is the durable, UNATTENDED path: we fetch an app-only token and cache it until ~1 min
 *     before expiry, then refresh automatically. Requires the app registration to hold the
 *     application permission Tasks.Read.All (admin-consented). App-only has no /me context, so the
 *     M365 adapters must target /users/{GRAPH_USER}.
 *
 * Graceful: nothing configured → null (the caller returns no live data and falls back).
 * Server-only.
 */
let cached: { token: string; expiresAt: number } | null = null;

/** Test seam — clears the in-memory token cache. */
export function _resetGraphTokenCache(): void {
  cached = null;
}

const TOKEN_URL = (tenant: string): string => `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;

/** Resolve a Graph bearer token, or null when Graph is not configured. `now` is injectable for tests. */
export async function getGraphToken(now: number = Date.now()): Promise<string | null> {
  const manual = process.env.GRAPH_TOKEN;
  if (manual) return manual;

  const tenant = process.env.GRAPH_TENANT_ID;
  const clientId = process.env.GRAPH_CLIENT_ID;
  const secret = process.env.GRAPH_CLIENT_SECRET;
  if (!tenant || !clientId || !secret) return null;

  if (cached && cached.expiresAt > now + 60_000) return cached.token;

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: secret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });
  const res = await fetch(TOKEN_URL(tenant), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`Graph token request failed: ${res.status}`);
  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error('Graph token response had no access_token');

  cached = { token: json.access_token, expiresAt: now + (json.expires_in ?? 3600) * 1000 };
  return cached.token;
}
