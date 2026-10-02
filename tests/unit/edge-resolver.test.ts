// tests/unit/edge-resolver.test.ts — F2 / F13 (spec §8.4, §9). No fuzzy matching, no default.
import { describe, expect, it } from 'vitest';
import { Market } from '@contracts/common';
import type { Deal } from '@contracts/index';
import {
  EDGE_TIER1_TABLE, EDGE_TIER2_MARKETS, EDGE_UNMATCHED_TEXT, edgeCandidateCell, findDealForCandidate, parseCityState,
  resolveEdgeMarket,
} from '../../src/modules/acquisitions/edge-hooks';
import { cell, fourMarkets, mkMarket, mkMarketsResponse } from './edge-test-helpers';

const MARKETS = [
  mkMarket('columbus', 'Columbus', 'OH', 'named'),
  mkMarket('cleveland', 'Cleveland', 'OH', 'auto'),
  mkMarket('hagerstown', 'Hagerstown', 'MD', 'named'),
  mkMarket('indianapolis_south', 'Indianapolis (South Metro)', 'IN', 'named_custom'),
  mkMarket('indianapolis_carmel_greenwood', 'Indianapolis-Carmel-Greenwood', 'IN', 'auto'),
  mkMarket('washington_arlington_alexandria', 'Washington-Arlington-Alexandria', 'DC', 'auto'),
  mkMarket('scranton_wilkes_barre', 'Scranton--Wilkes-Barre', 'PA', 'auto'),
  mkMarket('kansas_city', 'Kansas City', 'MO', 'named'),
];
const deal = (market: Deal['market'], location: string | null) => ({ market, location });

describe('Tier 1 (Deal.market enum)', () => {
  it('every Market member is either in the reviewed table or deferred to Tier 2 (enum-completeness guard)', () => {
    for (const m of Market.options) {
      const inTier1 = Object.prototype.hasOwnProperty.call(EDGE_TIER1_TABLE, m);
      expect(inTier1 || EDGE_TIER2_MARKETS.has(m), `Market '${m}' has no Edge decision`).toBe(true);
      expect(inTier1 && EDGE_TIER2_MARKETS.has(m), `Market '${m}' is in both tiers`).toBe(false);
    }
  });

  it("'Indianapolis IN' maps to the full CBSA, never the South cut", () => {
    expect(EDGE_TIER1_TABLE['Indianapolis IN']).toBe('indianapolis_carmel_greenwood');
    const r = resolveEdgeMarket(deal('Indianapolis IN', null), MARKETS);
    expect(r).toMatchObject({ kind: 'matched', via: 'tier1_market', market: { id: 'indianapolis_carmel_greenwood' } });
  });

  it("'Twinsburg, OH (Cleveland MSA)' with market Cleveland MSA → tier 1 cleveland", () => {
    const r = resolveEdgeMarket(deal('Cleveland MSA', 'Twinsburg, OH (Cleveland MSA)'), MARKETS);
    expect(r).toMatchObject({ kind: 'matched', via: 'tier1_market', market: { id: 'cleveland' } });
  });

  it('conflicting_location: a Tier-1 market whose state contradicts the location state is unmatched, never guessed', () => {
    expect(resolveEdgeMarket(deal('Columbus OH', 'Columbus, IN'), MARKETS)).toEqual({ kind: 'unmatched', reason: 'conflicting_location' });
    expect(resolveEdgeMarket(deal('Kansas City MO', 'Kansas City, TX'), MARKETS)).toEqual({ kind: 'unmatched', reason: 'conflicting_location' });
    expect(EDGE_UNMATCHED_TEXT.conflicting_location).toMatch(/different states/);
  });

  // Gabriel ruling 2026-10-02 (spec §8.4): bi-state metros resolve when the location state is in the market's reviewed allowed set.
  describe('per-market allowed states', () => {
    const BI = [
      mkMarket('kansas_city', 'Kansas City', 'MO', 'named'),
      mkMarket('cincinnati', 'Cincinnati', 'OH', 'named'),
      mkMarket('louisville', 'Louisville', 'KY', 'named'),
      mkMarket('toledo', 'Toledo', 'OH', 'auto'),
      mkMarket('columbus', 'Columbus', 'OH', 'named'),
    ];
    const conflict = { kind: 'unmatched', reason: 'conflicting_location' };
    it('Kansas City MO + Lenexa, KS resolves to Kansas City via Tier 1', () => {
      expect(resolveEdgeMarket(deal('Kansas City MO', 'Lenexa, KS'), BI)).toMatchObject({ kind: 'matched', via: 'tier1_market', market: { id: 'kansas_city' } });
    });
    it('Cincinnati OH + Florence, KY and Louisville KY + Jeffersonville, IN resolve', () => {
      expect(resolveEdgeMarket(deal('Cincinnati OH', 'Florence, KY'), BI)).toMatchObject({ kind: 'matched', market: { id: 'cincinnati' } });
      expect(resolveEdgeMarket(deal('Cincinnati OH', 'Lawrenceburg, IN'), BI)).toMatchObject({ kind: 'matched', market: { id: 'cincinnati' } });
      expect(resolveEdgeMarket(deal('Louisville KY', 'Jeffersonville, IN'), BI)).toMatchObject({ kind: 'matched', market: { id: 'louisville' } });
    });
    it('states outside the allowed set still conflict', () => {
      expect(resolveEdgeMarket(deal('Columbus OH', 'Columbus, IN'), BI)).toEqual(conflict);
      expect(resolveEdgeMarket(deal('Toledo OH', 'Detroit, MI'), BI)).toEqual(conflict);
      expect(resolveEdgeMarket(deal('Louisville KY', 'Cincinnati, OH'), BI)).toEqual(conflict);
      expect(resolveEdgeMarket(deal('Kansas City MO', 'Omaha, NE'), BI)).toEqual(conflict);
    });
  });

  it('matching state, absent location, or unparseable location still resolves via Tier 1', () => {
    expect(resolveEdgeMarket(deal('Columbus OH', 'Dublin, OH'), MARKETS)).toMatchObject({ kind: 'matched', via: 'tier1_market', market: { id: 'columbus' } });
    expect(resolveEdgeMarket(deal('Columbus OH', null), MARKETS)).toMatchObject({ kind: 'matched', market: { id: 'columbus' } });
    expect(resolveEdgeMarket(deal('Columbus OH', 'TBD'), MARKETS)).toMatchObject({ kind: 'matched', market: { id: 'columbus' } });
  });

  it('Mid-Atlantic / Other / Unknown never produce conflicting_location', () => {
    for (const market of ['Mid-Atlantic', 'Other', 'Unknown'] as const) {
      const r = resolveEdgeMarket(deal(market, 'Columbus, IN'), MARKETS);
      expect(r).toEqual({ kind: 'unmatched', reason: 'no_market_for_location' });
    }
  });

  it('a table id missing from markets.json → edge_id_absent, never a substitute', () => {
    expect(resolveEdgeMarket(deal('Toledo OH', 'Toledo, OH'), MARKETS)).toEqual({ kind: 'unmatched', reason: 'edge_id_absent' });
  });
});

