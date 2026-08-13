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

describe('seed-deals.ts — every row carries its Notion Deal ID', () => {
  it('has no row with a null notionDealId', () => {
    const missing = SEED_DEALS.filter((d) => !d.notionDealId).map((d) => d.id);
    expect(
      missing,
      `These seed rows have no notionDealId, so they CANNOT join their live Notion row and will ` +
        `publish stale seed figures as if live: ${missing.join(', ')}. Copy each row's "Deal ID" ` +
        `from the Notion Acquisition Pipeline Tracker into src/data/seed-deals.ts. A seed deal that ` +
        `genuinely is not in the live pipeline should be removed from the seed set rather than left ` +
        `idless — an unjoinable row that still publishes is the failure this guards.`,
    ).toEqual([]);
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
