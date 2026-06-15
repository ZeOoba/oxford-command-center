/**
 * CORS origin policy — confidential deal data must only ever be reachable from the same
 * machine. CLAUDE.md §9: "never relax the localhost-only rule." Extracted from server/index.ts
 * into a pure function so the rule is unit-testable and protected by a regression test
 * (tests/unit/server-cors.test.ts).
 */

/** Matches http(s)://localhost and http(s)://127.0.0.1, with an optional port — and nothing else. */
export const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

/**
 * Hono `cors({ origin })` callback: echo the request origin back when it is a same-machine
 * localhost origin (which authorizes the request), or return `null` to reject it.
 */
export function isAllowedOrigin(origin: string): string | null {
  return LOCALHOST_ORIGIN_RE.test(origin) ? origin : null;
}
