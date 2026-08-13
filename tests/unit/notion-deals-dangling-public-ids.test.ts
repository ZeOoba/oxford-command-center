// tests/unit/notion-deals-dangling-public-ids.test.ts
//
// Isolated in its own file: mocking src/data/public-deals.ts to a non-empty array makes
// mergeDeals' dangling-entry tripwire fire on every OTHER test in notion-deals.test.ts that
// asserts console.warn call counts (the real PUBLIC_DEAL_IDS is empty, so the tripwire is
// normally silent everywhere else). One mock, one concern, no cross-test pollution.
import { describe, it, expect, vi } from 'vitest';
import type { Deal, DataQualityFlag } from '../../src/contracts/index';

vi.mock('../../src/data/public-deals', () => ({ PUBLIC_DEAL_IDS: ['dangling-fixture-id'] }));

const deal = (o: Partial<Deal>): Deal => ({
  id: 'd', name: 'D', shortName: null, location: null, market: null, sf: null, buildings: null,
  stage: 'Candidate', estPrice: null, capRate: null, irr: null, equityMultiple: null, holdYrs: null,
  lender: null, status: null, nextAction: null, owner: null, targetCloseDate: null,
  notionDealId: null, confidential: false, estimatedFields: [], ...o,
});

describe('mergeDeals — REFUTE: a dangling PUBLIC_DEAL_IDS entry must not fail silently', () => {
  // Adversarial pass, 2026-08-13, all 3 lenses. isDeclassified()'s not-in-allowlist path returns
  // false with zero signal — correct for the common case, but it makes the OPPOSITE failure
  // invisible: an entry that WAS meant to match (a ratified Gabriel publication decision) but no
  // longer does — its id format went stale, or the Notion row was deleted and re-created — silently
  // reverts that decision to confidential with no flag anywhere.
  it('warns when a PUBLIC_DEAL_IDS entry matches no published deal', async () => {
    const { mergeDeals } = await import('../../server/sources/notion-deals');
    const flags: DataQualityFlag[] = [];
    const out = mergeDeals([], [], flags);
    expect(out).toHaveLength(0); // the mocked entry matches nothing real — nothing to publish either way
    const dangling = flags.find((f) => f.field === 'publicDealIds');
    expect(dangling?.severity).toBe('warn');
    // The dangling entry might itself be the stale name-derived format this tripwire exists to
    // catch, so it must never appear raw in the published flag.
    expect(dangling?.issue).not.toContain('dangling-fixture-id');
    expect(dangling?.rawValue).not.toBe('dangling-fixture-id');
  });

  it('stays silent once a published deal actually carries the allowlisted id', async () => {
    const { mergeDeals } = await import('../../server/sources/notion-deals');
    const live = [deal({ id: 'dangling-fixture-id', name: 'N', notionDealId: null })];
    const flags: DataQualityFlag[] = [];
    mergeDeals([], live, flags);
    expect(flags.some((f) => f.field === 'publicDealIds')).toBe(false);
  });
});
