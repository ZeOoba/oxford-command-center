### Task 16: "Lease Market" module — KPI row, five tabs, radar decisions, history drawer

**Files:**
- Create: `src/modules/lease-market/hooks.ts`
- Create: `src/modules/lease-market/LeaseMarketModule.tsx`
- Modify: `src/shell/modules.tsx` (lazy import + one `MODULES` entry)
- Test: `tests/unit/lease-market-hooks.test.ts`, `tests/unit/lease-market-module-smoke.test.tsx`

**Interfaces:**
- Consumes: Task 02 response schemas/types; Task 14 routes; Task 15 `RentCurve`, `CurveDatum`; `fetchParsedOrMirror`, `QUERY_OPTS`, `isWarehouseUnavailable` (`src/modules/intel/hooks.ts`); `ORA_JSON_MUTATION_HEADERS` (`@contracts/client-header`); `Card`, `CardHeader`, `Badge` (+ `BadgeTone`), `DataTable` (+ `Column`), `BarChart`. **Before writing JSX, open `src/primitives/Badge.tsx`, `Card.tsx`, `DataTable.tsx` and `src/modules/leasing/LeaseForecastModule.tsx` and match their exact prop names and spacing classes.**
- Produces (hooks.ts): `LEASE_MARKET_KEYS { summary, positioning, radar, signals, changes, history(id) }`; `useLeaseMarketSummary`, `useLeaseMarketPositioning`, `useLeaseMarketRadar`, `useLeaseMarketSignals`, `useLeaseMarketChanges`, `useLeaseMarketHistory(listingId: number | null)` (disabled when null); `postRadarDecision(input)`, `useRadarDecision()` (invalidates radar on success); helpers `curvePointsFor(curve, marketId): CurveDatum[]`, `KIND_LABELS`, `EVENT_LABELS`, `DECISION_LABELS`, `bandTone`, `bandLabel`, `severityTone`, `confidenceTone`, `fmtPsf`, `fmtPct(v, signed = true)`, `fmtSf`, `fmtUsd`, `evidenceSummary(signal)`, `radarWhy(candidate)`, `eventSummary(event)`.
- Produces (component): `LeaseMarketModule` registered as `{ id: 'lease-market', label: 'Lease Market', icon: Building2, group: 'Market' }` after `market`.

**UI rules (spec rev 3 §4):** KPI row (6 stats). Tabs `Portfolio` (default) · `Market Rents` · `Acquisition Radar` · `Changes` · `Data Quality`. Portfolio: Rent Position table (property, unit, SF, ORA asking, comparable median, range P25–P75, percentile, gap, band badge, confidence badge + basis + n, DOM, flags, recommendation); clicking a row shows its comps table (address, SF, asking, score, distance) where clicking a comp opens the history drawer; "Listed in CoStar but not vacant in the rent roll" list; unmapped-properties note. Market Rents: market toggles (enabled markets), `RentCurve`, DOM `BarChart`, benchmark table. Acquisition Radar: withheld-market warnings; ranked candidates (score badge, space, market, building SF, why = `radarWhy`, indicative gap `fmtUsd`, confidence, owner, broker, latest decision, buttons Investigate / Monitor / Pass); caption `Indicative rent gap = gross, vacant space only — not NOI.`; "Withdrawn after a stale run (outcome unknown)" table. Changes: events table (event label, market, space, detail, date; row click opens history) and non-radar signals table (severity, signal, space, evidence). Data Quality: freshness table and data-quality table. Every loading state reads `Loading…`; a mirror without the route reads `Not available on this mirror.`

- [ ] **Step 1: Write the failing helper test**

```ts
// tests/unit/lease-market-hooks.test.ts
import { describe, it, expect } from 'vitest';
import { curvePointsFor, eventSummary, evidenceSummary, fmtPct, fmtUsd, radarWhy } from '../../src/modules/lease-market/hooks';
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
});
```

- [ ] **Step 2:** `npx vitest run tests/unit/lease-market-hooks.test.ts` — Expected: FAIL.

- [ ] **Step 3: Write hooks.ts**

