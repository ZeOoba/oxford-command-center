// src/modules/capital/CapitalAllocationModule.tsx
//
// Phase 5 — Capital Allocation Capstone UI module.
//
// Renders a ranked capital allocation table synthesizing health/attention scores,
// Phase 2 debt signals, Phase 3 leasing risk, and FRED macro context into a
// single prioritized view.
//
// Layout:
//   1. KPI header: 4 action-count stat cards (Invest/Hold/Monitor/Disposition)
//   2. FRED macro banner (amber "Seeded Fallback" badge when source === 'mock')
//   3. DataTable: ranked property entries, sorted DESC by priorityScore
//   4. Spine-A footnote
//
// Error policy: degrades to an informational empty state when the warehouse is
// offline (mirrors ScorecardView in debt module).
import { useQuery } from '@tanstack/react-query';
import { PieChart } from 'lucide-react';
import { fetchParsedOrMirror, isWarehouseUnavailable, QUERY_OPTS } from '../intel/hooks';
import { CapitalAllocationReport } from '@contracts/capital-allocation';
import type { CapitalAllocationEntry } from '@contracts/capital-allocation';
import { Card, CardHeader } from '@/primitives/Card';
import { KpiStat } from '@/primitives/KpiStat';
import { DataTable, type Column } from '@/primitives/DataTable';
import { Badge, type BadgeTone } from '@/primitives/Badge';
import { Skeleton } from '@/primitives/Skeleton';

// ── Local hooks ────────────────────────────────────────────────────────────────

function useCapitalAllocation() {
  return useQuery({
    queryKey: ['warehouse', 'capital-allocation'] as const,
    queryFn: () =>
      fetchParsedOrMirror('/api/warehouse/capital-allocation', CapitalAllocationReport),
    ...QUERY_OPTS,
  });
}

// ── Display helpers ────────────────────────────────────────────────────────────

function actionTone(action: CapitalAllocationEntry['capitalAction']): BadgeTone {
  switch (action) {
    case 'invest': return 'green';
    case 'hold': return 'neutral';
    case 'monitor': return 'amber';
    case 'disposition-candidate': return 'red';
    default: return 'neutral';
  }
}

function actionLabel(action: CapitalAllocationEntry['capitalAction']): string {
  switch (action) {
    case 'invest': return 'Invest';
    case 'hold': return 'Hold';
    case 'monitor': return 'Monitor';
    case 'disposition-candidate': return 'Disp.';
    default: return action;
  }
}

function fmtScore(n: number | null): string {
  if (n === null) return '—';
  return Math.round(n).toString();
}

function fmtUsdCompactLocal(n: number): string {
  if (n === 0) return '—';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${Math.round(n)}`;
}

function fmtSf(n: number): string {
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return `${n}`;
}

// ── Market cap-rate helpers ──────────────────────────────────────────────────────
// All fail-open: null inputs render '—'. capRatePercentile is a discrete band
// (bottom/median/top) — never interpolated.

function fmtCapRate(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(1)}%`;
}

/** Signed gap in basis points vs market median. Positive = higher yield than market. */
function fmtCapRateGap(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  const bps = Math.round(n * 10_000);
  return `${bps >= 0 ? '+' : ''}${bps} bps`;
}

function capBandLabel(band: CapitalAllocationEntry['capRatePercentile']): string {
  switch (band) {
    case 'bottom': return 'Below mkt';
    case 'median': return 'At mkt';
    case 'top': return 'Above mkt';
    default: return '—';
  }
}

function capBandTone(band: CapitalAllocationEntry['capRatePercentile']): BadgeTone {
  // Cap-rate level only — NOT a desirability judgment. 'top' = higher yield / cheaper basis.
  switch (band) {
    case 'top': return 'green';
    case 'median': return 'neutral';
    case 'bottom': return 'amber';
    default: return 'neutral';
  }
}

// ── Table columns ──────────────────────────────────────────────────────────────

