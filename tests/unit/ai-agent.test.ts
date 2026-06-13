import { describe, it, expect, vi } from 'vitest';
import type { PortfolioSnapshot } from '../../src/contracts/index';
import { TOOL_DEFS, runTool } from '../../server/ai/tools';
import { runAgent, summarizeMacro, type AgentEvent } from '../../server/ai/agent';
import type { MacroSnapshot } from '../../src/contracts/index';

function makeSnap(): PortfolioSnapshot {
  const snap = {
    meta: { schemaVersion: '1.0.0', asOf: '2026-06-01', generatedAt: '2026-06-01T00:00:00.000Z', source: 't', scenario: 'Base' },
    assumptions: { activeScenario: 'Base', revenueFactor: 1, vacancyFactor: 1, exitCapFactor: 1, thresholds: { balloonAlertMonths: 18, concentrationYellow: 0.25, concentrationRed: 0.5 }, asOf: '2026-06-01' },
    properties: [
      { id: 'p1', index: 1, name: '29000 Information Lane, Easton MD', address: '29000 Information Lane', city: null, state: null, market: 'Mid-Atlantic', type: 'Flex', sf: 48000, tenantCount: 1, occPct: 1, acqDate: null, estValue100: 0, oxfordOwnPct: 1, oxfordValue: 7310000, grossIncome: 0, expenses: 0, noi: 511000, noiScenarioAdj: 511000, debtService: 0, netCashFlow: 0, capRate: 0.07, dscr: 2.45, lender: 'Symetra', loanBalance: 2770000, ltv: 0.38, valuePerSf: null, rentPerSf: null, equityInvested: 1000000, cashOnCash: null, holdYrs: null, encumbered: true, flags: [] },
    ],
    leases: [
      { id: 'lease1', propertyKey: '29000', propertyId: 'p1', tenantName: 'Eurosort', unit: 'A', company: 'Eurosort, INC.', sf: 1000, monthlyRent: 8333.33, rentPerSf: null, leaseStart: null, leaseEnd: '2028-01-01', escalationDate: null, escalationPct: null, status: 'Active', annualRent: 100000, monthsToExpiry: 18, flags: [] },
    ],
    loans: [
      { id: 'l1', name: 'Restoration Church Trust', counterparty: 'Oxford Capital', direction: 'lender', originalPrincipal: null, currentBalance: -980773, absBalance: 980773, rate: 0.09, monthlyPmt: -6268, annualInterest: null, annualPrincipal: null, loanType: 'Balloon', status: 'Balloon', isDemand: false, maturity: '2027-02-20', monthsToMaturity: 8, ltv: 0.785, lender: null, balloon: true, flags: [] },
    ],
    cash: { asOf: '2026-06-01', totalCash: 7829033, activeEntities: 1, largestEntity: 'FVC', concentrationTopPct: 0.545, cagr: null, entities: [{ entity: 'FVC', id: 'fvc', currentBalance: 4000000, priorBalance: null, deltaDollar: null, deltaPct: null, avg3: null, minAllTime: null, maxAllTime: null, bal12moAgo: null, growth12Dollar: null, growth12Pct: null, pctOfPortfolio: 0.51, trend: 'up', flags: [] }], history: [] },
    insurance: [],
    deals: [],
    tasks: [],
    counterparties: [],
    renewalStages: {},
    tenantNotes: {},
    dealComps: {},
    noiBudgets: {},
    quickbooks: null,
    dataQuality: [],
  };
  return snap as unknown as PortfolioSnapshot;
}

describe('tool definitions + executors', () => {
  it('every tool def has a name and an object input_schema', () => {
    for (const t of TOOL_DEFS) {
      expect(typeof t.name).toBe('string');
      expect(t.input_schema.type).toBe('object');
    }
  });

  it('get_loans(balloon_only) filters to balloons and carries a citation ref', () => {
    const r = runTool('get_loans', makeSnap(), { balloon_only: true });
    expect(r.refs).toEqual([{ type: 'loan', id: 'l1', label: 'Restoration Church Trust' }]);
  });

  it('get_property matches by market and refs the property', () => {
    const r = runTool('get_property', makeSnap(), { query: 'easton' });
    expect(r.refs[0]).toEqual({ type: 'property', id: 'p1', label: '29000 Information Lane, Easton MD' });
  });

  it('search_documents falls back honestly when no index is on this surface', () => {
    const r = runTool('search_documents', makeSnap(), { query: 'eurosort renewal' });
    expect(JSON.stringify(r.data)).toMatch(/no documents are indexed/i);
  });

  it('get_macro is in TOOL_DEFS with an object input schema', () => {
    const t = TOOL_DEFS.find((d) => d.name === 'get_macro');
    expect(t).toBeDefined();
    expect(t?.input_schema.type).toBe('object');
  });

  it('get_macro falls back honestly when no live provider is on this surface (no FRED on the mirror, etc.)', () => {
    const r = runTool('get_macro', makeSnap(), {});
    expect(JSON.stringify(r.data)).toMatch(/not available on this surface|no live macro/i);
  });

  it('an unknown tool returns an error, not a throw', () => {
    const r = runTool('nope', makeSnap(), {});
    expect(JSON.stringify(r.data)).toMatch(/unknown tool/i);
  });
});

