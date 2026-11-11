// tests/unit/seed-deal-ids.test.ts
//
// THE CUTOVER GATE. This file is the mechanical enforcement of a claim that was, until the refute
// pass caught it, only a promise in a commit message.
//
// The id join admits no gradual migration: a seed row with notionDealId:null cannot join, so it
// publishes its own hand-set stage and null economics AS IF they were the live pipeline, while the
// live counterpart double-lists as a redacted extra. Merging the branch before the ids were filled
// would have done that to all six seed rows — and it would have done it GATE-GREEN, because the
// migration tripwire is warn-severity by design and the error-severity checkSnapshot backstop was
// deleted in the same change.
//
// "A human remembers to fill these in before merging" is precisely the class of guarantee this
// subsystem has already paid for four times. So it is a test instead.
// (Refute pass 2026-08-12, correctness lens, HIGH.)
import { describe, it, expect } from 'vitest';
import { SEED_DEALS } from '../../src/data/seed-deals';

/**
 * Seed rows that deliberately carry NO Deal ID, because they have no row in the Acquisition
 * Pipeline Tracker to carry one (verified against the live tracker 2026-08-13).
 *
 * The tracker holds acquisition SOURCING candidates. A closing on an asset ORA is acquiring and a
 * refinance of an owned asset are neither: they publish their seed values and join nothing, which is
 * correct. Those are exactly the NOT_IN_PIPELINE_STAGES below.
 *
 * Keyed by stage, not by id (changed 2026-11-10): seed-deals.ts is local-only real data with a
 * synthetic stand-in in CI (ruling 2026-11-10), so a hardcoded id list would name real deals in a
 * tracked file and could not hold for both copies. The stage rule is the documented reason itself, so
 * a forgotten id on a sourcing candidate still fails, and an exemption still cannot go stale silently.
 */
const NOT_IN_PIPELINE_STAGES: ReadonlySet<string> = new Set(['Closing', 'Closed', 'Refinance']);
const exempt = (d: { stage: string }): boolean => NOT_IN_PIPELINE_STAGES.has(d.stage);

describe('seed-deals.ts — every row carries its Notion Deal ID', () => {
  it('has no row with a null notionDealId outside the explicit NOT_IN_PIPELINE list', () => {
    const missing = SEED_DEALS.filter((d) => !d.notionDealId && !exempt(d)).map((d) => d.id);
    expect(
      missing,
      `These seed rows have no notionDealId, so they CANNOT join their live Notion row and will ` +
        `publish stale seed figures as if live: ${missing.join(', ')}. Copy each row's "Deal ID" ` +
        `from the Notion Acquisition Pipeline Tracker into src/data/seed-deals.ts. If a row genuinely ` +
        `has no tracker entry, its stage must say why (NOT_IN_PIPELINE_STAGES above) — do not leave the ` +
        `null unexplained, because a forgotten id looks exactly like an intentional one.`,
    ).toEqual([]);
  });

  it('every exempt (closing / refinance) row really has no Deal ID, and at least one sourcing row carries one', () => {
    // Guards the rule in the other direction: a closing/refinance row that DOES carry an id is either
    // a sourcing candidate mis-staged or a stale exemption; and a seed with no id at all means the
    // join was never wired.
    const staleExempt = SEED_DEALS.filter((d) => exempt(d) && d.notionDealId).map((d) => d.id);
    expect(staleExempt, `closing/refinance rows that now HAVE a Deal ID: ${staleExempt.join(', ')}`).toEqual([]);
    expect(SEED_DEALS.some((d) => !exempt(d) && d.notionDealId)).toBe(true);
  });

  it('has no two rows sharing a notionDealId', () => {
    const ids = SEED_DEALS.map((d) => d.notionDealId).filter((x): x is string => !!x);
    const dupes = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
    expect(dupes, `duplicate notionDealId in the seed set: ${dupes.join(', ')}`).toEqual([]);
  });

  it('uses the "<PREFIX>-<n>" shape Notion emits, not a hand-invented identifier', () => {
    // Catches a seed row given a made-up id (a slug, a name, a UUID) rather than the value Notion
    // assigned — which would join to nothing and fail closed, but silently and confusingly.
    // Null is the FIRST case's business, not this one — asserting it here too produced a
    // second, noisier TypeError for one underlying cause and buried the actionable message.
    const malformed = SEED_DEALS.filter((d) => d.notionDealId && !/^[A-Z]+-\d+$|^\d+$/.test(d.notionDealId))
      .map((d) => `${d.id}=${d.notionDealId}`);
    expect(malformed, `hand-invented Deal ID(s): ${malformed.join(', ')}`).toEqual([]);
  });
});
