// @vitest-environment node
//
// tests/unit/regional-macro.test.ts
//
// Scope B — Regional Market Dynamics: state-level unemployment for ORA's 7 markets.
// Covers (1) the getRegionalMacro() provider (FRED live success → real rates,
// key-absent / FRED-throws → mock seed, NEVER throws), and (2) the contracts
// (RegionalMacroSnapshot + CapitalAllocationReport.regionalMacro) round-trip.
//
// Mirrors the fail-open discipline of getMacro.ts / market-benchmarks.ts: when FRED
// is unreachable or FRED_API_KEY is absent, return an honest mock seed labeled
// source:'mock' — accurate-as-of-today static values, never a throw, never a 0-lie.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getRegionalMacro, ORA_STATE_SERIES } from '../../server/macro/regional-macro';
import {
  StateEmploymentMetric,
  RegionalMacroSnapshot,
} from '../../src/contracts/regional-macro';
import { CapitalAllocationReport } from '../../src/contracts/capital-allocation';

const ORIGINAL_KEY = process.env.FRED_API_KEY;

// The 7 ORA-market state series, asserted independently of the module so a typo in the
// source map is a test failure, not a silent omission.
const EXPECTED_SERIES: Record<string, string> = {
  OH: 'OHUR',
  MD: 'MDUR',
  IN: 'INEUR',
  WI: 'WIUR',
  MO: 'MOUR',
  KS: 'KSUR',
  TN: 'TNUR',
};

afterEach(() => {
  vi.unstubAllGlobals();
  if (ORIGINAL_KEY === undefined) delete process.env.FRED_API_KEY;
  else process.env.FRED_API_KEY = ORIGINAL_KEY;
});

/**
 * Build a fetch mock returning one observation per matched FRED state series id.
 * Series not in the table 404 (→ provider treats as null). The latest date string
 * is echoed so asOf can be asserted.
 */
function makeFetchMock(observations: Partial<Record<string, string>>, date = '2026-05-01') {
  return vi.fn(async (url: string) => {
    const u = new URL(url);
    const series = u.searchParams.get('series_id') ?? '';
    const v = observations[series];
    if (v === undefined) return new Response('not found', { status: 404 });
    return new Response(
      JSON.stringify({ observations: [{ date, value: v }] }),
      { status: 200 },
    );
  });
}

describe('ORA_STATE_SERIES — the 7 ORA-market state unemployment series', () => {
  it('maps each ORA state to its exact FRED series id', () => {
    const got: Record<string, string> = {};
    for (const s of ORA_STATE_SERIES) got[s.stateCode] = s.seriesId;
    expect(got).toEqual(EXPECTED_SERIES);
  });

  it('covers exactly 7 states with 2-letter codes', () => {
    expect(ORA_STATE_SERIES).toHaveLength(7);
    for (const s of ORA_STATE_SERIES) {
      expect(s.stateCode).toMatch(/^[A-Z]{2}$/);
      expect(s.stateName.length).toBeGreaterThan(0);
    }
  });
});

describe('getRegionalMacro — FRED live success', () => {
  beforeEach(() => {
    process.env.FRED_API_KEY = 'test-fred-key';
  });

  it('returns real rates with source:"fred" when FRED responds for every state', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetchMock({
        OHUR: '4.1',
        MDUR: '3.0',
        INEUR: '4.0',
        WIUR: '3.2',
        MOUR: '3.9',
        KSUR: '3.6',
        TNUR: '3.4',
      }),
    );
    const snap = await getRegionalMacro();
    const parsed = RegionalMacroSnapshot.parse(snap);
    const byCode = new Map(parsed.states.map((s) => [s.stateCode, s]));
    expect(byCode.get('OH')!.unemploymentRate).toBeCloseTo(4.1, 6);
    expect(byCode.get('OH')!.source).toBe('fred');
    expect(byCode.get('MD')!.unemploymentRate).toBeCloseTo(3.0, 6);
    expect(byCode.get('TN')!.source).toBe('fred');
    expect(parsed.asOf).toBe('2026-05-01');
  });

  it('scopes a single-series outage: missing series → null rate + source:"mock" for that state only', async () => {
    // OHUR absent (404 → null). The remaining six must keep real fred values — the
    // failure must NOT cascade. Mirrors the fred.ts null-passthrough discipline.
    vi.stubGlobal(
      'fetch',
      makeFetchMock({
        MDUR: '3.0',
        INEUR: '4.0',
        WIUR: '3.2',
        MOUR: '3.9',
        KSUR: '3.6',
        TNUR: '3.4',
      }),
    );
    const snap = await getRegionalMacro();
    const byCode = new Map(snap.states.map((s) => [s.stateCode, s]));
    expect(byCode.get('OH')!.unemploymentRate).toBeNull();
    expect(byCode.get('OH')!.source).toBe('mock');
    expect(byCode.get('MD')!.unemploymentRate).toBeCloseTo(3.0, 6);
    expect(byCode.get('MD')!.source).toBe('fred');
  });
});

