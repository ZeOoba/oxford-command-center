// src/modules/market/CompsView.tsx
//
// IMPLEMENTATION_PLAN.md task 7.3 — "Comps surface: CompSet + CapRateBenchmark view (Market
// module tab)". Data binding: dealComps overlay CompSets + the capital-allocation cap-rate
// diagnostics (see comps-hooks.ts for why that, and not a raw MarketBenchmarkSet fetch, is the
// correct "reuse" here).
//
// Section 1 — Sale & Rent Comps: every CompSet in snapshot.dealComps (Spine-A overlay, captured
// per-deal during due diligence via the "Research" action in src/brain/DealDrawer.tsx). There is
// no dedicated "all comps" API route — this is the same overlay data DealDrawer already reads.
//
// Section 2 — Submarket Cap Rate Benchmarks: reuses useCapitalAllocationReport() (comps-hooks.ts),
// which shares its TanStack Query key with CapitalModule's own cap-rate panel, so the figures
// match by construction.
import { useMemo } from 'react';
import type { CompSet, SaleComp, RentComp, Deal } from '@contracts/index';
import type { CapitalAllocationEntry, CapitalAllocationReport } from '@contracts/capital-allocation';
import type { CapRatePercentile } from '@contracts/market-intelligence';
import { fmtUsdCompact, fmtSf, fmtNum, fmtDate } from '@analytics/index';
import { useSnapshot } from '@/data/queries';
import { useCapitalAllocationReport } from './comps-hooks';
import { Card, CardHeader } from '@/primitives/Card';
import { Badge, type BadgeTone } from '@/primitives/Badge';
import { Skeleton } from '@/primitives/Skeleton';
import { DataTable, type Column } from '@/primitives/DataTable';

// ── pure helpers (module scope — no derivation logic in component bodies) ──────────────────

