// tests/unit/notion-market-map.test.ts
//
// MARKET_MAP is keyed on Notion "Market" select values. The defect this pins (found 2026-08-12) is
// not a wrong mapping but a mapping keyed on strings Notion CANNOT EMIT — 'Kansas City MO' when the
// option reads 'Kansas City MO/KS', 'Mid-Atlantic' when it reads 'Maryland (Baltimore/DC)', and
// 'Toledo OH' which is not an option at all. Three of six keys were dead, and the failure mode is
// silent: an unmapped value resolves to 'Other', which looks like data rather than a missing entry.
//
// So the assertion has to be stated against the LIVE option list, not against the map's own keys —
// a test written over the map would have passed throughout.
import { describe, it, expect } from 'vitest';
import { mapNotionPage } from '../../server/sources/notion-deals';

/**
 * The live options on the Acquisition Pipeline Tracker's "Market" select, read from the Notion API
 * on 2026-08-12. If Notion's select changes, this list is what must be re-read — and the failing
 * test below is the notice that MARKET_MAP needs an entry.
 */
const LIVE_MARKET_OPTIONS = [
  'Columbus OH',
  'Cincinnati OH',
  'Cleveland OH',
  'Indianapolis IN',
  'Kansas City MO/KS',
  'Maryland (Baltimore/DC)',
  'Madison WI',
  'Grand Rapids MI',
  'Richmond VA',
  'Des Moines IA',
  'Louisville KY',
  'Other',
] as const;

const pageWithMarket = (market: string) => ({
  properties: {
    'Deal Name': { type: 'title', title: [{ plain_text: 'Some Deal' }] },
    Market: { type: 'select', select: { name: market } },
  },
});

describe('MARKET_MAP covers every live Notion Market option', () => {
  it.each(LIVE_MARKET_OPTIONS.filter((m) => m !== 'Other'))(
    'maps %s to a real market, not the Other sentinel',
    (option) => {
      expect(mapNotionPage(pageWithMarket(option))!.market).not.toBe('Other');
    },
  );

  it('maps the two options whose Notion spelling differs from the enum member', () => {
    // These are the keys that were dead. Pinned by VALUE, so a future rename of either side fails
    // here instead of quietly resolving to 'Other'.
    expect(mapNotionPage(pageWithMarket('Kansas City MO/KS'))!.market).toBe('Kansas City MO');
    expect(mapNotionPage(pageWithMarket('Maryland (Baltimore/DC)'))!.market).toBe('Mid-Atlantic');
  });

  it('still resolves a genuinely unknown option to Other rather than throwing', () => {
    expect(mapNotionPage(pageWithMarket('Boise ID'))!.market).toBe('Other');
  });

  it('leaves an unset Market null — null is "not stated", Other is "not mapped"', () => {
    const p = { properties: { 'Deal Name': { type: 'title', title: [{ plain_text: 'D' }] } } };
    expect(mapNotionPage(p)!.market).toBeNull();
  });
});

/**
 * The Stage select, same defect class as the Market one and found the same way — by running the
 * cutover against live data, not by reading the map. 'Killed' was absent while the select offered
 * it, so a killed deal took mapStage's DEFAULT. That default is 'Candidate', which is not neutral:
 * it asserts an active early-stage deal. One live row (seed-matched and public) was publishing to
 * the mirror as a Candidate while Notion said Killed.
 */
const LIVE_STAGE_OPTIONS = [
  'Closing',
  'Under Contract',
  'Due Diligence',
  'LOI Executed',
  'LOI Pending',
  'Candidate',
  'Closed Won',
  'Passed',
  'Killed',
] as const;

const pageWithStage = (stage: string) => ({
  properties: {
    'Deal Name': { type: 'title', title: [{ plain_text: 'Some Deal' }] },
    Stage: { type: 'select', select: { name: stage } },
  },
});

describe('STAGE_MAP covers every live Notion Stage option', () => {
  it.each(LIVE_STAGE_OPTIONS.filter((s) => s !== 'Candidate'))(
    'maps %s to something other than the Candidate default',
    (option) => {
      // Any option resolving to 'Candidate' is indistinguishable from an unmapped one, and the
      // failure is silent: a dead deal presents as live. Only 'Candidate' may map to 'Candidate'.
      expect(mapNotionPage(pageWithStage(option))!.stage).not.toBe('Candidate');
    },
  );

  it('maps both terminal-negative options to Dead', () => {
    expect(mapNotionPage(pageWithStage('Passed'))!.stage).toBe('Dead');
    expect(mapNotionPage(pageWithStage('Killed'))!.stage).toBe('Dead');
  });
});
