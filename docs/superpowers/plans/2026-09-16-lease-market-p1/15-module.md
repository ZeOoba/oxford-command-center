### Task 15: "Lease Market" dashboard module

**Files:**
- Create: `src/modules/lease-market/hooks.ts`
- Create: `src/modules/lease-market/LeaseMarketModule.tsx`
- Modify: `src/shell/modules.tsx` (lazy import + one `MODULES` entry)
- Test: `tests/unit/lease-market-hooks.test.ts`, `tests/unit/lease-market-module-smoke.test.tsx`

**Interfaces:**
- Consumes: Task 02 response types + `SIZE_BANDS`; Task 04 `quantileSorted`; Task 13 routes; Task 14 `StripPlot`, `StripGroup`; existing `fetchParsedOrMirror`, `QUERY_OPTS`, `isWarehouseUnavailable` (`src/modules/intel/hooks.ts`), `Card`/`CardHeader`, `Badge` + `BadgeTone`, `DataTable` + `Column`, `BarChart`.
- Produces:
  - `LEASE_MARKET_KEYS = { summary, positioning, signals }` query keys
  - `useLeaseMarketSummary()`, `useLeaseMarketPositioning()`, `useLeaseMarketSignals()`
  - pure helpers: `buildStripGroups(distribution, marketId): StripGroup[]`, `KIND_LABELS: Record<SignalKind, string>`, `bandTone`, `bandLabel`, `severityTone`, `fmtPsf`, `fmtPct`, `fmtSf`, `evidenceSummary(signal): string`
  - `LeaseMarketModule` component, registered as `{ id: 'lease-market', label: 'Lease Market', group: 'Market' }`

Before writing JSX, open `src/primitives/Badge.tsx`, `src/primitives/Card.tsx` and `src/modules/leasing/LeaseForecastModule.tsx` and match their prop names and spacing classes exactly; the code below assumes `Badge` takes `tone` + children and `CardHeader` takes `title` + `trailing`.

- [ ] **Step 1: Write the failing helper test**

```ts
// tests/unit/lease-market-hooks.test.ts
import { describe, it, expect } from 'vitest';
import { bandTone, buildStripGroups, evidenceSummary, fmtPct } from '../../src/modules/lease-market/hooks';
import type { DistributionPoint, SignalRow } from '../../src/contracts/lease-market';

const pt = (listingId: number, askingNnnEq: number, patch: Partial<DistributionPoint> = {}): DistributionPoint => ({
  listingId, marketId: 'columbus', subtype: 'warehouse', sizeBand: '15-30K', askingNnnEq, solid: true, isOra: false, address: `${listingId} Main St`, ...patch,
});
const sig = (kind: SignalRow['kind'], evidence: SignalRow['evidence']): SignalRow => ({
  id: 1, listingId: 1, marketId: 'columbus', address: '1 Main St', kind, severity: 'watch', cellKey: null, computedAt: '2026-03-01', evidence,
});

describe('buildStripGroups', () => {
  it('groups one market by subtype and band, orders bands, and computes quoted-only quartiles at n >= 5', () => {
    const groups = buildStripGroups(
      [
        ...[6, 7, 8, 9, 10, 11].map((v, i) => pt(i + 1, v)),
        pt(20, 5, { solid: false }),
        pt(30, 12, { sizeBand: '5-15K', isOra: true }),
        pt(40, 7, { marketId: 'madison' }),
      ],
      'columbus',
    );
    expect(groups.map((g) => g.label)).toEqual(['Warehouse 5-15K', 'Warehouse 15-30K']);
    const main = groups[1]!;
    expect(main.points).toHaveLength(7);
    expect(main.median).toBe(8.5);
    expect(main.points.find((p) => p.id === '20')?.solid).toBe(false);
    expect(groups[0]!.median).toBeNull();
    expect(groups[0]!.points[0]!.highlight).toBe(true);
  });
});

describe('formatting', () => {
  it('formats signed percentages and band tones', () => {
    expect(fmtPct(-0.3548)).toBe('-35%');
    expect(fmtPct(0.15)).toBe('+15%');
    expect(fmtPct(null)).toBe('—');
    expect(bandTone('above')).toBe('amber');
    expect(bandTone('in_band')).toBe('green');
  });

  it('summarizes evidence per signal kind', () => {
    expect(evidenceSummary(sig('stale', { effectiveDom: 273, staleThresholdDays: 180, domReset: true }))).toBe('DOM 273d (threshold 180d) · DOM reset');
    expect(evidenceSummary(sig('below_market', { askingNnnEq: 6, cellMedian: 9.3, gapPct: -0.3548, cellN: 12 }))).toBe('$6.00 vs median $9.30 (-35%) · n 12');
    expect(evidenceSummary(sig('rent_cut', { prevAskingNnnEq: 9, askingNnnEq: 8.5 }))).toBe('$9.00 → $8.50');
    expect(evidenceSummary(sig('new_listing', { availableSf: 20000, askingNnnEq: null }))).toBe('20,000 SF · rent withheld');
    expect(
      evidenceSummary(sig('acq_candidate', {
        stale: false, rentCut: false, highVacancy: true, vacancyShare: 0.5, belowMarket: true,
        ownerName: 'SMITH FAMILY LLC', ownerListingCount: 11, ownerVerify: false, ownerAffiliated: false,
      })),
    ).toBe('vacancy 50% · below market · owner SMITH FAMILY LLC (11 listings)');
    expect(evidenceSummary(sig('acq_candidate', { stale: true, rentCut: true, ownerListingCount: 1, ownerVerify: true }))).toBe(
      'stale · rent cut · owner redacted (1 listings) · VERIFY owner',
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/lease-market-hooks.test.ts`
Expected: FAIL — cannot resolve `hooks`.