describe('Tier 2 (Deal.location exact City, ST)', () => {
  it('Mid-Atlantic + Hagerstown, MD → hagerstown', () => {
    expect(resolveEdgeMarket(deal('Mid-Atlantic', 'Hagerstown, MD'), MARKETS)).toMatchObject({
      kind: 'matched', via: 'tier2_location', market: { id: 'hagerstown' },
    });
  });

  it('Mid-Atlantic + Salisbury, MD → unmatched', () => {
    expect(resolveEdgeMarket(deal('Mid-Atlantic', 'Salisbury, MD'), MARKETS)).toEqual({ kind: 'unmatched', reason: 'no_market_for_location' });
  });

  it('TBD → no_location', () => {
    expect(resolveEdgeMarket(deal(null, 'TBD'), MARKETS)).toEqual({ kind: 'unmatched', reason: 'no_location' });
    expect(resolveEdgeMarket(deal(null, null), MARKETS)).toEqual({ kind: 'unmatched', reason: 'no_location' });
  });

  it('Columbus, IN never resolves to Columbus OH (state-checked)', () => {
    expect(resolveEdgeMarket(deal('Other', 'Columbus, IN'), MARKETS)).toEqual({ kind: 'unmatched', reason: 'no_market_for_location' });
  });

  it('F13: Alexandria, VA does not match the DC-primary CBSA', () => {
    expect(resolveEdgeMarket(deal('Other', 'Alexandria, VA'), MARKETS)).toEqual({ kind: 'unmatched', reason: 'no_market_for_location' });
  });

  it('street address + city: Indianapolis resolves to the full CBSA by principal city, not the South cut', () => {
    expect(resolveEdgeMarket(deal(null, '3849 N Richardt, Indianapolis, IN'), MARKETS)).toMatchObject({
      kind: 'matched', market: { id: 'indianapolis_carmel_greenwood' },
    });
  });

  it('matches the CBSA principal city on a double-hyphen title', () => {
    expect(resolveEdgeMarket(deal('Unknown', 'Scranton, PA'), MARKETS)).toMatchObject({ kind: 'matched', market: { id: 'scranton_wilkes_barre' } });
  });

  it('two candidates → ambiguous, never picks one', () => {
    const twins = [mkMarket('springfield', 'Springfield', 'MO', 'auto'), mkMarket('springfield_x', 'Springfield-Branson', 'MO', 'auto')];
    expect(resolveEdgeMarket(deal('Other', 'Springfield, MO'), twins)).toEqual({ kind: 'unmatched', reason: 'ambiguous' });
  });

  it('parseCityState takes the LAST City, ST pair after stripping parentheticals', () => {
    expect(parseCityState('3849 N Richardt, Indianapolis, IN')).toEqual({ city: 'Indianapolis', state: 'IN' });
    expect(parseCityState('Twinsburg, OH (Cleveland MSA)')).toEqual({ city: 'Twinsburg', state: 'OH' });
    expect(parseCityState('St. Louis, MO 63101')).toEqual({ city: 'St. Louis', state: 'MO' });
    expect(parseCityState('Columbus, Ohio')).toBeNull();
  });

  it('Kansas City: state-checked on Tier 2 (MO resolves, KS does not)', () => {
    expect(resolveEdgeMarket(deal('Other', 'Kansas City, MO'), MARKETS)).toMatchObject({ kind: 'matched', market: { id: 'kansas_city' } });
    expect(resolveEdgeMarket(deal('Other', 'Kansas City, KS'), MARKETS)).toEqual({ kind: 'unmatched', reason: 'no_market_for_location' });
  });

  it('a ZIP after the state still resolves through the full resolver', () => {
    expect(resolveEdgeMarket(deal(null, '100 Main St, Hagerstown, MD 21740'), MARKETS)).toMatchObject({
      kind: 'matched', market: { id: 'hagerstown' },
    });
  });

  it('multiple parentheticals are all stripped', () => {
    expect(parseCityState('Hagerstown, MD (Washington County) (MSA)')).toEqual({ city: 'Hagerstown', state: 'MD' });
    expect(parseCityState('(Cleveland MSA) Twinsburg, OH (Summit County)')).toEqual({ city: 'Twinsburg', state: 'OH' });
  });

  it('parseCityState caps input at 200 chars (value assertions only; no wall-clock)', () => {
    const hostile = `${'a '.repeat(5000)}x`;
    expect(parseCityState(hostile)).toBeNull();
    expect(parseCityState(`${' '.repeat(300)}Hagerstown, MD`)).toBeNull(); // the pair sits past the 200-char cap
  });

  it('every reason has display text', () => {
    expect(Object.keys(EDGE_UNMATCHED_TEXT).sort()).toEqual([
      'ambiguous', 'conflicting_location', 'edge_id_absent', 'no_location', 'no_market_for_location',
    ]);
  });
});

