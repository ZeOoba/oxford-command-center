// tests/unit/deal-name-gate.test.ts
//
// Direct unit tests for the confidential-deal egress gate (server/ai/deal-name-gate.ts). Until now the
// gate was only exercised indirectly through the agent and OM-extract egress tests; this file pins its
// own contract branch by branch:
//
//   tightenDeals          — fail-closed on a throwing roster, never loosens a flag, never mutates input.
//   confidentialDealNames — FULL name for every confidential deal; shortName ONLY for a deal the live
//                           roster claims while its served flag is still false (the stale-flag window).
//   mentionsAnyName       — case / accent / separator / camelCase / percent-encoding (UTF-8, %2520,
//                           Latin-1) / hyphenated-line-wrap folding, nested payloads, negative controls.
//   mentionsClaimedDeal   — the end-to-end composition the agent and OM extract call.
//
// Every deal name here is SYNTHETIC ("Zorvane ..."). Never put a real roster name in this file.
import { describe, it, expect } from 'vitest';
import { Deal } from '../../src/contracts/index';
import {
  tightenDeals,
  confidentialDealNames,
  mentionsClaimedDeal,
  mentionsAnyName,
} from '../../server/ai/deal-name-gate';

const FULL = 'Zorvane Commerce Center';
const SHORT = 'Zorvane';
/** Two words, compact form 7 chars: below the gate's compact-substring minimum (8). */
const TWO_WORD_SHORT = 'Zor Park';

function makeDeal(overrides: Partial<Deal> = {}): Deal {
  return Deal.parse({
    id: 'd-zorvane',
    name: FULL,
    shortName: SHORT,
    location: null,
    market: null,
    sf: null,
    buildings: null,
    stage: 'Candidate',
    estPrice: null,
    capRate: null,
    irr: null,
    equityMultiple: null,
    holdYrs: null,
    lender: null,
    status: null,
    nextAction: null,
    owner: null,
    targetCloseDate: null,
    ...overrides,
  });
}

const claimAll = (): boolean => true;
const claimNone = (): boolean => false;
const claimThrows = (): boolean => {
  throw new Error('roster unavailable');
};

describe('tightenDeals', () => {
  it('with no claimer returns a shallow copy (new array, same deals, nothing tightened)', () => {
    const deals = [makeDeal(), makeDeal({ id: 'd2', confidential: true })];
    const out = tightenDeals(deals, undefined);
    expect(out).not.toBe(deals);
    expect(out).toEqual(deals);
    expect(out[0]).toBe(deals[0]);
    expect(out[0]!.confidential).toBe(false);
  });

  it('tightens a deal the live roster claims', () => {
    const [out] = tightenDeals([makeDeal()], claimAll);
    expect(out!.confidential).toBe(true);
  });

  it('fails CLOSED: a throwing claimer marks the deal confidential', () => {
    const [out] = tightenDeals([makeDeal()], claimThrows);
    expect(out!.confidential).toBe(true);
  });

  it('fails closed per deal: one throw does not abort or loosen the rest', () => {
    const deals = [makeDeal({ id: 'a' }), makeDeal({ id: 'b' }), makeDeal({ id: 'c' })];
    const out = tightenDeals(deals, (d) => {
      if (d.id === 'b') throw new Error('roster read failed for b');
      return false;
    });
    expect(out.map((d) => d.confidential)).toEqual([false, true, false]);
  });

  it('leaves an unclaimed, unflagged deal untouched (same object)', () => {
    const deals = [makeDeal()];
    const out = tightenDeals(deals, claimNone);
    expect(out[0]).toBe(deals[0]);
    expect(out[0]!.confidential).toBe(false);
  });

  it('never loosens: a flagged deal stays confidential when the roster does not claim it', () => {
    const flagged = makeDeal({ confidential: true });
    const out = tightenDeals([flagged], claimNone);
    expect(out[0]!.confidential).toBe(true);
    expect(out[0]).toBe(flagged);
  });

  it('never loosens: a flagged deal stays confidential when the claimer throws', () => {
    const out = tightenDeals([makeDeal({ confidential: true })], claimThrows);
    expect(out[0]!.confidential).toBe(true);
  });

  it('does not consult the claimer for an already-flagged deal', () => {
    const seen: string[] = [];
    tightenDeals([makeDeal({ id: 'flagged', confidential: true }), makeDeal({ id: 'open' })], (d) => {
      seen.push(d.id);
      return false;
    });
    expect(seen).toEqual(['open']);
  });

  it('does not mutate frozen input (returns a new object for a tightened deal)', () => {
    const d = Object.freeze(makeDeal());
    const deals = Object.freeze([d]);
    const out = tightenDeals(deals, claimAll);
    expect(d.confidential).toBe(false);
    expect(out[0]).not.toBe(d);
    expect(out[0]!.confidential).toBe(true);
    expect(out[0]!.name).toBe(FULL);
  });
});