- [ ] **Step 3: Write hooks.ts**

```ts
// src/modules/lease-market/hooks.ts
//
// Lease Market Intelligence — TanStack Query hooks + pure display helpers.
// Consumes GET /api/warehouse/lease-market/{summary,positioning,signals}. Degrades on the static mirror via
// fetchParsedOrMirror (WarehouseUnavailableError). Helpers are exported for unit tests without React.
import { useQuery } from '@tanstack/react-query';
import { fetchParsedOrMirror, QUERY_OPTS } from '../intel/hooks';
import {
  LeaseMarketSummaryResponse, PositioningResponse, SignalsResponse, SIZE_BANDS,
  type DistributionPoint, type EvidenceValue, type PositioningBand, type SignalKind, type SignalRow, type SignalSeverity, type SizeBand,
} from '@contracts/lease-market';
import { quantileSorted } from '@analytics/lease-market/benchmarks';
import type { StripGroup } from '@/charts/StripPlot';
import type { BadgeTone } from '@/primitives/Badge';

export const LEASE_MARKET_KEYS = {
  summary: ['warehouse', 'lease-market', 'summary'] as const,
  positioning: ['warehouse', 'lease-market', 'positioning'] as const,
  signals: ['warehouse', 'lease-market', 'signals'] as const,
};

export function useLeaseMarketSummary() {
  return useQuery({
    queryKey: LEASE_MARKET_KEYS.summary,
    queryFn: () => fetchParsedOrMirror('/api/warehouse/lease-market/summary', LeaseMarketSummaryResponse),
    ...QUERY_OPTS,
  });
}

export function useLeaseMarketPositioning() {
  return useQuery({
    queryKey: LEASE_MARKET_KEYS.positioning,
    queryFn: () => fetchParsedOrMirror('/api/warehouse/lease-market/positioning', PositioningResponse),
    ...QUERY_OPTS,
  });
}

export function useLeaseMarketSignals() {
  return useQuery({
    queryKey: LEASE_MARKET_KEYS.signals,
    queryFn: () => fetchParsedOrMirror('/api/warehouse/lease-market/signals', SignalsResponse),
    ...QUERY_OPTS,
  });
}

// ── Pure helpers ───────────────────────────────────────────────────────────────
const MIN_BAND_N = 5; // same floor as the benchmark minimum; display-only quartiles over quoted NNN points

export function buildStripGroups(distribution: readonly DistributionPoint[], marketId: string): StripGroup[] {
  const byKey = new Map<string, DistributionPoint[]>();
  for (const d of distribution) {
    if (d.marketId !== marketId) continue;
    const key = `${d.subtype}|${d.sizeBand}`;
    const list = byKey.get(key) ?? [];
    list.push(d);
    byKey.set(key, list);
  }
  const rank = (key: string): number => {
    const [subtype, band] = key.split('|');
    return (subtype === 'flex' ? 100 : 0) + SIZE_BANDS.indexOf(band as SizeBand);
  };
  return [...byKey.entries()]
    .sort(([a], [b]) => rank(a) - rank(b))
    .map(([key, points]) => {
      const [subtype, band] = key.split('|');
      const quoted = points.filter((p) => p.solid).map((p) => p.askingNnnEq).sort((x, y) => x - y);
      const enough = quoted.length >= MIN_BAND_N;
      return {
        key,
        label: `${subtype === 'flex' ? 'Flex' : 'Warehouse'} ${band}`,
        p25: enough ? quantileSorted(quoted, 0.25) : null,
        median: enough ? quantileSorted(quoted, 0.5) : null,
        p75: enough ? quantileSorted(quoted, 0.75) : null,
        points: points.map((p) => ({ id: String(p.listingId), value: p.askingNnnEq, solid: p.solid, highlight: p.isOra, label: p.address ?? `${band} ${subtype}` })),
      };
    });
}

export const KIND_LABELS: Record<SignalKind, string> = {
  acq_candidate: 'Acquisition candidate',
  below_market: 'Below market',
  stale: 'Stale',
  rent_cut: 'Rent cut',
  new_listing: 'New listing',
};

export function bandTone(band: PositioningBand): BadgeTone {
  return band === 'above' ? 'amber' : band === 'below' ? 'blue' : band === 'in_band' ? 'green' : 'neutral';
}

export function bandLabel(band: PositioningBand): string {
  return band === 'above' ? 'Above market' : band === 'below' ? 'Below market' : band === 'in_band' ? 'In band' : 'No ORA asking';
}

export function severityTone(severity: SignalSeverity): BadgeTone {
  return severity === 'high' ? 'red' : severity === 'watch' ? 'amber' : 'neutral';
}

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

const num = (v: EvidenceValue | undefined): number | null => (typeof v === 'number' ? v : null);

export function evidenceSummary(s: SignalRow): string {
  const e = s.evidence;
  switch (s.kind) {
    case 'new_listing':
      return `${fmtSf(num(e.availableSf))} · ${num(e.askingNnnEq) === null ? 'rent withheld' : fmtPsf(num(e.askingNnnEq))}`;
    case 'stale':
      return `DOM ${num(e.effectiveDom) ?? '—'}d (threshold ${num(e.staleThresholdDays) ?? '—'}d)${e.domReset === true ? ' · DOM reset' : ''}`;
    case 'rent_cut':
      return `${fmtPsf(num(e.prevAskingNnnEq) ?? num(e.prevRentLow))} → ${fmtPsf(num(e.askingNnnEq) ?? num(e.latestRentLow))}`;
    case 'below_market':
      return `${fmtPsf(num(e.askingNnnEq))} vs median ${fmtPsf(num(e.cellMedian))} (${fmtPct(num(e.gapPct))}) · n ${num(e.cellN) ?? '—'}`;
    case 'acq_candidate': {
      const flags: string[] = [];
      if (e.stale === true) flags.push('stale');
      if (e.rentCut === true) flags.push('rent cut');
      if (e.highVacancy === true) flags.push(`vacancy ${fmtPct(num(e.vacancyShare), false)}`);
      if (e.belowMarket === true) flags.push('below market');
      const owner = typeof e.ownerName === 'string' ? e.ownerName : 'redacted';
      return (
        `${flags.join(' · ')} · owner ${owner} (${num(e.ownerListingCount) ?? '—'} listings)` +
        (e.ownerVerify === true ? ' · VERIFY owner' : '') +
        (e.ownerAffiliated === true ? ' · ORA-affiliated' : '')
      );
    }
  }
}
```