// Build an Anthropic-style SSE body from a list of {type,...} data objects.
function sse(...frames: object[]): string {
  return frames.map((f) => `event: x\ndata: ${JSON.stringify(f)}\n\n`).join('');
}

describe('summarizeMacro (get_macro agent payload — Phase-2 refi narrative input)', () => {
  // Production-shape snapshot — 5 indicators, 12-point history (matches getMacro.ts seeded()).
  const seeded = (source: 'mock' | 'fred' = 'fred'): MacroSnapshot => ({
    asOf: '2026-06-01',
    source,
    indicators: [
      { id: 'DGS10', label: '10Y Treasury', value: 4.47, unit: '%', change: -0.01 },
      { id: 'DGS2', label: '2Y Treasury', value: 4.05, unit: '%', change: null },
      { id: 'SOFR', label: 'SOFR', value: 3.63, unit: '%', change: null },
      { id: 'FEDFUNDS', label: 'Fed Funds (effective)', value: 3.63, unit: '%', change: null },
      { id: 'CPIAUCSL', label: 'CPI (YoY)', value: 3.8, unit: '%', change: null },
    ],
    tenYearHistory: [
      { date: '2025-06-01', value: 4.38 }, { date: '2025-07-01', value: 4.39 }, { date: '2025-08-01', value: 4.26 },
      { date: '2025-09-01', value: 4.12 }, { date: '2025-10-01', value: 4.06 }, { date: '2025-11-01', value: 4.09 },
      { date: '2025-12-01', value: 4.14 }, { date: '2026-01-01', value: 4.21 }, { date: '2026-02-01', value: 4.13 },
      { date: '2026-03-01', value: 4.25 }, { date: '2026-04-01', value: 4.32 }, { date: '2026-05-01', value: 4.48 },
    ],
  });

  it('removes the orphan tenYearTrend.current — the canonical current 10Y comes from indicators.DGS10 only (one dated current, never two)', () => {
    // Adversarial finding (correctness/medium): the prior shape emitted trend.current (= 4.48 from
    // May-2026 history) alongside indicators.DGS10.value (= 4.47 sampled at asOf 2026-06-01). The
    // model received TWO 'current 10Y' figures, no rule to choose, and refi spread math went
    // path-dependent (37 vs 38 bps over a 4.10% book rate). Fix: drop trend.current entirely.
    const p = summarizeMacro(seeded()) as { tenYearTrend: Record<string, unknown> };
    expect(p.tenYearTrend).not.toHaveProperty('current');
  });

  it('attaches an explicit windowMonths + endDate to the 10Y trend (window is data-driven, never an unlabelled magic constant)', () => {
    const p = summarizeMacro(seeded()) as { tenYearTrend: { windowMonths: number; endDate: string; low: number; high: number; n: number } };
    expect(p.tenYearTrend.windowMonths).toBe(12);
    expect(p.tenYearTrend.endDate).toBe('2026-05-01');
    expect(p.tenYearTrend.n).toBe(12);
    expect(p.tenYearTrend.low).toBeCloseTo(4.06, 6);
    expect(p.tenYearTrend.high).toBeCloseTo(4.48, 6);
  });

  it('slices to the last 12 by date when the provider returns 13 (live FRED at a month-boundary publication) — no off-by-one window mislabel', () => {
    // Adversarial finding (correctness/low): server/macro/fred.ts requests limit=13. Once the
    // 13th month publishes, naive Math.min/max over all returned values describes 13 months but
    // the field name says 12. Fix: slice to last 12 by date.
    const m = seeded();
    // Prepend a 13th, earlier point. The window must EXCLUDE this and report exactly the last 12.
    m.tenYearHistory = [{ date: '2025-05-01', value: 9.99 }, ...m.tenYearHistory];
    const p = summarizeMacro(m) as { tenYearTrend: { n: number; low: number; high: number; endDate: string } };
    expect(p.tenYearTrend.n).toBe(12);
    expect(p.tenYearTrend.endDate).toBe('2026-05-01');
    expect(p.tenYearTrend.high).toBeLessThan(9); // the 9.99 outlier must NOT pollute the window
    expect(p.tenYearTrend.low).toBeCloseTo(4.06, 6);
    expect(p.tenYearTrend.high).toBeCloseTo(4.48, 6);
  });

  it('picks the trend window by DATE (not array position) — an out-of-order history cannot mislabel the window endDate', () => {
    // Latent footgun (correctness): values[length-1] assumed ascending input. The MacroSeriesPoint
    // contract doesn't enforce ordering; a non-FRED provider could ship out-of-order points and
    // silently corrupt endDate / current. Fix: sort by date before slicing.
    const m = seeded();
    m.tenYearHistory = [...m.tenYearHistory].reverse();
    const p = summarizeMacro(m) as { tenYearTrend: { endDate: string; n: number } };
    expect(p.tenYearTrend.endDate).toBe('2026-05-01');
    expect(p.tenYearTrend.n).toBe(12);
  });

  it('adds a dataFreshness SEEDED caveat when source=mock so the model cannot misread the seeded snapshot as live (Phase-2 refi misread guard)', () => {
    // Adversarial finding (dispatch/medium): without FRED_API_KEY, getMacro returns the hand-seeded
    // snapshot. The model saw source:'mock' but no instruction forced disclosure — refi answers
    // would quote a frozen May-2026 reading as 'current'. Fix: emit dataFreshness with explicit
    // instruction text the model can echo to the user.
    const mock = summarizeMacro(seeded('mock')) as { dataFreshness?: string };
    expect(mock.dataFreshness).toBeDefined();
    expect(mock.dataFreshness).toMatch(/SEEDED/);
    expect(mock.dataFreshness).toMatch(/live.*offline|feed is offline/i);
    const live = summarizeMacro(seeded('fred')) as { dataFreshness?: string };
    expect(live.dataFreshness).toBeUndefined(); // live FRED carries no caveat
  });

  it('still preserves the full 5-indicator production shape (regression cover)', () => {
    const p = summarizeMacro(seeded()) as { indicators: Record<string, { value: number }> };
    expect(Object.keys(p.indicators).sort()).toEqual(['CPIAUCSL', 'DGS10', 'DGS2', 'FEDFUNDS', 'SOFR']);
    expect(p.indicators.DGS10!.value).toBe(4.47);
  });

  it('guards the canonical 10Y when fred.ts coalesces a missing observation to 0 — flags dataQuality + fallback from the trend endpoint (rate-feed safety)', () => {
    // Adversarial finding (fix-pass medium): fred.ts:49 `value ?? 0` silently coerces a missing
    // FRED observation to 0. With trend.current removed, the model was left to confidently quote
    // 'indicators.DGS10.value' = 0% as the canonical current 10Y. Defense-in-depth: when DGS10 is
    // missing or non-positive (a 10Y rate cannot be ≤ 0), attach a dataQuality flag and a dated
    // `currentTenYFallback` from the most recent finite trend point — the model has a labeled
    // alternative and a clear instruction to caveat. Root cause (fred.ts + contract) tracked separately.
    const m = seeded('fred');
    m.indicators = m.indicators.map((i) => (i.id === 'DGS10' ? { ...i, value: 0 } : i)); // upstream coalesce
    const p = summarizeMacro(m) as { dataQuality?: string; currentTenYFallback?: { value: number; date: string } };
    expect(p.dataQuality).toBeDefined();
    expect(p.dataQuality).toMatch(/DGS10/);
    expect(p.dataQuality).toMatch(/degraded|missing|fallback/i);
    expect(p.currentTenYFallback).toBeDefined();
    expect(p.currentTenYFallback!.value).toBeCloseTo(4.48, 6); // most recent finite point in the window
    expect(p.currentTenYFallback!.date).toBe('2026-05-01');
  });

  it('does NOT flag dataQuality when DGS10 reports a real positive rate (the common live case)', () => {
    const p = summarizeMacro(seeded('fred')) as { dataQuality?: string; currentTenYFallback?: unknown };
    expect(p.dataQuality).toBeUndefined();
    expect(p.currentTenYFallback).toBeUndefined();
  });

  it('is null-safe on an empty history (no Infinity leak)', () => {
    const m = seeded();
    m.tenYearHistory = [];
    const p = summarizeMacro(m) as { tenYearTrend: { n: number; low: number | null; high: number | null; endDate: string | null } };
    expect(p.tenYearTrend.n).toBe(0);
    expect(p.tenYearTrend.low).toBeNull();
    expect(p.tenYearTrend.high).toBeNull();
    expect(p.tenYearTrend.endDate).toBeNull();
  });
});

