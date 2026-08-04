/**
 * DECLASSIFICATION ALLOWLIST — the escape hatch for Defect 1b (2026-08-04).
 *
 * `mergeDeals` defaults EVERY unmatched Notion-only deal to `confidential: true` (the fail-closed
 * widening ratified 2026-07-16). That default is correct and is NOT being weakened. But until now
 * its only exit was authoring a full row into seed-deals.ts, so deals stayed redacted forever after
 * they stopped being sensitive: on 2026-08-04 the pipeline carried 14 permanently-flagged Notion
 * rows, 8 of them formally Dead/Passed. The cost is not cosmetic — `deal.confidential` also hides a
 * row from the AI agent (server/ai/tools.ts) and disables market comps for it (server/ai/comps.ts),
 * so the brain could see only 5 of 22 deals.
 *
 * Listing a deal id here asserts: this deal carries no surviving confidentiality obligation and may
 * appear on public surfaces, including the Cloudflare mirror. It is a PUBLICATION decision, so it
 * lives in reviewed source rather than a runtime-editable file — an allowlist that can be mutated
 * without review is an Invariant 3 hole.
 *
 * TWO INDEPENDENT SAFETY PROPERTIES (see server/sources/deal-declassification.ts):
 *   1. An entry here is honored ONLY if the deal also fails to match any ACTIVE group in
 *      confidential-terms.json. The roster always wins; this list can never override it.
 *   2. If the terms file is missing or unreadable, the whole allowlist goes inert and every
 *      unmatched deal stays confidential. It fails closed, never open.
 *
 * Ids are the merged snapshot ids (`notion-<slug of the Notion Deal Name>`). Deliberately EMPTY:
 * populating it is a per-deal call for Gabriel, not an inference from a deal's stage — "Dead" is
 * not by itself evidence that a price or counterparty may be published.
 */
export const PUBLIC_DEAL_IDS: readonly string[] = [];