Run: `npx vitest run tests/unit/lease-market-hooks.test.ts`
Expected: PASS. (If `@analytics/lease-market/benchmarks` does not resolve in the Vite/TS path config, use the relative import `../../analytics/lease-market/benchmarks`.)

- [ ] **Step 4: Write the failing smoke test**

```tsx
// tests/unit/lease-market-module-smoke.test.tsx
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LeaseMarketModule } from '../../src/modules/lease-market/LeaseMarketModule';
import { LEASE_MARKET_KEYS } from '../../src/modules/lease-market/hooks';
import type { LeaseMarketSummaryResponse, PositioningResponse, SignalsResponse } from '../../src/contracts/lease-market';

afterEach(cleanup);

const SUMMARY: LeaseMarketSummaryResponse = {
  asOf: '2026-03-01',
  rowLevel: true,
  freshness: [
    { marketId: 'columbus', label: 'Columbus', lastLandingDate: '2026-02-15', lastCompleteDate: '2026-02-15', lastCompleteness: 'complete', partialReason: null, stale: false },
    { marketId: 'madison', label: 'Madison', lastLandingDate: null, lastCompleteDate: null, lastCompleteness: null, partialReason: null, stale: true },
  ],
  benchmarks: [],
  distribution: [6, 7, 8, 9, 10].map((v, i) => ({ listingId: i + 1, marketId: 'columbus', subtype: 'warehouse' as const, sizeBand: '15-30K' as const, askingNnnEq: v, solid: true, isOra: false, address: `${i} Main St` })),
  domByMarket: [{ marketId: 'columbus', bins: [{ label: '0-90d', count: 5 }, { label: '90-180d', count: 0 }, { label: '180-365d', count: 0 }, { label: '365d+', count: 0 }] }],
};
const POSITIONING: PositioningResponse = {
  asOf: '2026-03-01',
  unconfiguredPropertyKeys: ['Sepich'],
  rows: [{ propertyKey: '1100 Rarig', unit: 'B', sf: 8000, oraAskingNnnEq: 12, cell: null, percentile: null, gapPct: 0.29, band: 'above', effectiveDom: 45 }],
};
const SIGNALS: SignalsResponse = {
  asOf: '2026-03-01',
  candidatesWithheld: [],
  signals: [{ id: 1, listingId: 2, marketId: 'columbus', address: '101 Industrial Pkwy', kind: 'acq_candidate', severity: 'high', cellKey: null, computedAt: '2026-03-01', evidence: { belowMarket: true, highVacancy: true, vacancyShare: 0.5, ownerName: 'SMITH FAMILY LLC', ownerListingCount: 11 } }],
};

function renderWith(summary: LeaseMarketSummaryResponse, positioning: PositioningResponse, signals: SignalsResponse) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(LEASE_MARKET_KEYS.summary, summary);
  qc.setQueryData(LEASE_MARKET_KEYS.positioning, positioning);
  qc.setQueryData(LEASE_MARKET_KEYS.signals, signals);
  return render(
    <QueryClientProvider client={qc}>
      <LeaseMarketModule />
    </QueryClientProvider>,
  );
}

describe('LeaseMarketModule', () => {
  it('renders freshness, positioning and signals without NaN', () => {
    renderWith(SUMMARY, POSITIONING, SIGNALS);
    expect(screen.getByText('Lease Market — export freshness')).toBeTruthy();
    expect(screen.getAllByText(/Columbus/).length).toBeGreaterThan(0);
    expect(screen.getByText('1100 Rarig')).toBeTruthy();
    expect(screen.getByText('Above market')).toBeTruthy();
    expect(screen.getByText('101 Industrial Pkwy')).toBeTruthy();
    expect(screen.getByText(/Not yet mapped to a comparable set: Sepich/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/NaN/);
  });

  it('renders explicit empty states', () => {
    renderWith(
      { ...SUMMARY, distribution: [], domByMarket: [] },
      { ...POSITIONING, rows: [], unconfiguredPropertyKeys: [] },
      { ...SIGNALS, signals: [] },
    );
    expect(screen.getByText('No quoted asking rents yet.')).toBeTruthy();
    expect(screen.getByText('No signals.')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/NaN/);
  });
});
```