```ts
// src/modules/lease-market/hooks.ts
//
// Lease Market Intelligence — TanStack Query hooks + pure display helpers (spec rev 3 §4).
// Reads degrade on the static mirror via fetchParsedOrMirror. Helpers are exported for unit tests.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchParsedOrMirror, QUERY_OPTS } from '../intel/hooks';
import { ORA_JSON_MUTATION_HEADERS } from '@contracts/client-header';
import {
  ChangesResponse, HistoryResponse, LeaseMarketSummaryResponse, PositioningResponse, RadarDecisionResponse, RadarResponse, SignalsResponse,
  type ConfidenceLabel, type CurvePoint, type EvidenceValue, type ListingEventKind, type ListingEventRow, type PositioningBand,
  type RadarCandidate, type RadarDecisionInput, type RadarDecisionKind, type SignalKind, type SignalRow, type SignalSeverity,
} from '@contracts/lease-market';
import type { CurveDatum } from '@/charts/rent-curve-layout';
import type { BadgeTone } from '@/primitives/Badge';

const BASE = '/api/warehouse/lease-market';

export const LEASE_MARKET_KEYS = {
  summary: ['warehouse', 'lease-market', 'summary'] as const,
  positioning: ['warehouse', 'lease-market', 'positioning'] as const,
  radar: ['warehouse', 'lease-market', 'radar'] as const,
  signals: ['warehouse', 'lease-market', 'signals'] as const,
  changes: ['warehouse', 'lease-market', 'changes'] as const,
  history: (id: number) => ['warehouse', 'lease-market', 'history', id] as const,
};

export function useLeaseMarketSummary() {
  return useQuery({ queryKey: LEASE_MARKET_KEYS.summary, queryFn: () => fetchParsedOrMirror(`${BASE}/summary`, LeaseMarketSummaryResponse), ...QUERY_OPTS });
}
export function useLeaseMarketPositioning() {
  return useQuery({ queryKey: LEASE_MARKET_KEYS.positioning, queryFn: () => fetchParsedOrMirror(`${BASE}/positioning`, PositioningResponse), ...QUERY_OPTS });
}
export function useLeaseMarketRadar() {
  return useQuery({ queryKey: LEASE_MARKET_KEYS.radar, queryFn: () => fetchParsedOrMirror(`${BASE}/radar`, RadarResponse), ...QUERY_OPTS });
}
export function useLeaseMarketSignals() {
  return useQuery({ queryKey: LEASE_MARKET_KEYS.signals, queryFn: () => fetchParsedOrMirror(`${BASE}/signals`, SignalsResponse), ...QUERY_OPTS });
}
export function useLeaseMarketChanges() {
  return useQuery({ queryKey: LEASE_MARKET_KEYS.changes, queryFn: () => fetchParsedOrMirror(`${BASE}/changes`, ChangesResponse), ...QUERY_OPTS });
}
export function useLeaseMarketHistory(listingId: number | null) {
  return useQuery({
    queryKey: LEASE_MARKET_KEYS.history(listingId ?? -1),
    queryFn: () => fetchParsedOrMirror(`${BASE}/history/${listingId}`, HistoryResponse),
    enabled: listingId !== null,
    ...QUERY_OPTS,
  });
}

export async function postRadarDecision(input: RadarDecisionInput) {
  const res = await fetch(`${BASE}/radar/decision`, { method: 'POST', headers: ORA_JSON_MUTATION_HEADERS, body: JSON.stringify(input) });
  if (!res.ok) throw new Error(`Radar decision failed (${res.status})`);
  return RadarDecisionResponse.parse(await res.json());
}

export function useRadarDecision() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: postRadarDecision,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: LEASE_MARKET_KEYS.radar });
    },
  });
}

// ── Pure helpers ───────────────────────────────────────────────────────────────
export function fmtPsf(v: number | null | undefined): string {
  return v === null || v === undefined ? '—' : `$${v.toFixed(2)}`;
}
export function fmtPct(v: number | null | undefined, signed = true): string {
  if (v === null || v === undefined) return '—';
  const pct = (v * 100).toFixed(0);
  return signed && v > 0 ? `+${pct}%` : `${pct}%`;
}
export function fmtSf(v: number | null | undefined): string {
  return v === null || v === undefined ? '—' : `${Math.round(v).toLocaleString('en-US')} SF`;
}
export function fmtUsd(v: number | null | undefined): string {
  return v === null || v === undefined ? '—' : `$${Math.round(v).toLocaleString('en-US')}`;
}

export function curvePointsFor(curve: readonly CurvePoint[], marketId: string): CurveDatum[] {
  return curve
    .filter((p) => p.marketId === marketId)
    .map((p) => ({ id: String(p.listingId), sf: p.availableSf, value: p.askingNnnEq, solid: p.solid, highlight: p.isOra, label: p.address ?? `${p.subtype} · ${fmtSf(p.availableSf)}` }));
}

export const KIND_LABELS: Record<SignalKind, string> = {
  radar_candidate: 'Radar candidate',
  below_market: 'Below market',
  stale: 'Stale',
  rent_cut: 'Rent cut',
  withdrawn_after_stale: 'Withdrawn after stale',
  new_listing: 'New listing',
};

export const EVENT_LABELS: Record<ListingEventKind, string> = {
  new: 'New', returned: 'Returned', price_cut: 'Price cut', price_increase: 'Price increase', sf_change: 'SF change',
  dom_reset: 'DOM reset', missing: 'Missing once', removed: 'Removed',
};

export const DECISION_LABELS: Record<RadarDecisionKind, string> = {
  investigate: 'Investigate', monitor: 'Monitor', pass: 'Pass', pursued: 'Pursued', loi: 'LOI', closed: 'Closed',
};

export function bandTone(band: PositioningBand): BadgeTone {
  return band === 'above' ? 'amber' : band === 'below' ? 'blue' : band === 'in_band' ? 'green' : 'neutral';
}
export function bandLabel(band: PositioningBand): string {
  return band === 'above' ? 'Above market' : band === 'below' ? 'Below market' : band === 'in_band' ? 'In range' : 'No ORA asking';
}
export function severityTone(s: SignalSeverity): BadgeTone {
  return s === 'high' ? 'red' : s === 'watch' ? 'amber' : 'neutral';
}
export function confidenceTone(c: ConfidenceLabel | null): BadgeTone {
  return c === 'HIGH' ? 'green' : c === 'MEDIUM' ? 'blue' : 'neutral';
}

const num = (v: EvidenceValue | undefined): number | null => (typeof v === 'number' ? v : null);
const cuts = (n: number | null) => `${n ?? 0} cut${n === 1 ? '' : 's'}`;

export function evidenceSummary(s: SignalRow): string {
  const e = s.evidence;
  switch (s.kind) {
    case 'new_listing':
      return `${fmtSf(num(e.availableSf))} · ${num(e.askingNnnEq) === null ? 'rent withheld' : fmtPsf(num(e.askingNnnEq))}`;
    case 'stale':
      return `DOM ${num(e.effectiveDom) ?? '—'}d (threshold ${num(e.staleThresholdDays) ?? '—'}d)${e.domReset === true ? ' · DOM reset' : ''}${(num(e.reductionCount) ?? 0) > 0 ? ` · ${cuts(num(e.reductionCount))}` : ''}`;
    case 'rent_cut':
      return `${fmtPsf(num(e.prevAskingNnnEq))} → ${fmtPsf(num(e.askingNnnEq))} · ${cuts(num(e.reductionCount))}, ${fmtPct(num(e.cumulativeReductionPct))} since first ask`;
    case 'below_market':
      return `${fmtPsf(num(e.askingNnnEq))} vs comparable median ${fmtPsf(num(e.comparableMedian))} (${fmtPct(num(e.gapPct))}) · n ${num(e.comparableN) ?? '—'} ${typeof e.basis === 'string' ? e.basis : ''}`.trim();
    case 'withdrawn_after_stale':
      return `Removed ${typeof e.removedAt === 'string' ? e.removedAt : '—'} after ${num(e.domAtRemoval) ?? '—'}d · outcome unknown`;
    case 'radar_candidate':
      return `Score ${s.score ?? '—'}`;
  }
}

export function radarWhy(c: RadarCandidate): string {
  const p = c.parts;
  const bits: string[] = [];
  if (p.dom > 0) bits.push(`DOM ${c.maxEffectiveDom}d (+${p.dom})`);
  if (p.reductions > 0) bits.push(`${cuts(c.reductionCount)} ${fmtPct(c.cumulativeReductionPct)} (+${p.reductions})`);
  if (p.belowMarket > 0) bits.push(`${fmtPct(c.bestGapPct)} vs comps (+${p.belowMarket})`);
  if (p.vacancy > 0) bits.push(`vacancy ${fmtPct(c.vacancyShare, false)} (+${p.vacancy})`);
  if (p.buyBoxFit > 0) bits.push(`buy-box (+${p.buyBoxFit})`);
  if (p.owner > 0) bits.push(`owner ${c.ownerType} (+${p.owner})`);
  return bits.join(' · ');
}

export function eventSummary(e: ListingEventRow): string {
  switch (e.kind) {
    case 'price_cut':
    case 'price_increase':
      return `${fmtPsf(e.prevValue)} → ${fmtPsf(e.newValue)}`;
    case 'sf_change':
      return `${fmtSf(e.prevValue)} → ${fmtSf(e.newValue)}`;
    case 'dom_reset':
      return `CoStar DOM ${e.prevValue ?? '—'}d → ${e.newValue ?? '—'}d`;
    case 'new':
    case 'returned':
      return e.newValue === null ? 'rent withheld' : fmtPsf(e.newValue);
    case 'missing':
      return 'absent from latest complete export';
    case 'removed':
      return 'absent from two consecutive complete exports — outcome unknown';
  }
}
```