describe('confidentialDealNames', () => {
  it('a FLAGGED deal yields its full name only, never its shortName (ratified tools.ts rule)', () => {
    const flagged = makeDeal({ confidential: true });
    expect(confidentialDealNames([flagged], claimNone)).toEqual([FULL]);
    // Even when the live roster also claims it: the served flag already covers it.
    expect(confidentialDealNames([flagged], claimAll)).toEqual([FULL]);
  });

  it('a live-claimed deal whose served flag is still false yields name AND shortName', () => {
    expect(confidentialDealNames([makeDeal()], claimAll)).toEqual([FULL, SHORT]);
  });

  it('a throwing claimer is treated as claimed: name AND shortName (fail closed)', () => {
    expect(confidentialDealNames([makeDeal()], claimThrows)).toEqual([FULL, SHORT]);
  });

  it('an unclaimed, unflagged deal yields nothing', () => {
    expect(confidentialDealNames([makeDeal()], claimNone)).toEqual([]);
  });

  it('a claimed deal with no shortName yields the full name only', () => {
    expect(confidentialDealNames([makeDeal({ shortName: null })], claimAll)).toEqual([FULL]);
  });

  it('scopes per deal across a mixed list', () => {
    const deals = [
      makeDeal({ id: 'flagged', name: 'Zorvane Flagged Park', shortName: 'ZFlag', confidential: true }),
      makeDeal({ id: 'live', name: 'Zorvane Live Yard', shortName: 'ZLive' }),
      makeDeal({ id: 'open', name: 'Zorvane Open Lot', shortName: 'ZOpen' }),
    ];
    const names = confidentialDealNames(deals, (d) => d.id === 'live');
    expect(names).toEqual(['Zorvane Flagged Park', 'Zorvane Live Yard', 'ZLive']);
  });
});