// Precision matches CapitalModule's own fmtCapRate/fmtCapRateGap (src/modules/capital/CapitalModule.tsx)
// so the rendered strings — not just the underlying numbers — are identical between the two panels.
function fmtCapRate(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(1)}%`;
}

function fmtCapRateGap(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  const bps = Math.round(n * 10_000);
  return `${bps >= 0 ? '+' : ''}${bps} bps`;
}

function bandLabel(band: CapRatePercentile | null): string {
  switch (band) {
    case 'bottom': return 'Below mkt';
    case 'median': return 'At mkt';
    case 'top': return 'Above mkt';
    default: return '—';
  }
}

// Tone mapping matches CapitalModule's own capBandTone verbatim — cap-rate level only, not a
// desirability judgment ('top' = higher yield / cheaper basis).
function bandTone(band: CapRatePercentile | null): BadgeTone {
  switch (band) {
    case 'top': return 'green';
    case 'median': return 'neutral';
    case 'bottom': return 'amber';
    default: return 'neutral';
  }
}

type BenchmarkSource = CapitalAllocationReport['marketBenchmarks']['source'];

function benchmarkBadgeTone(source: BenchmarkSource): BadgeTone {
  if (source === 'fred') return 'green';
  if (source === 'seed') return 'amber';
  return 'neutral';
}

function benchmarkBadgeLabel(source: BenchmarkSource): string {
  if (source === 'fred') return 'Cap benchmarks: live';
  if (source === 'seed') return 'Cap benchmarks: seeded';
  return 'Cap benchmarks offline';
}

interface DealCompRow {
  dealId: string;
  dealName: string;
  compSet: CompSet;
}

/** Groups dealComps by the deal it belongs to, resolving each deal's display name from
 *  snapshot.deals. Falls back to the raw dealId if the deal record is missing (deleted deal,
 *  stale overlay entry) so a comp set is never silently dropped. */
function buildDealCompRows(deals: Deal[], dealComps: Record<string, CompSet>): DealCompRow[] {
  const nameById = new Map(deals.map((d) => [d.id, d.name]));
  return Object.entries(dealComps).map(([dealId, compSet]) => ({
    dealId,
    dealName: nameById.get(dealId) ?? dealId,
    compSet,
  }));
}

interface KeyedRow { _key: string }
type IndexedSaleComp = SaleComp & KeyedRow;
type IndexedRentComp = RentComp & KeyedRow;

/** SaleComp/RentComp carry no id (AI-sourced free text) — derive a stable per-table key from the
 *  deal + row position rather than address/source, which can legitimately repeat. */
function indexRows<T>(rows: T[], keyPrefix: string): (T & KeyedRow)[] {
  return rows.map((r, i) => ({ ...r, _key: `${keyPrefix}-${i}` }));
}

const SALE_COLUMNS: Column<IndexedSaleComp>[] = [
  { key: 'address', header: 'Address', render: (r) => r.address },
  { key: 'market', header: 'Market', render: (r) => r.market ?? '—' },
  { key: 'sf', header: 'SF', align: 'right', render: (r) => fmtSf(r.sf), sortValue: (r) => r.sf },
  { key: 'price', header: 'Price', align: 'right', render: (r) => fmtUsdCompact(r.price), sortValue: (r) => r.price },
  { key: 'pricePerSf', header: '$/SF', align: 'right', render: (r) => (r.pricePerSf !== null ? `$${fmtNum(r.pricePerSf)}` : '—'), sortValue: (r) => r.pricePerSf },
  { key: 'capRate', header: 'Cap Rate', align: 'right', render: (r) => fmtCapRate(r.capRate), sortValue: (r) => r.capRate },
  { key: 'date', header: 'Date', align: 'right', render: (r) => r.date ?? '—' },
  { key: 'source', header: 'Source', render: (r) => r.source },
];

const RENT_COLUMNS: Column<IndexedRentComp>[] = [
  { key: 'address', header: 'Address', render: (r) => r.address },
  { key: 'sf', header: 'SF', align: 'right', render: (r) => fmtSf(r.sf), sortValue: (r) => r.sf },
  { key: 'rentPerSf', header: 'Rent $/SF', align: 'right', render: (r) => (r.rentPerSf !== null ? `$${fmtNum(r.rentPerSf)}` : '—'), sortValue: (r) => r.rentPerSf },
  { key: 'leaseType', header: 'Lease Type', render: (r) => r.leaseType ?? '—' },
  { key: 'date', header: 'Date', align: 'right', render: (r) => r.date ?? '—' },
  { key: 'source', header: 'Source', render: (r) => r.source },
];

interface BenchmarkRow {
  propertyId: string;
  propertyName: string | null;
  market: string | null;
  impliedCapRate: number | null;
  capRateGap: number | null;
  capRatePercentile: CapRatePercentile | null;
}

function toBenchmarkRows(entries: CapitalAllocationEntry[]): BenchmarkRow[] {
  return entries.map((e) => ({
    propertyId: e.propertyId,
    propertyName: e.propertyName,
    market: e.market,
    impliedCapRate: e.impliedCapRate,
    capRateGap: e.capRateGap,
    capRatePercentile: e.capRatePercentile,
  }));
}

const BENCHMARK_COLUMNS: Column<BenchmarkRow>[] = [
  { key: 'market', header: 'Market', render: (r) => r.market ?? '—', sortValue: (r) => r.market ?? '' },
  { key: 'property', header: 'Property', render: (r) => r.propertyName ?? r.propertyId, sortValue: (r) => r.propertyName ?? r.propertyId },
  { key: 'impliedCapRate', header: 'Implied Cap Rate', align: 'right', render: (r) => fmtCapRate(r.impliedCapRate), sortValue: (r) => r.impliedCapRate ?? -1 },
  { key: 'capRateGap', header: 'Gap vs Mkt P50', align: 'right', render: (r) => fmtCapRateGap(r.capRateGap), sortValue: (r) => r.capRateGap ?? -999 },
  {
    key: 'band',
    header: 'Band',
    render: (r) => (
      r.capRatePercentile === null
        ? <span style={{ color: 'var(--text-tertiary)' }}>—</span>
        : <Badge tone={bandTone(r.capRatePercentile)}>{bandLabel(r.capRatePercentile)}</Badge>
    ),
    sortValue: (r) => r.capRatePercentile ?? '',
  },
];

// ── Section 1 — Sale & Rent Comps ────────────────────────────────────────────────────────────

function DealComps({ row }: { row: DealCompRow }) {
  const { compSet, dealName, dealId } = row;
  const indexedSales = indexRows(compSet.saleComps, `${dealId}-sale`);
  const indexedRents = indexRows(compSet.rentComps, `${dealId}-rent`);

  return (
    <Card>
      <CardHeader
        title={dealName}
        trailing={
          <div className="flex items-center gap-2">
            <Badge tone="neutral">{compSet.sources.length} source{compSet.sources.length === 1 ? '' : 's'}</Badge>
            <span className="num text-2xs" style={{ color: 'var(--text-tertiary)' }}>
              Sourced {fmtDate(compSet.sourcedAt.slice(0, 10))}
            </span>
          </div>
        }
      />
      <div className="flex flex-col gap-4 p-4">
        {compSet.summary && (
          <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>{compSet.summary}</p>
        )}

        <div>
          <div className="mb-1.5 text-2xs font-semibold uppercase" style={{ letterSpacing: '0.08em', color: 'var(--text-tertiary)' }}>
            Sale Comps ({compSet.saleComps.length})
          </div>
          {indexedSales.length === 0 ? (
            <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>No sale comps captured.</div>
          ) : (
            <DataTable columns={SALE_COLUMNS} rows={indexedSales} getRowId={(r) => r._key} />
          )}
        </div>

        <div>
          <div className="mb-1.5 text-2xs font-semibold uppercase" style={{ letterSpacing: '0.08em', color: 'var(--text-tertiary)' }}>
            Rent Comps ({compSet.rentComps.length})
          </div>
          {indexedRents.length === 0 ? (
            <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>No rent comps captured.</div>
          ) : (
            <DataTable columns={RENT_COLUMNS} rows={indexedRents} getRowId={(r) => r._key} />
          )}
        </div>

        {compSet.submarketStats.length > 0 && (
          <div>
            <div className="mb-1.5 text-2xs font-semibold uppercase" style={{ letterSpacing: '0.08em', color: 'var(--text-tertiary)' }}>
              Submarket Stats
            </div>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              {compSet.submarketStats.map((s, i) => (
                <div key={i} className="rounded-[var(--radius-sm)] p-2" style={{ background: 'var(--surface-overlay)' }}>
                  <div className="text-2xs" style={{ color: 'var(--text-tertiary)' }}>{s.label}</div>
                  <div className="num text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>{s.value}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

function SaleRentCompsSection() {
  const { data, isLoading } = useSnapshot();
  const dealRows = useMemo(
    () => (data ? buildDealCompRows(data.snapshot.deals, data.snapshot.dealComps) : []),
    [data],
  );

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          title="Sale & Rent Comps"
          trailing={<Badge tone="neutral">{dealRows.length} deal{dealRows.length === 1 ? '' : 's'} with comps</Badge>}
        />
      </Card>

      {isLoading ? (
        <Skeleton style={{ height: 160 }} />
      ) : dealRows.length === 0 ? (
        <Card>
          <div className="px-4 py-8 text-center text-sm" style={{ color: 'var(--text-tertiary)' }}>
            No comps captured yet — comps are recorded per-deal during due diligence.
          </div>
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          {dealRows.map((row) => <DealComps key={row.dealId} row={row} />)}
        </div>
      )}
    </div>
  );
}

// ── Section 2 — Submarket Cap Rate Benchmarks ────────────────────────────────────────────────

function BenchmarkSection() {
  const { data: report, isLoading } = useCapitalAllocationReport();
  const bench = report?.marketBenchmarks;
  const rows = useMemo(() => (report ? toBenchmarkRows(report.entries) : []), [report]);

  return (
    <Card>
      <CardHeader
        title="Submarket Cap Rate Benchmarks"
        trailing={
          bench ? (
            <div className="flex items-center gap-2">
              <Badge tone={benchmarkBadgeTone(bench.source)}>{benchmarkBadgeLabel(bench.source)}</Badge>
              {bench.asOf && (
                <span className="num text-2xs" style={{ color: 'var(--text-tertiary)' }}>as of {fmtDate(bench.asOf)}</span>
              )}
            </div>
          ) : undefined
        }
      />
      <div className="p-4">
        <p className="mb-3 text-xs leading-relaxed" style={{ color: 'var(--text-tertiary)' }}>
          Per-property implied cap rate vs. external market benchmark — the same Market
          Cap-Rate Positioning data (GET /api/warehouse/capital-allocation) shown in the Capital
          module, sorted by market. Diagnostic only; does not feed capitalAction or priorityScore.
        </p>
        {isLoading ? (
          <Skeleton style={{ height: 160 }} />
        ) : !report || rows.length === 0 ? (
          <div className="py-6 text-center text-sm" style={{ color: 'var(--text-tertiary)' }}>
            No cap-rate benchmark data available.
          </div>
        ) : (
          <DataTable
            columns={BENCHMARK_COLUMNS}
            rows={rows}
            getRowId={(r) => r.propertyId}
            initialSort={{ key: 'market', dir: 'asc' }}
          />
        )}
      </div>
    </Card>
  );
}

export function CompsView() {
  return (
    <div className="flex flex-col gap-4">
      <SaleRentCompsSection />
      <BenchmarkSection />
    </div>
  );
}
