// tests/unit/lease-market-hooks.test.ts
//
// Pure display-helper coverage for src/modules/lease-market/hooks.ts (Task 16, spec rev 3 §4).
// Query hooks themselves are exercised indirectly via the module smoke test (seeded QueryClient).
import { describe, it, expect, afterEach, vi } from 'vitest';
import { curvePointsFor, eventSummary, evidenceSummary, fmtPct, fmtUsd, postRadarDecision, radarWhy } from '../../src/modules/lease-market/hooks';
import { ORA_JSON_MUTATION_HEADERS } from '../../src/contracts/client-header';
import type { CurvePoint, ListingEventRow, RadarCandidate, SignalRow } from '../../src/contracts/lease-market';

const sig = (kind: SignalRow['kind'], evidence: SignalRow['evidence']): SignalRow => ({
  id: 1, propertyId: 1, listingId: 1, marketId: 'columbus', address: '1 Main St', kind, severity: 'watch', score: null, confidence: 'MEDIUM', compBasis: 'similarity', cellKey: null, computedAt: '2026-03-01', evidence,
});
const ev = (patch: Partial<ListingEventRow>): ListingEventRow => ({ id: 1, listingId: 1, propertyId: 1, marketId: 'columbus', address: '1 Main St', kind: 'new', eventDate: '2026-03-01', prevValue: null, newValue: null, ...patch });

describe('lease-market display helpers', () => {
  it('maps curve points for one market', () => {
    const cp = (listingId: number, marketId: string, isOra = false): CurvePoint => ({ listingId, propertyId: listingId, marketId, subtype: 'warehouse', availableSf: 10000, askingNnnEq: 9, solid: true, isOra, address: null });
    expect(curvePointsFor([cp(1, 'columbus', true), cp(2, 'madison')], 'columbus')).toEqual([{ id: '1', sf: 10000, value: 9, solid: true, highlight: true, label: 'warehouse · 10,000 SF' }]);
  });

  it('formats', () => {
    expect(fmtPct(-0.3548)).toBe('-35%');
    expect(fmtPct(0.15)).toBe('+15%');
    expect(fmtPct(0.5, false)).toBe('50%');
    expect(fmtPct(null)).toBe('—');
    expect(fmtUsd(68000)).toBe('$68,000');
    expect(fmtUsd(null)).toBe('—');
  });

  it('renders a value that rounds to 0% with no sign', () => {
    expect(fmtPct(0)).toBe('0%');
    expect(fmtPct(0.001)).toBe('0%');
    expect(fmtPct(-0.001)).toBe('0%');
  });

  it('summarizes evidence per signal kind', () => {
    expect(evidenceSummary(sig('stale', { effectiveDom: 273, staleThresholdDays: 180, domReset: true, reductionCount: 2 }))).toBe('DOM 273d (threshold 180d) · DOM reset · 2 cuts');
    expect(evidenceSummary(sig('below_market', { askingNnnEq: 6, comparableMedian: 9.4, gapPct: -0.3617, comparableN: 11, basis: 'similarity' }))).toBe('$6.00 vs comparable median $9.40 (-36%) · n 11 similarity');
    expect(evidenceSummary(sig('rent_cut', { prevAskingNnnEq: 9, askingNnnEq: 8.5, reductionCount: 2, cumulativeReductionPct: -0.11 }))).toBe('$9.00 → $8.50 · 2 cuts, -11% since first ask');
    expect(evidenceSummary(sig('new_listing', { availableSf: 20000, askingNnnEq: null }))).toBe('20,000 SF · rent withheld');
    expect(evidenceSummary(sig('withdrawn_after_stale', { removedAt: '2026-02-15', domAtRemoval: 259 }))).toBe('Removed 2026-02-15 after 259d · outcome unknown');
  });

  it('explains a radar score from its non-zero parts', () => {
    const c = {
      parts: { dom: 18, reductions: 20, belowMarket: 25, vacancy: 10, buyBoxFit: 10, owner: 5 }, maxEffectiveDom: 247, reductionCount: 2,
      cumulativeReductionPct: -0.18, bestGapPct: -0.27, vacancyShare: 0.4, ownerType: 'private',
    } as RadarCandidate;
    expect(radarWhy(c)).toBe('DOM 247d (+18) · 2 cuts -18% (+20) · -27% vs comps (+25) · vacancy 40% (+10) · buy-box (+10) · owner private (+5)');
    expect(radarWhy({ ...c, parts: { dom: 0, reductions: 0, belowMarket: 25, vacancy: 0, buyBoxFit: 10, owner: 0 } })).toBe('-27% vs comps (+25) · buy-box (+10)');
  });

  it('summarizes events', () => {
    expect(eventSummary(ev({ kind: 'price_cut', prevValue: 9.5, newValue: 9 }))).toBe('$9.50 → $9.00');
    expect(eventSummary(ev({ kind: 'sf_change', prevValue: 20000, newValue: 15000 }))).toBe('20,000 SF → 15,000 SF');
    expect(eventSummary(ev({ kind: 'dom_reset', prevValue: 92, newValue: 12 }))).toBe('CoStar DOM 92d → 12d');
    expect(eventSummary(ev({ kind: 'new', newValue: null }))).toBe('rent withheld');
    expect(eventSummary(ev({ kind: 'removed' }))).toBe('absent from two consecutive complete exports — outcome unknown');
  });

  describe('postRadarDecision', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('POSTs the decision to the right URL with ORA_JSON_MUTATION_HEADERS and the input as the JSON body', async () => {
      const fetchMock = vi.fn(async (_input: string | URL, _init?: RequestInit) => new Response(JSON.stringify({ ok: true, id: 7 }), { status: 200, headers: { 'content-type': 'application/json' } }));
      vi.stubGlobal('fetch', fetchMock);
      const result = await postRadarDecision({ propertyId: 2, decision: 'investigate', note: 'call broker' });
      expect(result).toEqual({ ok: true, id: 7 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe('/api/warehouse/lease-market/radar/decision');
      expect(init).toMatchObject({ method: 'POST', headers: ORA_JSON_MUTATION_HEADERS });
      expect(JSON.parse(init!.body as string)).toEqual({ propertyId: 2, decision: 'investigate', note: 'call broker' });
    });

    it('includes the server {error} body in the thrown message on failure', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'unknown property' }), { status: 404, headers: { 'content-type': 'application/json' } })));
      await expect(postRadarDecision({ propertyId: 99999, decision: 'pass', note: null })).rejects.toThrow('Radar decision failed (404): unknown property');
    });

    it('falls back to a bare status message when the failure body has no {error}', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 500 })));
      await expect(postRadarDecision({ propertyId: 2, decision: 'pass', note: null })).rejects.toThrow('Radar decision failed (500)');
    });
  });
});
