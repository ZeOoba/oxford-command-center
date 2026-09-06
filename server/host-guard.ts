/**
 * Request boundary for the Brain Server API — the DNS-rebinding and cross-site-write defense
 * (OI-050). Companion to server/cors-policy.ts, and the reason that file alone was not enough.
 *
 * WHAT cors() DOES NOT DO. Hono's `cors({ origin })` only decides which Access-Control-Allow-Origin
 * header to SET on the response. It never rejects a request: the handler runs regardless, and the
 * browser merely hides the response from a foreign page. Two real exposures follow:
 *
 *  1. DNS REBINDING. A page served from `http://attacker.example:8911` whose hostname is rebound to
 *     resolve to 127.0.0.1 is SAME-ORIGIN to this server in the browser's eyes. No Origin header is
 *     sent, CORS does not apply at all, and `fetch('/api/snapshot')` returns the full confidential
 *     portfolio to the attacker's script. The one thing that still betrays it is the HTTP `Host`
 *     header — `attacker.example:8911`, never `localhost:8911`. So we allowlist Host.
 *
 *  2. SIMPLE CROSS-SITE POST. A POST with a text/plain body (or no Content-Type) needs no preflight,
 *     so the browser delivers it and the server executes the state change before withholding the
 *     response. Requiring a custom header (X-ORA-Client) on every non-safe method forces a preflight,
 *     which the localhost-only cors() then refuses for any foreign Origin. Belt-and-suspenders, an
 *     Origin header that IS present must pass the same localhost allowlist or the request is refused
 *     outright — we do not rely on cors()'s header-setting to "block" anything.
 *
 * Pure decision functions + a thin Hono wrapper, mirroring cors-policy.ts, so the rule is
 * unit-testable (tests/unit/host-guard.test.ts) and the mounted behavior is integration-tested
 * (tests/unit/server-boundary.test.ts). Mount on `/api/*` and `/sse` BEFORE cors() and accessAuthz.
 *
 * FAIL-CLOSED. Missing Host denies. Unparseable Origin denies. An empty allowlist denies everything.
 * Denial reasons are logged server-side, never returned, so the endpoint cannot be used to probe
 * which hosts/origins are accepted.
 */
import type { MiddlewareHandler } from 'hono';
import { isAllowedOrigin } from './cors-policy';
import { ORA_CLIENT_HEADER } from '../src/contracts/client-header';

/** Methods that never mutate state and therefore do not need the client header. OPTIONS is the
 *  CORS preflight itself, which carries Access-Control-Request-Headers instead of the header. */
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

function normalizeHost(host: string): string {
  return host.trim().toLowerCase();
}

/**
 * The exact `Host` authorities this server answers to: `localhost:<port>` and `127.0.0.1:<port>`
 * (serve() binds 127.0.0.1 only — `[::1]` and 0.0.0.0 are deliberately absent). The port-less form is
 * accepted ONLY on port 80, where HTTP clients omit it. `extra` is for the Cloudflare-tunnel
 * deployment (BRAIN_ALLOWED_HOSTS), where cloudflared forwards the public hostname as Host unless its
 * ingress sets httpHostHeader; each entry is compared exactly, lower-cased.
 */
export function allowedHosts(port: number, extra: readonly string[] = []): ReadonlySet<string> {
  const set = new Set<string>([`localhost:${port}`, `127.0.0.1:${port}`]);
  if (port === 80) {
    set.add('localhost');
    set.add('127.0.0.1');
  }
  for (const h of extra) {
    const n = normalizeHost(h);
    if (n) set.add(n);
  }
  return set;
}

/** Exact, case-insensitive membership — no prefix, suffix, or substring matching. */
export function isAllowedHost(host: string | undefined, allowed: ReadonlySet<string>): boolean {
  if (!host) return false;
  const n = normalizeHost(host);
  return n.length > 0 && allowed.has(n);
}

/**
 * An Origin header, when present, must be a same-machine origin (reusing cors-policy's rule) or an
 * origin whose authority is an explicitly allowed extra host. Anything else — including the opaque
 * `null` origin and any value that is not a bare scheme://authority — is refused.
 */
export function isAllowedRequestOrigin(origin: string, allowed: ReadonlySet<string>): boolean {
  if (isAllowedOrigin(origin) !== null) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  // A real Origin is exactly scheme://authority — reject anything carrying a path, query, etc.
  if (`${url.protocol}//${url.host}` !== origin.toLowerCase()) return false;
  return isAllowedHost(url.host, allowed);
}

export interface BoundaryRequest {
  method: string;
  host: string | undefined;
  origin: string | undefined;
  clientHeader: string | undefined;
}

export type BoundaryDecision = { ok: true } | { ok: false; reason: 'host' | 'origin' | 'client-header' };

/** The whole rule, pure. Host is checked first: a foreign Host is never this server's caller. */
export function checkRequestBoundary(req: BoundaryRequest, allowed: ReadonlySet<string>): BoundaryDecision {
  if (!isAllowedHost(req.host, allowed)) return { ok: false, reason: 'host' };
  if (req.origin !== undefined && !isAllowedRequestOrigin(req.origin, allowed)) {
    return { ok: false, reason: 'origin' };
  }
  if (!SAFE_METHODS.has(req.method.toUpperCase())) {
    if (!req.clientHeader || req.clientHeader.trim().length === 0) return { ok: false, reason: 'client-header' };
  }
  return { ok: true };
}

export interface RequestBoundaryOptions {
  allowedHosts: ReadonlySet<string>;
}

/**
 * Hono middleware. Mount on `/api/*` and `/sse` BEFORE cors() and accessAuthz so no handler — present
 * or future — can run ahead of the check. 403 with an opaque body; the reason goes to the log only.
 */
export function requestBoundary(opts: RequestBoundaryOptions): MiddlewareHandler {
  return async (c, next) => {
    const decision = checkRequestBoundary(
      {
        method: c.req.method,
        host: c.req.header('host'),
        origin: c.req.header('origin'),
        clientHeader: c.req.header(ORA_CLIENT_HEADER),
      },
      opts.allowedHosts,
    );
    if (!decision.ok) {
      console.warn(`[host-guard] denied: ${decision.reason} on ${c.req.method} ${c.req.path}`);
      return c.json({ error: 'forbidden' }, 403);
    }
    return next();
  };
}

/** BRAIN_ALLOWED_HOSTS — comma-separated extra Host authorities (tunnel hostname). Empty when unset. */
export function extraAllowedHostsFromEnv(env: Record<string, string | undefined>): string[] {
  return (env.BRAIN_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
