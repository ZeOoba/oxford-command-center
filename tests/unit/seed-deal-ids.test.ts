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
 * Pipeline Tracker to carry one — verified against the live tracker 2026-08-13 (20 rows, DEAL-1..20,
 * neither of these among them).
 *
 * The tracker holds acquisition SOURCING candidates. These two are neither: FVC is a closing on an
 * asset ORA is acquiring, and Banwick/Morrison is a refinance of an owned asset. They publish their
 * seed values and join nothing, which is correct.
 *
 * This list is the difference between "deliberately not in the pipeline" and "someone forgot to
 * mirror an id" — states that are otherwise identical in the data and have opposite consequences.
 * Adding an entry is a deliberate, diff-visible act; the second test below fails if an entry ever
 * goes stale.
 */
const NOT_IN_PIPELINE: ReadonlySet<string> = new Set(['REDACTED-649', 'REDACTED-352']);

describe('seed-deals.ts — every row carries its Notion Deal ID', () => {
  it('has no row with a null notionDealId outside the explicit NOT_IN_PIPELINE list', () => {
    const missing = SEED_DEALS.filter((d) => !d.notionDealId && !NOT_IN_PIPELINE.has(d.id)).map((d) => d.id);
    expect(
      missing,
      `These seed rows have no notionDealId, so they CANNOT join their live Notion row and will ` +
        `publish stale seed figures as if live: ${missing.join(', ')}. Copy each row's "Deal ID" ` +
        `from the Notion Acquisition Pipeline Tracker into src/data/seed-deals.ts. If a row genuinely ` +
        `has no tracker entry, add it to NOT_IN_PIPELINE above with the reason — do not leave the ` +
        `null unexplained, because a forgotten id looks exactly like an intentional one.`,
    ).toEqual([]);
  });

  it('has no STALE NOT_IN_PIPELINE entry — an id there means the exemption is obsolete', () => {
    // Guards the list in the other direction: once a deal does get a tracker row and an id, its
    // exemption is a lie that would let a future null slip through unnoticed.
    const stale = SEED_DEALS.filter((d) => d.notionDealId && NOT_IN_PIPELINE.has(d.id)).map((d) => d.id);
    expect(stale, `NOT_IN_PIPELINE lists rows that now HAVE a Deal ID: ${stale.join(', ')}`).toEqual([]);
    const unknown = [...NOT_IN_PIPELINE].filter((id) => !SEED_DEALS.some((d) => d.id === id));
    expect(unknown, `NOT_IN_PIPELINE names rows not in SEED_DEALS: ${unknown.join(', ')}`).toEqual([]);
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
