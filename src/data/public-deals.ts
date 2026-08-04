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
 * THREE INDEPENDENT SAFETY PROPERTIES (see server/sources/deal-declassification.ts):
 *   1. An entry here is honored ONLY if the deal also fails to match any ACTIVE group in
 *      confidential-terms.json — scanning the WHOLE deal record, including the free-text
 *      status/nextAction fields. The roster always wins; this list can never override it.
 *   2. If the terms file is missing or unreadable, the whole allowlist goes inert and every
 *      unmatched deal stays confidential.
 *   3. If the roster loaded is the PLACEHOLDER stand-in (CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER=1
 *      with the real file absent), the allowlist is likewise inert. Property 2 alone was NOT
 *      sufficient — that env makes the loader return a stub instead of throwing, so the gate
 *      failed OPEN until this was added (caught in review 2026-08-04, before any entry existed).
 *
 * Ids are the merged snapshot ids (`notion-<slug of the Notion Deal Name>`). Deliberately EMPTY:
 * populating it is a per-deal call for Gabriel, not an inference from a deal's stage — "Dead" is
 * not by itself evidence that a price or counterparty may be published.
 */
export const PUBLIC_DEAL_IDS: readonly string[] = [];