describe('runAgent — streaming tool loop', () => {
  it('with no key, falls back to the deterministic responder and emits text + done', async () => {
    const events: AgentEvent[] = [];
    await runAgent({ question: 'summary', snapshot: makeSnap(), emit: (e) => void events.push(e) });
    expect(events.some((e) => e.type === 'text')).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'done', model: 'stub' });
  });

  it('runs a tool turn, feeds results back, then streams a cited answer', async () => {
    const bodies: string[] = [];
    const turn1 = sse(
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_alerts' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      { type: 'message_stop' },
    );
    const turn2 = sse(
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '1 balloon: ' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '[[loan:l1|Restoration Church Trust]]' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    );
    const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
      bodies.push(init.body);
      return new Response(bodies.length === 1 ? turn1 : turn2, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const events: AgentEvent[] = [];
    await runAgent({ question: 'any balloons?', snapshot: makeSnap(), apiKey: 'test-key', emit: (e) => void events.push(e) });
    vi.unstubAllGlobals();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Regression: the request MUST set stream:true, else the API returns one JSON body and the
    // SSE parser emits nothing (empty answer with a live key).
    expect(bodies[0]).toContain('"stream":true');
    expect(events.some((e) => e.type === 'tool' && e.name === 'get_alerts')).toBe(true);
    const text = events.filter((e): e is Extract<AgentEvent, { type: 'text' }> => e.type === 'text').map((e) => e.delta).join('');
    expect(text).toContain('[[loan:l1|Restoration Church Trust]]');
    // The second request must echo the tool_result back to the model.
    expect(bodies[1]).toContain('tool_result');
    expect(bodies[1]).toContain('toolu_1');
    expect(events.at(-1)).toMatchObject({ type: 'done' });
  });

  it('routes get_macro through the injected macroProvider (not the stub) and feeds the live snapshot back to the model', async () => {
    const bodies: string[] = [];
    const turn1 = sse(
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_m', name: 'get_macro' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      { type: 'message_stop' },
    );
    const turn2 = sse(
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '10Y at 4.47%.' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    );
    const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
      bodies.push(init.body);
      return new Response(bodies.length === 1 ? turn1 : turn2, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = vi.fn(async () => ({
      asOf: '2026-06-01',
      source: 'fred' as const,
      indicators: [
        { id: 'DGS10', label: '10Y Treasury', value: 4.47, unit: '%', change: -0.01 },
        { id: 'SOFR', label: 'SOFR', value: 3.63, unit: '%', change: null },
      ],
      tenYearHistory: [{ date: '2025-06-01', value: 4.38 }, { date: '2026-05-01', value: 4.48 }],
    }));

    await runAgent({
      question: 'what is the 10Y?',
      snapshot: makeSnap(),
      apiKey: 'test-key',
      // macroProvider follows the search_documents injection pattern (opts.docSearch).
      macroProvider: provider,
      emit: () => undefined,
    });
    vi.unstubAllGlobals();

    expect(provider).toHaveBeenCalledTimes(1);
    // Second request echoes the tool_result — it MUST carry the LIVE snapshot (DGS10/SOFR), NEVER
    // the stub fallback string. This is the financial-decision wiring under test (Phase-2 refi
    // narrative reads the rate spread from this tool result).
    expect(bodies[1]).toContain('DGS10');
    expect(bodies[1]).toContain('4.47');
    expect(bodies[1]).toContain('SOFR');
    // The literal stub message in the tool_result content would mean the executor stub fired
    // instead of the injected provider. (The same phrase appears in the tool DESCRIPTION sent to
    // the model — match the stub's exact body shape, not the substring.)
    expect(bodies[1]).not.toContain('Live macro is not available on this surface');
  });
});