Run: `npx vitest run tests/unit/lease-market-module-smoke.test.tsx`
Expected: FAIL — cannot resolve `LeaseMarketModule`.

- [ ] **Step 5: Write the module**

```tsx
// src/modules/lease-market/LeaseMarketModule.tsx
//
// Lease Market Intelligence UI (spec §4). Five sections:
//   1. Export freshness per market (select market)   2. Asking-rent distribution (StripPlot)
//   3. ORA vacant units vs. market                    4. Signals (filter by kind)
//   5. Days-on-market histogram
// All figures are ASKING rents on an NNN-equivalent basis. Degrades on the static mirror.
import { useMemo, useState } from 'react';
import { Card, CardHeader } from '@/primitives/Card';
import { Badge } from '@/primitives/Badge';
import { DataTable, type Column } from '@/primitives/DataTable';
import { BarChart } from '@/charts/BarChart';
import { StripPlot } from '@/charts/StripPlot';
import { isWarehouseUnavailable } from '../intel/hooks';
import type { PositioningRow, SignalKind, SignalRow } from '@contracts/lease-market';
import {
  KIND_LABELS, bandLabel, bandTone, buildStripGroups, evidenceSummary, fmtPct, fmtPsf, severityTone,
  useLeaseMarketPositioning, useLeaseMarketSignals, useLeaseMarketSummary,
} from './hooks';

const MUTED = { color: 'var(--text-tertiary)' } as const;
const SEVERITY_ORDER = { high: 0, watch: 1, info: 2 } as const;
const KIND_FILTERS: Array<SignalKind | 'all'> = ['all', 'acq_candidate', 'below_market', 'stale', 'rent_cut', 'new_listing'];

const positioningCols: Column<PositioningRow>[] = [
  { key: 'property', header: 'Property', render: (r) => <span style={{ fontWeight: 600 }}>{r.propertyKey}</span>, sortValue: (r) => r.propertyKey },
  { key: 'unit', header: 'Unit', render: (r) => r.unit ?? '—' },
  { key: 'sf', header: 'SF', align: 'right', render: (r) => r.sf.toLocaleString('en-US'), sortValue: (r) => r.sf },
  { key: 'asking', header: 'ORA asking', align: 'right', render: (r) => fmtPsf(r.oraAskingNnnEq), sortValue: (r) => r.oraAskingNnnEq },
  { key: 'median', header: 'Market median', align: 'right', render: (r) => fmtPsf(r.cell?.median), sortValue: (r) => r.cell?.median ?? null },
  { key: 'pctl', header: 'Percentile', align: 'right', render: (r) => (r.percentile === null ? '—' : `${Math.round(r.percentile * 100)}th`), sortValue: (r) => r.percentile },
  { key: 'gap', header: 'Gap', align: 'right', render: (r) => fmtPct(r.gapPct), sortValue: (r) => r.gapPct },
  { key: 'band', header: 'Band', render: (r) => <Badge tone={bandTone(r.band)}>{bandLabel(r.band)}</Badge>, sortValue: (r) => r.band },
  {
    key: 'cell',
    header: 'Comparable set',
    render: (r) =>
      r.cell
        ? `n ${r.cell.n} of ${r.cell.totalN}${r.cell.lowCoverage ? ' · low coverage' : ''}${r.cell.rolledUp === 'none' ? '' : r.cell.rolledUp === 'market' ? ' · market-wide' : ' · wider size'}`
        : '—',
  },
  { key: 'dom', header: 'DOM', align: 'right', render: (r) => (r.effectiveDom === null ? '—' : `${r.effectiveDom}d`), sortValue: (r) => r.effectiveDom },
];

const signalCols: Column<SignalRow>[] = [
  { key: 'severity', header: 'Severity', render: (s) => <Badge tone={severityTone(s.severity)}>{s.severity}</Badge>, sortValue: (s) => SEVERITY_ORDER[s.severity] },
  { key: 'kind', header: 'Signal', render: (s) => KIND_LABELS[s.kind], sortValue: (s) => s.kind },
  { key: 'market', header: 'Market', render: (s) => s.marketId, sortValue: (s) => s.marketId },
  { key: 'address', header: 'Space', render: (s) => s.address ?? '—', sortValue: (s) => s.address },
  { key: 'evidence', header: 'Evidence', render: (s) => evidenceSummary(s) },
];

function Toggle({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className="rounded-[var(--radius-sm)] px-2 py-1 text-2xs"
      style={{ border: `1px solid ${active ? 'var(--accent)' : 'var(--border-subtle)'}`, color: 'var(--text-secondary)' }}
    >
      {children}
    </button>
  );
}

export function LeaseMarketModule() {
  const summary = useLeaseMarketSummary();
  const positioning = useLeaseMarketPositioning();
  const signals = useLeaseMarketSignals();
  const [selectedMarket, setSelectedMarket] = useState<string | null>(null);
  const [kind, setKind] = useState<SignalKind | 'all'>('all');

  const data = summary.data;
  const marketId = selectedMarket ?? data?.freshness.find((f) => f.lastCompleteDate !== null)?.marketId ?? data?.freshness[0]?.marketId ?? null;
  const groups = useMemo(() => (data && marketId ? buildStripGroups(data.distribution, marketId) : []), [data, marketId]);
  const visibleSignals = useMemo(() => (signals.data?.signals ?? []).filter((s) => kind === 'all' || s.kind === kind), [signals.data, kind]);

  if (summary.isLoading) return <div className="p-6 text-2xs" style={MUTED}>Loading lease market…</div>;
  if (!data) {
    return (
      <Card>
        <div className="p-6 text-sm" style={{ color: 'var(--text-secondary)' }}>
          {isWarehouseUnavailable(summary.error)
            ? 'Lease market data is not available on this mirror.'
            : `Lease market failed to load: ${summary.error instanceof Error ? summary.error.message : 'unknown error'}`}
        </div>
      </Card>
    );
  }

  const selectedLabel = data.freshness.find((f) => f.marketId === marketId)?.label ?? '—';
  const dom = data.domByMarket.find((d) => d.marketId === marketId);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader title="Lease Market — export freshness" trailing={<span className="text-2xs" style={MUTED}>as of {data.asOf} · asking rents, NNN-equivalent $/SF/yr</span>} />
        <div className="flex flex-wrap gap-2 p-4">
          {data.freshness.map((f) => (
            <Toggle key={f.marketId} active={f.marketId === marketId} onClick={() => setSelectedMarket(f.marketId)}>
              <span title={f.partialReason ?? undefined}>
                {f.label} <Badge tone={f.stale ? 'amber' : 'green'}>{f.lastCompleteDate ?? 'no export'}</Badge>
              </span>
            </Toggle>
          ))}
        </div>
      </Card>

      <Card>
        <CardHeader
          title={`Asking rent distribution — ${selectedLabel}`}
          trailing={<span className="text-2xs" style={MUTED}>● quoted NNN · ○ converted · gold = ORA · band P25–P75 · tick = median (n ≥ 5)</span>}
        />
        <div className="p-4">
          <StripPlot groups={groups} />
        </div>
      </Card>

      <Card>
        <CardHeader title="ORA vacant units vs. market" />
        <div className="p-4">
          {positioning.data ? (
            <>
              {positioning.data.rows.length === 0 ? (
                <p className="text-2xs" style={MUTED}>No vacant ORA units mapped to a comparable set.</p>
              ) : (
                <DataTable columns={positioningCols} rows={positioning.data.rows} getRowId={(r) => `${r.propertyKey}|${r.unit ?? ''}`} initialSort={{ key: 'gap', dir: 'desc' }} />
              )}
              {positioning.data.unconfiguredPropertyKeys.length > 0 && (
                <p className="mt-2 text-2xs" style={MUTED}>Not yet mapped to a comparable set: {positioning.data.unconfiguredPropertyKeys.join(', ')}</p>
              )}
            </>
          ) : (
            <p className="text-2xs" style={MUTED}>{positioning.isLoading ? 'Loading…' : 'Positioning unavailable (needs the live rent roll).'}</p>
          )}
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Signals"
          trailing={
            <div className="flex flex-wrap gap-1">
              {KIND_FILTERS.map((k) => (
                <Toggle key={k} active={kind === k} onClick={() => setKind(k)}>
                  {k === 'all' ? 'All' : KIND_LABELS[k]}
                </Toggle>
              ))}
            </div>
          }
        />
        <div className="p-4">
          {(signals.data?.candidatesWithheld ?? []).map((w) => (
            <p key={w.marketId} className="mb-2 text-2xs" style={{ color: 'var(--color-warn)' }}>
              {w.marketId}: {w.reason}
            </p>
          ))}
          {visibleSignals.length === 0 ? (
            <p className="text-2xs" style={MUTED}>No signals.</p>
          ) : (
            <DataTable columns={signalCols} rows={visibleSignals} getRowId={(s) => String(s.id)} />
          )}
        </div>
      </Card>

      <Card>
        <CardHeader title={`Days on market — ${selectedLabel}`} />
        <div className="p-4">
          {dom ? <BarChart data={dom.bins.map((b) => ({ label: b.label, value: b.count }))} /> : <p className="text-2xs" style={MUTED}>No listings yet.</p>}
        </div>
      </Card>
    </div>
  );
}
```