Run: `npx vitest run tests/unit/lease-market-hooks.test.ts` — Expected: PASS.

- [ ] **Step 4: Write the failing smoke test**

```tsx
// tests/unit/lease-market-module-smoke.test.tsx
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LeaseMarketModule } from '../../src/modules/lease-market/LeaseMarketModule';
import { LEASE_MARKET_KEYS } from '../../src/modules/lease-market/hooks';
import type { ChangesResponse, LeaseMarketSummaryResponse, PositioningResponse, RadarResponse, SignalsResponse } from '../../src/contracts/lease-market';

afterEach(cleanup);

const SUMMARY: LeaseMarketSummaryResponse = {
  asOf: '2026-03-01', rowLevel: true,
  kpis: { marketsFresh: 1, marketsEnabled: 1, activeSpaces: 13, newInLatest: 13, priceCutsInLatest: 2, stale: 3, radarCandidates: 1 },
  freshness: [{ marketId: 'columbus', label: 'Columbus', enabled: true, lastLandingDate: '2026-02-15', lastCompleteDate: '2026-02-15', lastCompleteness: 'complete', partialReason: null, stale: false }],
  dataQuality: [{ marketId: 'columbus', activeSpaces: 13, lastExportRows: 13, lastExportSkipped: 0, quotedShare: 0.8, coordsShare: 1, lowConfidenceShare: 0.1, rejectedRents: 0 }],
  benchmarks: [],
  curve: [6, 7, 8, 9, 10].map((v, i) => ({ listingId: i + 1, propertyId: i + 1, marketId: 'columbus', subtype: 'warehouse' as const, availableSf: 20000, askingNnnEq: v, solid: true, isOra: false, address: `${i} Main St` })),
  domByMarket: [{ marketId: 'columbus', bins: [{ label: '0-90d', count: 5 }, { label: '90-180d', count: 0 }, { label: '180-365d', count: 0 }, { label: '365d+', count: 0 }] }],
};
const POSITIONING: PositioningResponse = {
  asOf: '2026-03-01', unconfiguredPropertyKeys: ['Sepich'], listedButLeased: [],
  rows: [{
    propertyKey: '1100 Rarig', unit: 'B', sf: 8000, oraListingId: 13, oraAskingNnnEq: 12,
    stats: { basis: 'similarity', n: 12, low: 5.5, p25: 8.75, median: 9.3, p75: 10, high: 10.4, confidence: 'MEDIUM', cellKey: null },
    comps: [], percentile: 1, gapPct: 0.29, band: 'above', recommendation: 'Asking is 29% above the comparable median ($9.30); comparable range $8.75–$10.00.',
    flags: [], effectiveDom: 45, brokerName: null, listingUrl: null, dateListed: '2026-01-15',
  }],
};
const RADAR: RadarResponse = {
  asOf: '2026-03-01', candidatesWithheld: [], monitor: [],
  candidates: [{
    propertyId: 2, marketId: 'columbus', address: '101 Industrial Pkwy', subtype: 'warehouse', buildingSf: 40000, score: 55,
    parts: { dom: 0, reductions: 0, belowMarket: 25, vacancy: 15, buyBoxFit: 10, owner: 5 }, confidence: 'MEDIUM', vacancyShare: 0.5,
    maxEffectiveDom: 45, reductionCount: 0, cumulativeReductionPct: 0, bestGapPct: -0.36, comparableMedian: 9.4, indicativeRentGapUsd: 68000,
    ownerName: 'SMITH FAMILY LLC', ownerType: 'private', ownerListingCount: 11, brokerName: 'Pat Broker', latestDecision: null,
  }],
};
const SIGNALS: SignalsResponse = { asOf: '2026-03-01', candidatesWithheld: [], signals: [] };
const CHANGES: ChangesResponse = { asOf: '2026-03-01', events: [{ id: 1, listingId: 2, propertyId: 2, marketId: 'columbus', address: '101 Industrial Pkwy', kind: 'price_cut', eventDate: '2026-02-15', prevValue: 6.5, newValue: 6 }] };

function renderWith(summary = SUMMARY, positioning = POSITIONING, radar = RADAR, signals = SIGNALS, changes = CHANGES) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(LEASE_MARKET_KEYS.summary, summary);
  qc.setQueryData(LEASE_MARKET_KEYS.positioning, positioning);
  qc.setQueryData(LEASE_MARKET_KEYS.radar, radar);
  qc.setQueryData(LEASE_MARKET_KEYS.signals, signals);
  qc.setQueryData(LEASE_MARKET_KEYS.changes, changes);
  return render(<QueryClientProvider client={qc}><LeaseMarketModule /></QueryClientProvider>);
}

describe('LeaseMarketModule', () => {
  it('renders KPIs and the Portfolio tab by default', () => {
    renderWith();
    expect(screen.getByText('Radar candidates')).toBeTruthy();
    expect(screen.getByText('1100 Rarig')).toBeTruthy();
    expect(screen.getByText('Above market')).toBeTruthy();
    expect(screen.getByText(/29% above the comparable median/)).toBeTruthy();
    expect(screen.getByText(/Not yet mapped to a comparable set: Sepich/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/NaN/);
  });

  it('switches to the radar, changes and data-quality tabs', () => {
    renderWith();
    fireEvent.click(screen.getByRole('tab', { name: 'Acquisition Radar' }));
    expect(screen.getByText('101 Industrial Pkwy')).toBeTruthy();
    expect(screen.getByText('$68,000')).toBeTruthy();
    expect(screen.getByText(/not NOI/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Investigate' })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Changes' }));
    expect(screen.getByText('$6.50 → $6.00')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Data Quality' }));
    expect(screen.getAllByText(/Columbus|columbus/).length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/NaN/);
  });

  it('renders explicit empty states', () => {
    renderWith(
      { ...SUMMARY, curve: [], domByMarket: [] },
      { ...POSITIONING, rows: [], unconfiguredPropertyKeys: [] },
      { ...RADAR, candidates: [] },
      SIGNALS,
      { ...CHANGES, events: [] },
    );
    expect(screen.getByText('No vacant ORA units mapped to a comparable set.')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Market Rents' }));
    expect(screen.getByText('No quoted asking rents yet.')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Acquisition Radar' }));
    expect(screen.getByText('No radar candidates.')).toBeTruthy();
  });
});
```