describe('Sourcing candidate join', () => {
  const columbusDeal: Deal = {
    id: 'page-1', name: 'Fixture', shortName: null, location: 'Columbus, OH', market: 'Columbus OH', sf: null, buildings: null,
    stage: 'Candidate', estPrice: null, capRate: null, irr: null, equityMultiple: null, holdYrs: null, lender: null, status: null,
    nextAction: null, owner: null, targetCloseDate: null, notionDealId: 'DEAL-9', confidential: false, estimatedFields: [],
  };

  it('joins candidate.notionDealId to Deal.id (the Notion page id), never by name', () => {
    expect(findDealForCandidate([columbusDeal], 'page-1')).toBe(columbusDeal);
    expect(findDealForCandidate([columbusDeal], 'DEAL-9')).toBeNull();
    expect(findDealForCandidate([columbusDeal], null)).toBeNull();
  });

  it('edgeCandidateCell renders every state honestly', () => {
    const data = mkMarketsResponse(fourMarkets());
    expect(edgeCandidateCell(null, [columbusDeal], data, 'ready').text).toBe('No Edge market (no linked deal)');
    expect(edgeCandidateCell('page-1', [columbusDeal], undefined, 'idle').text).toBe('—');
    expect(edgeCandidateCell('page-1', [columbusDeal], undefined, 'error').text).toBe('Edge unavailable');
    const ok = edgeCandidateCell('page-1', [columbusDeal], data, 'ready');
    expect(ok.text).toBe('3.0% · +1.8% · STALE');
    expect(ok.title).toContain('Columbus, OH — Flex vacancy: 3.0%');
    expect(ok.title).toContain('STALE (as of 2026-07-14)');
    const errored = edgeCandidateCell('page-1', [columbusDeal], data, 'error');
    expect(errored.text).toBe('Edge unavailable');
    expect(errored.title).toBe('Edge data could not be loaded');
    expect(errored.title).not.toContain('Edge dataset ok');
    expect(edgeCandidateCell('page-1', [columbusDeal], data, 'loading').title).toBe('Loading Edge market data');
    expect(edgeCandidateCell('page-1', [columbusDeal], undefined, 'idle').title).toBe('Edge market data not loaded yet');
    // R2: the unit comes from SERIES_UNITS, never fieldMeta, so a fieldMeta that omits a key cannot change units.
    const noMeta = mkMarketsResponse(fourMarkets(), { fieldMeta: {} });
    const sparse = edgeCandidateCell('page-1', [columbusDeal], noMeta, 'ready');
    expect(sparse.text).toBe('3.0% · +1.8% · STALE');
    expect(sparse.title).toContain('Flex vacancy: 3.0%');
    expect(sparse.title).toContain('Flex rent growth: +1.8%');
    const tbd = { ...columbusDeal, market: null, location: 'TBD' };
    expect(edgeCandidateCell('page-1', [tbd], data, 'ready')).toEqual({ text: 'No Edge market', title: EDGE_UNMATCHED_TEXT.no_location });
    const conflict = { ...columbusDeal, location: 'Columbus, IN' };
    expect(edgeCandidateCell('page-1', [conflict], data, 'ready')).toEqual({
      text: 'No Edge market (conflicting location)', title: EDGE_UNMATCHED_TEXT.conflicting_location,
    });
  });
});