If `React.ReactNode` is not in scope under the repo's JSX settings, add `import type { ReactNode } from 'react';` and use `ReactNode`.

- [ ] **Step 6: Register the module**

In `src/shell/modules.tsx`, next to the other lazy imports add:

```tsx
const LeaseMarketModule = lazy(() => import('@/modules/lease-market/LeaseMarketModule').then((m) => ({ default: m.LeaseMarketModule })));
```

and directly after the `{ id: 'market', ... }` entry in `MODULES` add:

```tsx
  { id: 'lease-market', label: 'Lease Market', icon: Building2, group: 'Market', Component: LeaseMarketModule },
```

(`Building2` is already imported from `lucide-react` in that file.)

- [ ] **Step 7: Run tests, typecheck, lint, dev-css**

Run: `npx vitest run tests/unit/lease-market-hooks.test.ts tests/unit/lease-market-module-smoke.test.tsx tests/unit/module-order.test.ts && npm run typecheck && npm run lint && npm run check:dev-css`
Expected: PASS / clean.

- [ ] **Step 8: Commit**

```bash
git add src/modules/lease-market/hooks.ts src/modules/lease-market/LeaseMarketModule.tsx src/shell/modules.tsx tests/unit/lease-market-hooks.test.ts tests/unit/lease-market-module-smoke.test.tsx
git commit -F <message-file>   # "feat(ui): Lease Market module — freshness, distribution, positioning, signals, DOM"
```