Run: `npx vitest run tests/unit/lease-market-module-smoke.test.tsx` — Expected: FAIL.

- [ ] **Step 5: Write the module**

```tsx
// src/modules/lease-market/LeaseMarketModule.tsx
//
// Lease Market Intelligence UI (spec rev 3 §4): KPI row + Portfolio · Market Rents · Acquisition Radar ·
// Changes · Data Quality. All rents are ASKING rents on an NNN-equivalent basis. Degrades on the static mirror.
import { useMemo, useState, type ReactNode } from 'react';
import { Card, CardHeader } from '@/primitives/Card';
import { Badge } from '@/primitives/Badge';
import { DataTable, type Column } from '@/primitives/DataTable';
import { BarChart } from '@/charts/BarChart';
import { RentCurve } from '@/charts/RentCurve';
import { isWarehouseUnavailable } from '../intel/hooks';
import type {
  CellBenchmark, CompRow, ListedButLeased, ListingEventRow, MarketDataQuality, MarketFreshness, PositioningRow, RadarCandidate, SignalRow,
} from '@contracts/lease-market';
import {
  DECISION_LABELS, EVENT_LABELS, KIND_LABELS, bandLabel, bandTone, confidenceTone, curvePointsFor, eventSummary, evidenceSummary, fmtPct,
  fmtPsf, fmtSf, fmtUsd, radarWhy, severityTone, useLeaseMarketChanges, useLeaseMarketHistory, useLeaseMarketPositioning,
  useLeaseMarketRadar, useLeaseMarketSignals, useLeaseMarketSummary, useRadarDecision,
} from './hooks';

const MUTED = { color: 'var(--text-tertiary)' } as const;
const TABS = ['Portfolio', 'Market Rents', 'Acquisition Radar', 'Changes', 'Data Quality'] as const;
type Tab = (typeof TABS)[number];

function Toggle({ active, onClick, children, role }: { active: boolean; onClick: () => void; children: ReactNode; role?: 'tab' }) {
  return (
    <button
      type="button"
      role={role}
      aria-selected={role === 'tab' ? active : undefined}
      aria-pressed={role === 'tab' ? undefined : active}
      onClick={onClick}
      className="rounded-[var(--radius-sm)] px-2 py-1 text-2xs"
      style={{ border: `1px solid ${active ? 'var(--accent)' : 'var(--border-subtle)'}`, color: 'var(--text-secondary)' }}
    >
      {children}
    </button>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className="text-2xs" style={MUTED}>{children}</p>;
}

function unavailable(error: unknown): string {
  return isWarehouseUnavailable(error) ? 'Not available on this mirror.' : `Failed to load: ${error instanceof Error ? error.message : 'unknown error'}`;
}

// ── Portfolio ─────────────────────────────────────────────────────────────────
const positionCols: Column<PositioningRow>[] = [
  { key: 'property', header: 'Property', render: (r) => <span style={{ fontWeight: 600 }}>{r.propertyKey}</span>, sortValue: (r) => r.propertyKey },
  { key: 'unit', header: 'Unit', render: (r) => r.unit ?? '—' },
  { key: 'sf', header: 'SF', align: 'right', render: (r) => r.sf.toLocaleString('en-US'), sortValue: (r) => r.sf },
  { key: 'asking', header: 'ORA asking', align: 'right', render: (r) => fmtPsf(r.oraAskingNnnEq), sortValue: (r) => r.oraAskingNnnEq },
  { key: 'median', header: 'Comp median', align: 'right', render: (r) => fmtPsf(r.stats?.median), sortValue: (r) => r.stats?.median ?? null },
  { key: 'range', header: 'Range', render: (r) => (r.stats ? `${fmtPsf(r.stats.p25)}–${fmtPsf(r.stats.p75)}` : '—') },
  { key: 'pctl', header: 'Pctl', align: 'right', render: (r) => (r.percentile === null ? '—' : `${Math.round(r.percentile * 100)}th`), sortValue: (r) => r.percentile },
  { key: 'gap', header: 'Gap', align: 'right', render: (r) => fmtPct(r.gapPct), sortValue: (r) => r.gapPct },
  { key: 'band', header: 'Position', render: (r) => <Badge tone={bandTone(r.band)}>{bandLabel(r.band)}</Badge>, sortValue: (r) => r.band },
  { key: 'conf', header: 'Confidence', render: (r) => (r.stats ? <Badge tone={confidenceTone(r.stats.confidence)}>{`${r.stats.confidence} · ${r.stats.basis} · n ${r.stats.n}`}</Badge> : '—') },
  { key: 'dom', header: 'DOM', align: 'right', render: (r) => (r.effectiveDom === null ? '—' : `${r.effectiveDom}d`), sortValue: (r) => r.effectiveDom },
  { key: 'flags', header: 'Flags', render: (r) => (r.flags.includes('not_listed') ? <Badge tone="red">Not listed</Badge> : '') },
  { key: 'rec', header: 'Recommendation', render: (r) => <span className="text-2xs">{r.recommendation}</span> },
];

const compCols: Column<CompRow>[] = [
  { key: 'address', header: 'Comparable', render: (c) => c.address ?? `Space ${c.listingId}` },
  { key: 'sf', header: 'SF', align: 'right', render: (c) => fmtSf(c.availableSf), sortValue: (c) => c.availableSf },
  { key: 'asking', header: 'Asking', align: 'right', render: (c) => fmtPsf(c.askingNnnEq), sortValue: (c) => c.askingNnnEq },
  { key: 'score', header: 'Similarity', align: 'right', render: (c) => String(c.score), sortValue: (c) => c.score },
  { key: 'dist', header: 'Miles', align: 'right', render: (c) => (c.distanceMi === null ? '—' : c.distanceMi.toFixed(1)), sortValue: (c) => c.distanceMi },
];

const leasedCols: Column<ListedButLeased>[] = [
  { key: 'property', header: 'Property', render: (l) => l.propertyKey },
  { key: 'suite', header: 'Suite', render: (l) => l.suite || '—' },
  { key: 'asking', header: 'Asking', align: 'right', render: (l) => fmtPsf(l.askingNnnEq) },
  { key: 'dom', header: 'DOM', align: 'right', render: (l) => `${l.effectiveDom}d` },
];

function PortfolioTab({ onHistory }: { onHistory: (id: number) => void }) {
  const q = useLeaseMarketPositioning();
  const [selected, setSelected] = useState<string | null>(null);
  if (q.isLoading) return <Note>Loading…</Note>;
  if (!q.data) return <Note>{q.error ? unavailable(q.error) : 'Positioning unavailable (needs the live rent roll).'}</Note>;
  const rowId = (r: PositioningRow) => `${r.propertyKey}|${r.unit ?? ''}`;
  const active = q.data.rows.find((r) => rowId(r) === selected) ?? null;
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader title="Oxford Rent Position — vacant units vs. comparable asking rents" />
        <div className="p-4">
          {q.data.rows.length === 0 ? (
            <Note>No vacant ORA units mapped to a comparable set.</Note>
          ) : (
            <DataTable columns={positionCols} rows={q.data.rows} getRowId={rowId} onRowClick={(r) => setSelected(rowId(r))} initialSort={{ key: 'gap', dir: 'desc' }} minWidth={1200} />
          )}
          {q.data.unconfiguredPropertyKeys.length > 0 && <Note>Not yet mapped to a comparable set: {q.data.unconfiguredPropertyKeys.join(', ')}</Note>}
        </div>
      </Card>
      {active && (
        <Card>
          <CardHeader title={`Comparables — ${active.propertyKey} ${active.unit ?? ''}`} trailing={<span className="text-2xs" style={MUTED}>click a comparable for its history</span>} />
          <div className="p-4">
            {active.comps.length === 0 ? <Note>Using the market cell (no similarity comparable set).</Note> : <DataTable columns={compCols} rows={active.comps} getRowId={(c) => String(c.listingId)} onRowClick={(c) => onHistory(c.listingId)} />}
          </div>
        </Card>
      )}
      {q.data.listedButLeased.length > 0 && (
        <Card>
          <CardHeader title="Listed in CoStar but not vacant in the rent roll" />
          <div className="p-4">
            <DataTable columns={leasedCols} rows={q.data.listedButLeased} getRowId={(l) => String(l.listingId)} onRowClick={(l) => onHistory(l.listingId)} />
          </div>
        </Card>
      )}
    </div>
  );
}

// ── Market Rents ──────────────────────────────────────────────────────────────
const benchCols: Column<CellBenchmark>[] = [
  { key: 'cell', header: 'Cell', render: (b) => <span className="text-2xs">{b.cellKey}</span>, sortValue: (b) => b.cellKey },
  { key: 'n', header: 'Quoted / total', align: 'right', render: (b) => `${b.n} / ${b.totalN}`, sortValue: (b) => b.n },
  { key: 'p25', header: 'P25', align: 'right', render: (b) => fmtPsf(b.p25) },
  { key: 'median', header: 'Median', align: 'right', render: (b) => fmtPsf(b.median), sortValue: (b) => b.median },
  { key: 'p75', header: 'P75', align: 'right', render: (b) => fmtPsf(b.p75) },
  { key: 'flags', header: 'Notes', render: (b) => [b.lowCoverage ? 'low coverage' : '', b.rolledUp !== 'none' ? `rolled up: ${b.rolledUp}` : ''].filter(Boolean).join(' · ') },
];

// ── Radar ─────────────────────────────────────────────────────────────────────
function RadarTab({ onHistory }: { onHistory: (id: number) => void }) {
  const q = useLeaseMarketRadar();
  const decide = useRadarDecision();
  if (q.isLoading) return <Note>Loading…</Note>;
  if (!q.data) return <Note>{unavailable(q.error)}</Note>;
  const cols: Column<RadarCandidate>[] = [
    { key: 'score', header: 'Score', align: 'right', render: (c) => <Badge tone={c.score >= 70 ? 'red' : 'amber'}>{String(c.score)}</Badge>, sortValue: (c) => c.score },
    { key: 'address', header: 'Property', render: (c) => <span style={{ fontWeight: 600 }}>{c.address ?? `Property ${c.propertyId}`}</span> },
    { key: 'market', header: 'Market', render: (c) => c.marketId },
    { key: 'sf', header: 'Bldg SF', align: 'right', render: (c) => fmtSf(c.buildingSf), sortValue: (c) => c.buildingSf },
    { key: 'why', header: 'Why it surfaced', render: (c) => <span className="text-2xs">{radarWhy(c)}</span> },
    { key: 'gap', header: 'Indicative rent gap', align: 'right', render: (c) => fmtUsd(c.indicativeRentGapUsd), sortValue: (c) => c.indicativeRentGapUsd },
    { key: 'conf', header: 'Confidence', render: (c) => <Badge tone={confidenceTone(c.confidence)}>{c.confidence}</Badge> },
    { key: 'owner', header: 'Owner', render: (c) => `${c.ownerName ?? '—'} (${c.ownerType}, ${c.ownerListingCount} listed)` },
    { key: 'broker', header: 'Broker', render: (c) => c.brokerName ?? '—' },
    { key: 'decision', header: 'Decision', render: (c) => (c.latestDecision ? `${DECISION_LABELS[c.latestDecision.decision]} · ${c.latestDecision.decidedAt.slice(0, 10)}` : '—') },
    {
      key: 'actions',
      header: '',
      render: (c) => (
        <div className="flex gap-1">
          {(['investigate', 'monitor', 'pass'] as const).map((d) => (
            <button
              key={d}
              type="button"
              className="rounded-[var(--radius-sm)] px-2 py-0.5 text-2xs"
              style={{ border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
              disabled={decide.isPending}
              onClick={(e) => {
                e.stopPropagation();
                decide.mutate({ propertyId: c.propertyId, decision: d, note: null });
              }}
            >
              {DECISION_LABELS[d]}
            </button>
          ))}
        </div>
      ),
    },
  ];
  const monitorCols: Column<SignalRow>[] = [
    { key: 'space', header: 'Space', render: (s) => s.address ?? `Space ${s.listingId ?? ''}` },
    { key: 'market', header: 'Market', render: (s) => s.marketId },
    { key: 'evidence', header: 'Evidence', render: (s) => evidenceSummary(s) },
  ];
  return (
    <div className="flex flex-col gap-4">
      {q.data.candidatesWithheld.map((w) => (
        <p key={w.marketId} className="text-2xs" style={{ color: 'var(--color-warn)' }}>{w.marketId}: {w.reason}</p>
      ))}
      <Card>
        <CardHeader title="Acquisition Radar — ranked candidates" trailing={<span className="text-2xs" style={MUTED}>Indicative rent gap = gross, vacant space only — not NOI.</span>} />
        <div className="p-4">
          {q.data.candidates.length === 0 ? <Note>No radar candidates.</Note> : <DataTable columns={cols} rows={q.data.candidates} getRowId={(c) => String(c.propertyId)} minWidth={1300} />}
          {decide.isError && <p className="mt-2 text-2xs" style={{ color: 'var(--color-warn)' }}>{decide.error instanceof Error ? decide.error.message : 'Decision failed'}</p>}
        </div>
      </Card>
      <Card>
        <CardHeader title="Withdrawn after a stale run (outcome unknown)" />
        <div className="p-4">
          {q.data.monitor.length === 0 ? <Note>None in the lookback window.</Note> : <DataTable columns={monitorCols} rows={q.data.monitor} getRowId={(s) => String(s.id)} onRowClick={(s) => s.listingId !== null && onHistory(s.listingId)} />}
        </div>
      </Card>
    </div>
  );
}

// ── Changes ───────────────────────────────────────────────────────────────────
function ChangesTab({ onHistory }: { onHistory: (id: number) => void }) {
  const changes = useLeaseMarketChanges();
  const signals = useLeaseMarketSignals();
  const eventCols: Column<ListingEventRow>[] = [
    { key: 'kind', header: 'Event', render: (e) => EVENT_LABELS[e.kind], sortValue: (e) => e.kind },
    { key: 'market', header: 'Market', render: (e) => e.marketId },
    { key: 'space', header: 'Space', render: (e) => e.address ?? `Space ${e.listingId}` },
    { key: 'detail', header: 'Detail', render: (e) => eventSummary(e) },
    { key: 'date', header: 'Export', render: (e) => e.eventDate, sortValue: (e) => e.eventDate },
  ];
  const signalCols: Column<SignalRow>[] = [
    { key: 'severity', header: 'Severity', render: (s) => <Badge tone={severityTone(s.severity)}>{s.severity}</Badge> },
    { key: 'kind', header: 'Signal', render: (s) => KIND_LABELS[s.kind], sortValue: (s) => s.kind },
    { key: 'space', header: 'Space', render: (s) => s.address ?? `Space ${s.listingId ?? ''}` },
    { key: 'evidence', header: 'Evidence', render: (s) => evidenceSummary(s) },
  ];
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader title="Changes in the latest complete exports" />
        <div className="p-4">
          {changes.isLoading ? <Note>Loading…</Note> : !changes.data ? <Note>{unavailable(changes.error)}</Note> : changes.data.events.length === 0 ? <Note>No changes.</Note> : (
            <DataTable columns={eventCols} rows={changes.data.events} getRowId={(e) => String(e.id)} onRowClick={(e) => onHistory(e.listingId)} />
          )}
        </div>
      </Card>
      <Card>
        <CardHeader title="Signals" />
        <div className="p-4">
          {signals.isLoading ? <Note>Loading…</Note> : !signals.data ? <Note>{unavailable(signals.error)}</Note> : signals.data.signals.length === 0 ? <Note>No signals.</Note> : (
            <DataTable columns={signalCols} rows={signals.data.signals} getRowId={(s) => String(s.id)} onRowClick={(s) => s.listingId !== null && onHistory(s.listingId)} />
          )}
        </div>
      </Card>
    </div>
  );
}

// ── Data quality ──────────────────────────────────────────────────────────────
const freshnessCols: Column<MarketFreshness>[] = [
  { key: 'market', header: 'Market', render: (f) => f.label },
  { key: 'enabled', header: 'Enabled', render: (f) => (f.enabled ? 'yes' : 'no') },
  { key: 'last', header: 'Last complete export', render: (f) => f.lastCompleteDate ?? 'none' },
  { key: 'state', header: 'Status', render: (f) => <Badge tone={f.stale ? 'amber' : 'green'}>{f.stale ? 'stale' : 'fresh'}</Badge> },
  { key: 'reason', header: 'Partial reason', render: (f) => f.partialReason ?? '' },
];
const qualityCols: Column<MarketDataQuality>[] = [
  { key: 'market', header: 'Market', render: (q) => q.marketId },
  { key: 'active', header: 'Active spaces', align: 'right', render: (q) => String(q.activeSpaces) },
  { key: 'rows', header: 'Last export rows / skipped', align: 'right', render: (q) => `${q.lastExportRows} / ${q.lastExportSkipped}` },
  { key: 'quoted', header: 'Quoted NNN', align: 'right', render: (q) => fmtPct(q.quotedShare, false) },
  { key: 'coords', header: 'Coordinates', align: 'right', render: (q) => fmtPct(q.coordsShare, false) },
  { key: 'low', header: 'Low confidence', align: 'right', render: (q) => fmtPct(q.lowConfidenceShare, false) },
  { key: 'rejected', header: 'Rejected rents', align: 'right', render: (q) => String(q.rejectedRents) },
];

// ── History drawer ────────────────────────────────────────────────────────────
function HistoryDrawer({ listingId, onClose }: { listingId: number; onClose: () => void }) {
  const q = useLeaseMarketHistory(listingId);
  return (
    <Card>
      <CardHeader
        title={`Space history — ${q.data?.address ?? `space ${listingId}`}`}
        trailing={<button type="button" className="text-2xs" style={MUTED} onClick={onClose}>Close</button>}
      />
      <div className="p-4">
        {q.isLoading ? <Note>Loading…</Note> : !q.data ? <Note>{unavailable(q.error)}</Note> : (
          <ul className="text-2xs" style={{ color: 'var(--text-secondary)' }}>
            {q.data.observations.map((o) => (
              <li key={o.observedAt}>{o.observedAt} · {fmtSf(o.availableSf)} · {fmtPsf(o.askingNnnEq)} {o.rentBasis} ({o.confidence}){o.costarDom !== null ? ` · CoStar DOM ${o.costarDom}d` : ''}</li>
            ))}
            {q.data.events.map((e) => (
              <li key={`e${e.id}`}>{e.eventDate} · {EVENT_LABELS[e.kind]} · {eventSummary(e)}</li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

// ── Module ────────────────────────────────────────────────────────────────────
export function LeaseMarketModule() {
  const summary = useLeaseMarketSummary();
  const [tab, setTab] = useState<Tab>('Portfolio');
  const [selectedMarket, setSelectedMarket] = useState<string | null>(null);
  const [historyId, setHistoryId] = useState<number | null>(null);

  const data = summary.data;
  const marketId =
    selectedMarket ?? data?.freshness.find((f) => f.enabled && f.lastCompleteDate !== null)?.marketId ?? data?.freshness.find((f) => f.enabled)?.marketId ?? null;
  const points = useMemo(() => (data && marketId ? curvePointsFor(data.curve, marketId) : []), [data, marketId]);

  if (summary.isLoading) return <div className="p-6"><Note>Loading lease market…</Note></div>;
  if (!data) return <Card><div className="p-6"><Note>{unavailable(summary.error)}</Note></div></Card>;

  const k = data.kpis;
  const kpis: Array<[string, string]> = [
    ['Markets fresh', `${k.marketsFresh} / ${k.marketsEnabled}`],
    ['Active spaces', String(k.activeSpaces)],
    ['New in latest exports', String(k.newInLatest)],
    ['Price cuts', String(k.priceCutsInLatest)],
    ['Stale listings', String(k.stale)],
    ['Radar candidates', String(k.radarCandidates)],
  ];
  const dom = data.domByMarket.find((d) => d.marketId === marketId);
  const marketLabel = data.freshness.find((f) => f.marketId === marketId)?.label ?? '—';

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-6">
        {kpis.map(([label, value]) => (
          <Card key={label}>
            <div className="p-3">
              <div className="text-2xs" style={MUTED}>{label}</div>
              <div className="num text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>{value}</div>
            </div>
          </Card>
        ))}
      </div>
      <p className="text-2xs" style={MUTED}>As of {data.asOf} · asking rents, NNN-equivalent $/SF/yr · CoStar-derived, internal use only</p>

      <div role="tablist" className="flex flex-wrap gap-1">
        {TABS.map((t) => (
          <Toggle key={t} role="tab" active={tab === t} onClick={() => setTab(t)}>{t}</Toggle>
        ))}
      </div>

      {tab === 'Portfolio' && <PortfolioTab onHistory={setHistoryId} />}

      {tab === 'Market Rents' && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-1">
            {data.freshness.filter((f) => f.enabled).map((f) => (
              <Toggle key={f.marketId} active={f.marketId === marketId} onClick={() => setSelectedMarket(f.marketId)}>{f.label}</Toggle>
            ))}
          </div>
          <Card>
            <CardHeader title={`Asking rent vs. available SF — ${marketLabel}`} trailing={<span className="text-2xs" style={MUTED}>● quoted NNN · ○ converted · gold = ORA · band P25–P75 per size band (n ≥ 5)</span>} />
            <div className="p-4"><RentCurve points={points} /></div>
          </Card>
          <Card>
            <CardHeader title={`Days on market — ${marketLabel}`} />
            <div className="p-4">{dom ? <BarChart data={dom.bins.map((b) => ({ label: b.label, value: b.count }))} /> : <Note>No listings yet.</Note>}</div>
          </Card>
          <Card>
            <CardHeader title="Benchmark cells" />
            <div className="p-4">
              {data.benchmarks.length === 0 ? <Note>No benchmark cells yet.</Note> : <DataTable columns={benchCols} rows={data.benchmarks.filter((b) => b.marketId === marketId)} getRowId={(b) => b.cellKey} />}
            </div>
          </Card>
        </div>
      )}

      {tab === 'Acquisition Radar' && <RadarTab onHistory={setHistoryId} />}
      {tab === 'Changes' && <ChangesTab onHistory={setHistoryId} />}

      {tab === 'Data Quality' && (
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader title="Export freshness" />
            <div className="p-4"><DataTable columns={freshnessCols} rows={data.freshness} getRowId={(f) => f.marketId} /></div>
          </Card>
          <Card>
            <CardHeader title="Data quality" />
            <div className="p-4"><DataTable columns={qualityCols} rows={data.dataQuality} getRowId={(q) => q.marketId} /></div>
          </Card>
        </div>
      )}

      {historyId !== null && <HistoryDrawer listingId={historyId} onClose={() => setHistoryId(null)} />}
    </div>
  );
}
```

- [ ] **Step 6: Register** — in `src/shell/modules.tsx` add `const LeaseMarketModule = lazy(() => import('@/modules/lease-market/LeaseMarketModule').then((m) => ({ default: m.LeaseMarketModule })));` with the other lazy imports, and `{ id: 'lease-market', label: 'Lease Market', icon: Building2, group: 'Market', Component: LeaseMarketModule },` directly after the `market` entry (`Building2` is already imported).

- [ ] **Step 7:** `npx vitest run tests/unit/lease-market-hooks.test.ts tests/unit/lease-market-module-smoke.test.tsx tests/unit/module-order.test.ts && npm run typecheck && npm run lint && npm run check:dev-css` — Expected: PASS / clean. If a `Badge` requires a string child, the template literals above already provide one; if `DataTable` has no `minWidth` prop in this checkout, drop that prop.

- [ ] **Step 8: Commit** — `git add src/modules/lease-market/hooks.ts src/modules/lease-market/LeaseMarketModule.tsx src/shell/modules.tsx tests/unit/lease-market-hooks.test.ts tests/unit/lease-market-module-smoke.test.tsx` ("feat(ui): Lease Market module — KPIs, rent position, rent curve, radar, changes, data quality").