describe('getRegionalMacro — fail-open to mock seed', () => {
  it('returns the mock seed (source:"mock") when FRED_API_KEY is absent', async () => {
    delete process.env.FRED_API_KEY;
    const snap = await getRegionalMacro();
    expect(snap.states).toHaveLength(7);
    for (const s of snap.states) {
      expect(s.source).toBe('mock');
      // Mock seed values are defensible approximate current rates — present and sane.
      expect(s.unemploymentRate).not.toBeNull();
      expect(s.unemploymentRate!).toBeGreaterThan(0);
      expect(s.unemploymentRate!).toBeLessThan(15);
    }
  });

  it('never throws — returns the mock seed when fetch itself rejects', async () => {
    process.env.FRED_API_KEY = 'test-fred-key';
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down');
    }));
    const snap = await getRegionalMacro();
    expect(snap.states).toHaveLength(7);
    // Whole-provider fail-open: every state falls back to mock, never an exception.
    for (const s of snap.states) {
      expect(s.source).toBe('mock');
      expect(s.unemploymentRate).not.toBeNull();
    }
  });
});

describe('getRegionalMacro — all 7 ORA states always present', () => {
  it('outputs one metric per ORA state regardless of FRED availability', async () => {
    delete process.env.FRED_API_KEY;
    const snap = await getRegionalMacro();
    const codes = new Set(snap.states.map((s) => s.stateCode));
    for (const c of ['OH', 'MD', 'IN', 'WI', 'MO', 'KS', 'TN']) {
      expect(codes.has(c)).toBe(true);
    }
    expect(snap.states).toHaveLength(7);
  });
});

describe('RegionalMacroSnapshot contract', () => {
  it('validates a well-formed snapshot', () => {
    const ok = {
      asOf: '2026-05-01',
      source: 'fred' as const,
      states: [
        {
          stateCode: 'OH',
          stateName: 'Ohio',
          unemploymentRate: 4.1,
          source: 'fred' as const,
          asOf: '2026-05-01',
        },
      ],
    };
    expect(RegionalMacroSnapshot.safeParse(ok).success).toBe(true);
  });

  it('accepts null unemploymentRate and null asOf (fail-open shapes)', () => {
    const metric = {
      stateCode: 'MD',
      stateName: 'Maryland',
      unemploymentRate: null,
      source: 'mock' as const,
      asOf: null,
    };
    expect(StateEmploymentMetric.safeParse(metric).success).toBe(true);
  });

  it('rejects an unknown source', () => {
    const bad = {
      stateCode: 'OH',
      stateName: 'Ohio',
      unemploymentRate: 4.1,
      source: 'guess',
      asOf: null,
    };
    expect(StateEmploymentMetric.safeParse(bad).success).toBe(false);
  });
});

describe('CapitalAllocationReport.regionalMacro field', () => {
  const base = {
    asOf: '2026-05-01',
    propertyCount: 0,
    entries: [],
    portfolioNoi: 0,
    portfolioNoBasis: 'spine-a' as const,
    investCount: 0,
    holdCount: 0,
    monitorCount: 0,
    dispositionCount: 0,
    macro: { tenYearRate: 4.47, cpi: 3.8, source: 'mock' as const, asOf: '2026-05-01' },
    marketBenchmarks: { available: true, source: 'seed' as const, asOf: '2026-05-01' },
  };

  it('parses with a populated regionalMacro snapshot', () => {
    const report = {
      ...base,
      regionalMacro: {
        asOf: '2026-05-01',
        source: 'mock' as const,
        states: [
          { stateCode: 'OH', stateName: 'Ohio', unemploymentRate: 4.1, source: 'mock' as const, asOf: '2026-05-01' },
        ],
      },
    };
    expect(CapitalAllocationReport.safeParse(report).success).toBe(true);
  });

  it('parses with regionalMacro = null (fail-open at the report boundary)', () => {
    const report = { ...base, regionalMacro: null };
    expect(CapitalAllocationReport.safeParse(report).success).toBe(true);
  });
});
