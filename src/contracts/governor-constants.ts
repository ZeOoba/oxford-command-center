/**
 * THE ratified capital-governor constants — the ONE place the literals live.
 *
 * CLAUDE.md §4 hard invariants: DSCR floor 1.25x, aggregate LTV ceiling 40%. Every other copy
 * (server CAPITAL_CONFIG, client GOVERNOR_FALLBACK, the edge bundle's GOVERNOR_DEFAULTS, the
 * write-path invariant checks) derives from this object so they can never drift apart; the DB
 * CHECK constraints in migrations/003_capital_config.sql restate them in SQL and the
 * conditions/capital-config tests pin all of them to each other.
 *
 * Runtime-agnostic (no imports) so it is safe for the client bundle, the Brain Server and the
 * Cloudflare Pages Functions alike. NEVER change these values without Gabriel's permission.
 */
export const RATIFIED_GOVERNORS = {
  /** Debt-service coverage floor (x). Hard invariant — CLAUDE.md §4. */
  dscrFloor: 1.25,
  /** Aggregate loan-to-value ceiling (fraction). Hard invariant — CLAUDE.md §4. */
  ltvCeiling: 0.40,
  /** PER-PROPERTY refi-sizing LTV ceiling (fraction). Hard invariant — CLAUDE.md §4 ("65% per-property refi ceiling",
   *  protected). Not in tension with the 40% aggregate ceiling (Gabriel, 2026-07-11). Encoded here 2026-11-12 (PR-C,
   *  Gabriel in-turn go-ahead) as the one home of the literal: the acquisition DSCR floor sizes its test loan at it
   *  (acquisition-underwriting SKILL.md v4.44/v4.45). Not a capital_config column — no live set overrides it. ALERT_THRESHOLDS.refiLtvCeilingPerProperty
   *  (src/analytics/conditions.ts) and debt-maturity's REFI_LTV_CEILING derive from this. */
  perPropertyLtvCeiling: 0.65,
  /** Ratified set version + effective date (capital_config version-1 seed row). */
  version: 1,
  effectiveFrom: '2026-06-13',
} as const;