describe('mentionsAnyName', () => {
  const names = [FULL];

  it('returns false for an empty name list, whatever the payload', () => {
    expect(mentionsAnyName(`${FULL} ${SHORT}`, [])).toBe(false);
  });

  it('matches the exact name', () => {
    expect(mentionsAnyName(`Tour of ${FULL} on Friday`, names)).toBe(true);
  });

  it.each([
    ['upper case', 'ZORVANE COMMERCE CENTER'],
    ['lower case', 'zorvane commerce center'],
    ['accented', 'Zörvâne Commerce Cénter'],
    ['extra whitespace / newline', 'Zorvane   Commerce\n Center'],
    ['underscore file name', 'LOI_Zorvane_Commerce_Center_11052026.pdf'],
    ['hyphen slug', 'https://example.test/deals/zorvane-commerce-center'],
    ['dotted', 'zorvane.commerce.center'],
    ['path separators', 'Deals/Zorvane/Commerce/Center/om.pdf'],
    ['CamelCase token', 'ZorvaneCommerceCenter_OM.pdf'],
    ['all-caps compact token', 'ZORVANECOMMERCECENTER.XLSX'],
  ])('folds %s', (_label, text) => {
    expect(mentionsAnyName(text, names)).toBe(true);
  });

  it('decodes %20 (SharePoint / download names)', () => {
    expect(mentionsAnyName('https://x.sharepoint.test/Shared%20Documents/Zorvane%20Commerce%20Center.pdf', names)).toBe(true);
  });

  it('decodes double-encoded %2520 (Safe Links wrapping a SharePoint link)', () => {
    expect(mentionsAnyName('https://safelinks.test/?url=Zorvane%2520Commerce%2520Center', names)).toBe(true);
  });

  it('decodes a Latin-1 %E9 escape (legacy escape()) and folds the accent', () => {
    // 'Café Zorvane' written by a Latin-1 encoder: é -> %E9, which is not valid UTF-8.
    expect(mentionsAnyName('Caf%E9%20Zorvane', ['Café Zorvane'])).toBe(true);
  });

  it('a stray undecodable %FF becomes a separator and cannot glue two words of the name together', () => {
    // 'Zor Park' compacts to 7 chars (below the compact-substring minimum) and the shared substring
    // normalizer misses the raw text, so only the gate's %FF -> separator decode can catch this.
    // Dropped ('zorpark') or Latin-1-decoded ('zorÿpark'), the byte would hide the name.
    expect(mentionsAnyName('zorpark', [TWO_WORD_SHORT])).toBe(false);
    expect(mentionsAnyName('zor%FFpark', [TWO_WORD_SHORT])).toBe(true);
  });

  it('rejoins a hyphenated line wrap ("Zor-\\nvane")', () => {
    // Again the short name, so the compact pass cannot rescue it: only the de-hyphenation catches it.
    expect(mentionsAnyName('Call re Zor-\nvane before close', [SHORT])).toBe(true);
  });

  it('finds the name inside nested object and array payloads', () => {
    const payload = {
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: [{ type: 'text', text: 'see notes' }, { type: 'text', text: `re ${FULL}` }] },
      ],
      meta: { tags: ['a', { deep: { deeper: ['zorvane_commerce_center'] } }] },
    };
    expect(mentionsAnyName(payload, names)).toBe(true);
  });

  it('negative control: unrelated text and near-misses do not match', () => {
    expect(mentionsAnyName('Commerce Center of Columbus, OH — 40,000 SF flex', names)).toBe(false);
    expect(mentionsAnyName('Zorvan Commerce Centre', names)).toBe(false);
    expect(mentionsAnyName({ a: ['nothing', { b: 'to see here' }], n: 42 }, names)).toBe(false);
    expect(mentionsAnyName('', names)).toBe(false);
    expect(mentionsAnyName(null, names)).toBe(false);
  });

  it('pins the deliberate over-match: the shared normalizer is a SUBSTRING scan, so a name inside a longer word is a hit', () => {
    // Fails toward refusing an egress, never toward leaking. Pinned so a tightening is a conscious change.
    expect(mentionsAnyName('the Zorvanex lot', [SHORT])).toBe(true);
  });

  // A two-word name whose compact form ('zorpark', 7 chars) is below the compact-substring minimum and
  // which the shared normalizer misses on the raw text: each of these is caught ONLY by the gate's own
  // separator / camelCase / percent-decode folding, so these cases pin that layer specifically.
  it.each([
    ['underscore file name', 'LOI_Zor_Park_11052026.pdf'],
    ['hyphen slug', 'deals/zor-park/om'],
    ['CamelCase token', 'ZorPark_OM.pdf'],
    ['%20', 'Shared%20Documents/Zor%20Park.pdf'],
    ['%2520', 'safelinks.test/?u=Zor%2520Park'],
  ])('gate-only folding catches %s for a short two-word name', (_label, text) => {
    expect(mentionsAnyName(text, [TWO_WORD_SHORT])).toBe(true);
  });

  it('matches across the camelCase split on one side only (all-caps haystack vs CamelCase name)', () => {
    expect(mentionsAnyName('MCZORV-RD', ['McZorv Rd'])).toBe(true);
  });
});

describe('mentionsClaimedDeal (composition)', () => {
  it('an unclaimed, unflagged deal is not a hit even when named', () => {
    expect(mentionsClaimedDeal(`${FULL} and ${SHORT}`, [makeDeal()], claimNone)).toBe(false);
  });

  it('a live-claimed deal is a hit on its full name and on its shortName alone', () => {
    expect(mentionsClaimedDeal(`Draft LOI for ${FULL}`, [makeDeal()], claimAll)).toBe(true);
    expect(mentionsClaimedDeal(`Draft LOI for ${SHORT}`, [makeDeal()], claimAll)).toBe(true);
  });

  it('a throwing claimer fails closed: the shortName alone is a hit', () => {
    expect(mentionsClaimedDeal(`Draft LOI for ${SHORT}`, [makeDeal()], claimThrows)).toBe(true);
  });

  it('a flagged deal is a hit on its full name but NOT on its shortName alone (deliberate)', () => {
    const flagged = makeDeal({ confidential: true });
    expect(mentionsClaimedDeal(`Draft LOI for ${FULL}`, [flagged], claimNone)).toBe(true);
    expect(mentionsClaimedDeal(`Draft LOI for ${SHORT}`, [flagged], claimNone)).toBe(false);
  });

  it('matches an encoded file-name form end to end', () => {
    expect(mentionsClaimedDeal({ body: 'PSA_Zorvane%20Commerce%20Center_11052026.pdf' }, [makeDeal()], claimAll)).toBe(true);
  });
});
