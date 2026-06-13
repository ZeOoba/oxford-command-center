// Root-cause cure for the contract lie at server/macro/fred.ts:49 (`value: value ?? 0`).
// The prior coalesce silently mapped a missing FRED observation to 0 — the AI agent's refi-spread
// narrative then quoted "10Y at 0.00%". Now `MacroIndicator.value` is nullable and the parser
// must pass null through end-to-end. These tests pin that behavior at the FRED adapter boundary.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fetchFredMacro } from '../../server/macro/fred';
import { MacroSnapshot } from '../../src/contracts/index';

const ORIGINAL_KEY = process.env.FRED_API_KEY;

beforeEach(() => {
  process.env.FRED_API_KEY = 'test-fred-key';
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (ORIGINAL_KEY === undefined) delete process.env.FRED_API_KEY;
  else process.env.FRED_API_KEY = ORIGINAL_KEY;
});

/** Build a fetch mock that returns one mock observation per matched seriesId. Anything not
 *  in the table 404s. The trend (frequency=m) returns the supplied history points. */
function makeFetchMock(opts: {
  observations: Partial<Record<'DGS10' | 'DGS2' | 'SOFR' | 'FEDFUNDS' | 'CPIAUCSL', string>>;
  trend: Array<{ date: string; value: string }>;
}) {
  return vi.fn(async (url: string) => {
    const u = new URL(url);
    const series = u.searchParams.get('series_id') ?? '';
    const isTrend = u.searchParams.get('frequency') === 'm';
    if (isTrend) {
      return new Response(JSON.stringify({ observations: opts.trend }), { status: 200 });
    }
    const v = opts.observations[series as keyof typeof opts.observations];
    if (v === undefined) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify({ observations: [{ value: v }] }), { status: 200 });
  });
}

describe('fetchFredMacro — null observation must flow through as null (not 0)', () => {
  it('emits indicators.DGS10.value === null when FRED returns "." (missing) for that series alone', async () => {
    // Defect-of-record (PFI Phase 1b adversarial review): a partial outage on DGS10 alone
    // produced indicators.DGS10.value = 0 with source='fred' (no caveat). The cure here is
    // value: value (no ?? 0). MacroIndicator.value is now z.number().nullable() so the
    // parse below MUST succeed AND the field must be exactly null, not 0.
    vi.stubGlobal('fetch', makeFetchMock({
      observations: {
        // DGS10 absent — fred.ts obs() returns null
        DGS2: '4.05',
        SOFR: '3.63',
        FEDFUNDS: '3.63',
        CPIAUCSL: '3.80',
      },
      trend: [{ date: '2026-05-01', value: '4.48' }],
    }));
    const snap = await fetchFredMacro();
    expect(snap).not.toBeNull();
    // Contract round-trip — proves the live shape is parseable post-widening.
    const parsed = MacroSnapshot.parse(snap);
    const dgs10 = parsed.indicators.find((i) => i.id === 'DGS10');
    expect(dgs10).toBeDefined();
    expect(dgs10!.value).toBeNull();
    // Other indicators must still carry their real values — the failure must be SCOPED.
    expect(parsed.indicators.find((i) => i.id === 'DGS2')!.value).toBe(4.05);
    expect(parsed.indicators.find((i) => i.id === 'SOFR')!.value).toBe(3.63);
    expect(parsed.indicators.find((i) => i.id === 'CPIAUCSL')!.value).toBeCloseTo(3.8, 6);
  });

  it('preserves a real numeric observation untouched (no regression on the common live case)', async () => {
    vi.stubGlobal('fetch', makeFetchMock({
      observations: { DGS10: '4.47', DGS2: '4.05', SOFR: '3.63', FEDFUNDS: '3.63', CPIAUCSL: '3.80' },
      trend: [{ date: '2025-06-01', value: '4.38' }, { date: '2026-05-01', value: '4.48' }],
    }));
    const snap = await fetchFredMacro();
    const parsed = MacroSnapshot.parse(snap);
    expect(parsed.indicators.find((i) => i.id === 'DGS10')!.value).toBeCloseTo(4.47, 6);
    expect(parsed.tenYearHistory).toHaveLength(2);
    expect(parsed.tenYearHistory[1]!.value).toBeCloseTo(4.48, 6);
  });

  it('drops "." (missing) trend points but keeps the rest — null does NOT pollute the history series', async () => {
    // tenYearHistory parsing already filters non-finite — proven here. We don't widen
    // MacroSeriesPoint.value because the producer filters at the boundary; the symptom of
    // the contract lie was only ever on the current-rate indicator, not the trend.
    vi.stubGlobal('fetch', makeFetchMock({
      observations: { DGS10: '4.47', DGS2: '4.05', SOFR: '3.63', FEDFUNDS: '3.63', CPIAUCSL: '3.80' },
      trend: [
        { date: '2026-04-01', value: '4.32' },
        { date: '2026-05-01', value: '.' }, // missing — must be filtered
        { date: '2026-06-01', value: '4.51' },
      ],
    }));
    const snap = await fetchFredMacro();
    expect(snap!.tenYearHistory.map((p) => p.date)).toEqual(['2026-04-01', '2026-06-01']);
    expect(snap!.tenYearHistory.every((p) => Number.isFinite(p.value))).toBe(true);
  });
});
