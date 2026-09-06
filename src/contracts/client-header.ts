/**
 * The first-party client marker every state-mutating request to the Brain Server must carry
 * (server/host-guard.ts, OI-050). Shared by the server (which requires it) and the web client +
 * internal scripts (which send it) so the header name has exactly one home.
 *
 * WHY A CUSTOM HEADER. A cross-origin request that carries a non-safelisted header is never a
 * CORS "simple request": the browser MUST send an OPTIONS preflight first, and the server's
 * localhost-only origin allowlist (server/cors-policy.ts) refuses that preflight for any foreign
 * page. Without it, a hostile page can fire a text/plain POST that the browser delivers and the
 * server executes — only the *response* is withheld, the state change already happened.
 *
 * The VALUE is not a secret and is not checked for anything beyond presence: the protection comes
 * from the header existing, not from what it says.
 */
export const ORA_CLIENT_HEADER = 'X-ORA-Client';
export const ORA_CLIENT_HEADER_VALUE = '1';

/** Spread into `fetch` headers on any POST/PUT/PATCH/DELETE to the Brain Server. */
export const ORA_CLIENT_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  [ORA_CLIENT_HEADER]: ORA_CLIENT_HEADER_VALUE,
});

/** JSON-body mutation headers — the common case across src/. */
export const ORA_JSON_MUTATION_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  ...ORA_CLIENT_HEADERS,
  'content-type': 'application/json',
});