const COLS: Column<CapitalAllocationEntry>[] = [
  {
    key: 'property',
    header: 'Property',
    render: (e) => (
      <div>
        <div style={{ fontWeight: 600, fontSize: '0.75rem', color: 'var(--text-primary)' }}>
          {e.propertyName ?? e.propertyId}
        </div>
        {e.market && (
          <div className="num text-2xs" style={{ color: 'var(--text-tertiary)' }}>
            {e.market}
          </div>
        )}
      </div>
    ),
    sortValue: (e) => e.propertyName ?? e.propertyId,
  },
  {
    key: 'sf',
    header: 'SF',
    align: 'right',
    render: (e) => (
      <span className="num text-xs" style={{ color: 'var(--text-secondary)' }}>
        {fmtSf(e.sf)}
      </span>
    ),
    sortValue: (e) => e.sf,
  },
  {
    key: 'action',
    header: 'Action',
    render: (e) => <Badge tone={actionTone(e.capitalAction)}>{actionLabel(e.capitalAction)}</Badge>,
    sortValue: (e) => e.capitalAction,
  },
  {
    key: 'priority',
    header: 'Priority',
    align: 'right',
    render: (e) => (
      <span
        className="num text-xs font-semibold"
        style={{
          color: e.priorityScore >= 60
            ? 'var(--color-neg)'
            : e.priorityScore >= 35
            ? 'var(--color-warn)'
            : 'var(--text-primary)',
        }}
      >
        {Math.round(e.priorityScore)}
      </span>
    ),
    sortValue: (e) => e.priorityScore,
  },
  {
    key: 'health',
    header: 'Health',
    align: 'right',
    render: (e) => (
      <span className="num text-xs" style={{ color: 'var(--text-secondary)' }}>
        {fmtScore(e.healthScore)}
      </span>
    ),
    sortValue: (e) => e.healthScore ?? -1,
  },
  {
    key: 'leasing',
    header: 'Leasing Risk',
    align: 'right',
    render: (e) => (
      <span className="num text-xs" style={{ color: e.nearTermExpiryRent > 0 ? 'var(--color-warn)' : 'var(--text-tertiary)' }}>
        {e.nearTermExpiryRent > 0 ? fmtUsdCompactLocal(e.nearTermExpiryRent) : '—'}
      </span>
    ),
    sortValue: (e) => e.nearTermExpiryRent,
  },
  {
    key: 'debt',
    header: 'Debt Score',
    align: 'right',
    render: (e) => (
      <span className="num text-xs" style={{ color: 'var(--text-secondary)' }}>
        {e.debtScore !== null ? Math.round(e.debtScore).toString() : '—'}
      </span>
    ),
    sortValue: (e) => e.debtScore ?? 999,
  },
  {
    key: 'impliedCap',
    header: 'Implied Cap',
    align: 'right',
    render: (e) => (
      <span className="num text-xs" style={{ color: 'var(--text-secondary)' }}>
        {fmtCapRate(e.impliedCapRate)}
      </span>
    ),
    sortValue: (e) => e.impliedCapRate ?? -1,
  },
  {
    key: 'capGap',
    header: 'vs Mkt',
    align: 'right',
    render: (e) => (
      <span
        className="num text-xs"
        style={{
          color: e.capRateGap === null
            ? 'var(--text-tertiary)'
            : e.capRateGap >= 0
            ? 'var(--color-pos)'
            : 'var(--color-warn)',
        }}
      >
        {fmtCapRateGap(e.capRateGap)}
      </span>
    ),
    sortValue: (e) => e.capRateGap ?? -999,
  },
  {
    key: 'capBand',
    header: 'Cap Band',
    render: (e) =>
      e.capRatePercentile === null ? (
        <span className="num text-2xs" style={{ color: 'var(--text-tertiary)' }}>—</span>
      ) : (
        <Badge tone={capBandTone(e.capRatePercentile)}>{capBandLabel(e.capRatePercentile)}</Badge>
      ),
    sortValue: (e) => e.capRatePercentile ?? '',
  },
  {
    key: 'rationale',
    header: 'Rationale',
    render: (e) => (
      <span className="text-2xs" style={{ color: 'var(--text-tertiary)', maxWidth: 280, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {e.rationale.length > 0 ? e.rationale[0] : '—'}
      </span>
    ),
    sortValue: (e) => e.rationale[0] ?? '',
  },
];

// ── Main component ─────────────────────────────────────────────────────────────

export function CapitalAllocationModule() {
  const { data, isLoading, error } = useCapitalAllocation();

  if (isLoading) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton style={{ height: 88 }} />
        <Skeleton style={{ height: 320 }} />
      </div>
    );
  }

  if (isWarehouseUnavailable(error)) {
    return (
      <Card>
        <CardHeader
          title="Capital Allocation"
          trailing={<Badge tone="neutral">offline</Badge>}
        />
        <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
          <PieChart size={28} style={{ color: 'var(--text-tertiary)' }} />
          <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            Capital allocation requires the live brain server.
          </div>
          <div className="text-2xs" style={{ color: 'var(--text-tertiary)', maxWidth: 420 }}>
            Scores are computed from the workbook snapshot (Spine A — ownership layer).
            This deployed mirror does not include the live warehouse.
          </div>
        </div>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardHeader
          title="Capital Allocation"
          trailing={<Badge tone="red">error</Badge>}
        />
        <div className="px-4 py-6 text-sm" style={{ color: 'var(--color-neg)' }}>
          {error instanceof Error ? error.message : 'Failed to load capital allocation.'}
        </div>
      </Card>
    );
  }

  if (!data) return null;

  const { entries, macro } = data;
  const isMacroSeeded = macro.source === 'mock';
  const bench = data.marketBenchmarks;
  const benchSeeded = bench.source === 'seed';
  const benchUnavailable = !bench.available || bench.source === 'unavailable';
  const regional = data.regionalMacro;
  const isRegionalSeeded = regional?.source === 'mock';

  return (
    <div className="flex flex-col gap-4">
      {/* KPI header */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiStat
          label="Invest"
          value={data.investCount}
          format={(n) => String(n)}
          accentColor="var(--color-pos)"
          sublabel="expand capital"
        />
        <KpiStat
          label="Hold"
          value={data.holdCount}
          format={(n) => String(n)}
          sublabel="stable"
        />
        <KpiStat
          label="Monitor"
          value={data.monitorCount}
          format={(n) => String(n)}
          accentColor="var(--color-warn)"
          sublabel="watch closely"
        />
        <KpiStat
          label="Disposition"
          value={data.dispositionCount}
          format={(n) => String(n)}
          accentColor="var(--color-neg)"
          sublabel="consider exit"
        />
      </div>

      {/* FRED macro banner */}
      <Card>
        <div className="flex flex-col gap-2 px-4 py-3">
          {/* Row 1 — national macro (10Y / CPI) */}
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                Macro context
              </span>
              {isMacroSeeded && (
                <Badge tone="amber">Seeded Fallback</Badge>
              )}
            </div>
            <div className="flex items-center gap-4 ml-2">
              {macro.tenYearRate !== null && (
                <div className="flex items-center gap-1">
                  <span className="text-2xs" style={{ color: 'var(--text-tertiary)' }}>10Y:</span>
                  <span className="num text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
                    {macro.tenYearRate.toFixed(2)}%
                  </span>
                </div>
              )}
              {macro.cpi !== null && (
                <div className="flex items-center gap-1">
                  <span className="text-2xs" style={{ color: 'var(--text-tertiary)' }}>CPI:</span>
                  <span className="num text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
                    {macro.cpi.toFixed(1)}%
                  </span>
                </div>
              )}
              {macro.asOf && (
                <span className="num text-2xs" style={{ color: 'var(--text-tertiary)' }}>
                  as of {macro.asOf}
                </span>
              )}
            </div>
          </div>

          {/* Row 2 — regional markets (state unemployment) */}
          {regional && regional.states.length > 0 && (
            <div className="flex items-center gap-4" style={{ borderTop: '1px solid var(--border-subtle, rgba(0,0,0,0.08))', paddingTop: 8 }}>
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                  Regional Markets
                </span>
                {isRegionalSeeded && (
                  <Badge tone="amber">Seeded Fallback</Badge>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 ml-2">
                {regional.states.map((s) => (
                  <div key={s.stateCode} className="flex items-center gap-1">
                    <span className="text-2xs" style={{ color: 'var(--text-tertiary)' }}>{s.stateCode}:</span>
                    <span className="num text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
                      {s.unemploymentRate !== null ? `${s.unemploymentRate.toFixed(1)}%` : '—'}
                    </span>
                  </div>
                ))}
                <span className="num text-2xs" style={{ color: 'var(--text-tertiary)' }}>
                  unemployment{regional.asOf ? ` · as of ${regional.asOf}` : ''}
                </span>
              </div>
            </div>
          )}
        </div>
      </Card>

      {/* Ranked property table */}
      <Card>
        <CardHeader
          title="Capital Allocation — Ranked Properties"
          trailing={
            <div className="flex items-center gap-1.5">
              <Badge tone="neutral">{entries.length} properties</Badge>
              {!isMacroSeeded && <Badge tone="green">FRED live</Badge>}
              {benchUnavailable ? (
                <Badge tone="neutral">Cap benchmarks offline</Badge>
              ) : benchSeeded ? (
                <Badge tone="amber">Cap benchmarks: seeded</Badge>
              ) : (
                <Badge tone="green">Cap benchmarks: live</Badge>
              )}
            </div>
          }
        />
        {entries.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
            <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              No properties scored yet.
            </div>
            <div className="text-2xs" style={{ color: 'var(--text-tertiary)', maxWidth: 420 }}>
              Refresh the snapshot after the master workbook is updated and the warehouse
              backfill has run to populate health/attention scores.
            </div>
          </div>
        ) : (
          <DataTable
            columns={COLS}
            rows={entries}
            getRowId={(e) => e.propertyId}
            initialSort={{ key: 'priority', dir: 'desc' }}
            minWidth={1040}
          />
        )}
      </Card>

      {/* Spine-A footnote */}
      <div className="px-1 pb-1">
        <p className="num text-2xs" style={{ color: 'var(--text-tertiary)' }}>
          NOI and SF from workbook snapshot (Spine A — ownership layer).
          Priority score = 0.35×(100−health) + 0.30×attention + 0.20×leasingRisk + 0.15×debtUrgency.
          Not comparable with warehouse-ledger analytics (Spine B).
        </p>
        <p className="num text-2xs" style={{ color: 'var(--text-tertiary)', marginTop: 4 }}>
          Cap rate based on Spine A NOI + workbook value. Implied cap = NOI ÷ Oxford-share value;
          “vs Mkt” and Cap Band compare against external market benchmarks
          {benchUnavailable
            ? ' (benchmarks unavailable — cap columns blank).'
            : benchSeeded
            ? ' (seeded snapshot — set a live feed for FRED-backed bands).'
            : ' (live feed).'}{' '}
          Cap Band is a discrete position (below / at / above market), not a continuous percentile,
          and is diagnostic only — it does not affect the priority score or capital action.
        </p>
        {regional && (
          <p className="num text-2xs" style={{ color: 'var(--text-tertiary)', marginTop: 4 }}>
            Regional Markets: State unemployment from FRED (monthly, seasonally adjusted)
            {isRegionalSeeded ? ' — seeded snapshot; set FRED_API_KEY for live data.' : '.'}{' '}
            Diagnostic labor-market context only — does not affect the priority score or capital action.
          </p>
        )}
      </div>
    </div>
  );
}