describe('Sourcing cell: estimated / nowcast are visible text (R3f)', () => {
  const dealCol: Deal = {
    id: 'page-1', name: 'Fixture', shortName: null, location: 'Columbus, OH', market: 'Columbus OH', sf: null, buildings: null,
    stage: 'Candidate', estPrice: null, capRate: null, irr: null, equityMultiple: null, holdYrs: null, lender: null, status: null,
    nextAction: null, owner: null, targetCloseDate: null, notionDealId: 'DEAL-9', confidential: false, estimatedFields: [],
  };
  it('appends Est. / Nowcast next to the value when the latest observed status is estimated / nowcast', () => {
    const ms = fourMarkets();
    const col = ms.find((m) => m.id === 'columbus')!;
    col.series = {
      ...col.series,
      vac: cell([5, 4.5, 4, 3.5, 3], ['actual', 'actual', 'actual', 'actual', 'estimated']),
      rent: cell([1, 1.2, 1.4, 1.6, 1.8], ['actual', 'actual', 'actual', 'actual', 'nowcast']),
    };
    const out = edgeCandidateCell('page-1', [dealCol], mkMarketsResponse(ms), 'ready');
    expect(out.text).toBe('3.0% Est. · +1.8% Nowcast · STALE');
  });
});

describe('fix-pass 3 — A2 Unicode city names and B6 gaps', () => {
  it.each([
    ['Montréal, QC', 'Montréal', 'QC'],
    ['Española, NM', 'Española', 'NM'],
    ['Cañon City, CO', 'Cañon City', 'CO'],
    ['12 Rue Saint-Denis, Montréal, QC', 'Montréal', 'QC'],
  ])('parseCityState(%s) keeps the full accented city name', (input, city, state) => {
    expect(parseCityState(input)).toEqual({ city, state });
  });

  it('a 300-space adversarial string with a Unicode city still returns the right value', () => {
    expect(parseCityState(`${' '.repeat(300)}Hagerstown, MD`)).toBeNull();
    expect(parseCityState(`${'é '.repeat(60)},`)).toBeNull();
    expect(parseCityState(`${' '.repeat(150)}Montréal, QC`)).toEqual({ city: 'Montréal', state: 'QC' });
  });

  it('B6: with TWO pairs after parenthetical stripping the LAST pair wins', () => {
    expect(parseCityState('Hagerstown, MD (Washington County) Twinsburg, OH')).toEqual({ city: 'Twinsburg', state: 'OH' });
  });

  it('B6: edgeCandidateCell gives a distinct neutral text per non-ok availability, even with markets present', () => {
    const deal: Deal = {
      id: 'page-1', name: 'Fixture', shortName: null, location: 'Columbus, OH', market: 'Columbus OH', sf: null, buildings: null,
      stage: 'Candidate', estPrice: null, capRate: null, irr: null, equityMultiple: null, holdYrs: null, lender: null, status: null,
      nextAction: null, owner: null, targetCloseDate: null, notionDealId: 'DEAL-9', confidential: false, estimatedFields: [],
    };
    const titles = new Set<string | null>();
    for (const availability of ['missing', 'unreadable', 'invalid'] as const) {
      const data = mkMarketsResponse(fourMarkets(), { availability });
      expect(data.markets.length).toBeGreaterThan(0);
      const cell = edgeCandidateCell('page-1', [deal], data, 'ready');
      expect(cell.text).toBe('Edge unavailable');
      expect(cell.title).toBe(`Edge dataset ${availability}`);
      titles.add(cell.title);
    }
    expect(titles.size).toBe(3);
  });
});
