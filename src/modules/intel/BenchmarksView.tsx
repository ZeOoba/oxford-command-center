// src/modules/intel/BenchmarksView.tsx
//
// Portfolio benchmarks (PFI Phase B.2). Pick a FULL-YEAR period + a metric and see the
// cohort summary (avg / median / p25 / p75 / n), each property's rank + quartile, a
// proportional BarList of the ranking, and the NOI-by-property matrix (moved here from the
// old 'overview' tab so every period is visible in one place).
//
// Selectors are local useState. They offer ONLY full-year periods present in metrics
// (latest first → default latest FY, never a 2026-YTD) and ONLY the 12 metric enum keys,
// so the `/benchmarks?period=&metric=` route never 400s (pre-mortem #5/#7). Values format
// per metric ($ / $/SF as USD, ratios as %) and null never reaches `.toFixed` (pre-mortem
// #2). Quartile badges: 1 green / 2 blue / 3 amber / 4 red / null neutral "n/a"; a singleton
// or empty cohort shows an explicit "insufficient peers for quartiles" note. Row click →
// the Property tab via the lifted onOpenProperty. No raw hex — theme tokens only.
import { useMemo, useState } from 'react';
import { Database } from 'lucide-react';
import { fmtNum, fmtUsd } from '@analytics/index';
import { Card, CardHeader } from '@/primitives/Card';
import { Badge, type BadgeTone } from '@/primitives/Badge';
import { Skeleton } from '@/primitives/Skeleton';
import { DataTable, type Column } from '@/primitives/DataTable';
import { BarList, type BarListItem } from '@/charts/BarList';
import { isWarehouseUnavailable, groupNoiByProperty, useNoiMatrix, type NoiMatrixCell } from './hooks';
import {
  useMetrics,
  useBenchmarks,
  type NumericMetricKey,
  type PropertyRank,
  type Quartile,
} from './analytics-hooks';
import {
  availableFyPeriods,
  metricFormatter,
  METRIC_KEYS,
  METRIC_LABELS,
} from './benchmarks-intel';

// ---------------------------------------------------------------------------
// Quartile → Badge tone (1 best … 4 worst; null = unrankable cohort).
// ---------------------------------------------------------------------------

const QUARTILE_TONE: Record<1 | 2 | 3 | 4, BadgeTone> = {
  1: 'green',
  2: 'blue',
  3: 'amber',
  4: 'red',
};

interface Props {
  /** Switch to the Property tab focused on this property (lifted selection in IntelModule). */
  onOpenProperty: (propertyId: string) => void;
}

export function BenchmarksView({ onOpenProperty }: Props) {
  const metrics = useMetrics();
  const noi = useNoiMatrix();

  const unavailable = isWarehouseUnavailable(metrics.error) || isWarehouseUnavailable(noi.error);

  // The full-year periods present in metrics, latest first → the default selection is the
  // latest FY (never a partial 2026-YTD).
  const periods = useMemo(() => availableFyPeriods(metrics.data ?? []), [metrics.data]);

  const [metric, setMetric] = useState<NumericMetricKey>('noiPerSf');
  const [period, setPeriod] = useState<string | null>(null);
  // Effective period: the picked one if still present, else the latest FY. Resolving this in
  // render (not state) keeps the default in sync as metrics load, without an effect.
  const effectivePeriod = period && periods.includes(period) ? period : (periods[0] ?? null);

  const benchmarks = useBenchmarks(effectivePeriod, metric);

  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const row of metrics.data ?? []) m.set(row.propertyId, row.propertyName ?? row.propertyId);
    return m;
  }, [metrics.data]);

  const loading = metrics.isLoading || noi.isLoading;
  if (loading) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton style={{ height: 64 }} />
        <Skeleton style={{ height: 96 }} />
        <Skeleton style={{ height: 280 }} />
      </div>
    );
  }

  if (unavailable) {
    return (
      <Card>
        <CardHeader title="Benchmarks" trailing={<Badge tone="neutral">offline</Badge>} />
        <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
          <Database size={28} style={{ color: 'var(--text-tertiary)' }} />
          <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            Benchmarks require the live brain server.
          </div>
          <div className="text-2xs" style={{ color: 'var(--text-tertiary)', maxWidth: 420 }}>
            The financial warehouse runs locally alongside the brain server. This deployed mirror is read-only.
          </div>
        </div>
      </Card>
    );
  }

  if (periods.length === 0) {
    return (
      <Card>
        <CardHeader title="Benchmarks" />
        <div className="px-4 py-12 text-center text-sm" style={{ color: 'var(--text-secondary)' }}>
          No full-year financials ingested yet — see the Imports tab to approve a committed import.
        </div>
      </Card>
    );
  }

  const fmt = metricFormatter(metric);
  const rankings = benchmarks.data?.rankings ?? [];
  const summary = benchmarks.data?.byMetric ?? null;
  // Quartiles need a cohort of peers; a singleton (or empty) cohort cannot quartile.
  const singletonCohort = (summary?.n ?? rankings.length) < 2;

  return (
    <div className="flex flex-col gap-4">
      <Selectors
        periods={periods}
        period={effectivePeriod}
        onPeriod={setPeriod}
        metric={metric}
        onMetric={setMetric}
      />

      <SummaryStrip metric={metric} period={effectivePeriod} summary={summary} loading={benchmarks.isLoading} />

      <RankingsCard
        rankings={rankings}
        nameById={nameById}
        fmt={fmt}
        metric={metric}
        singletonCohort={singletonCohort}
        loading={benchmarks.isLoading}
        onOpenProperty={onOpenProperty}
      />

      <NoiMatrixCard matrix={noi.data ?? []} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Selectors — period (full-year only, latest first) + metric (the 12 enum keys).
// ---------------------------------------------------------------------------

function Selectors({
  periods,
  period,
  onPeriod,
  metric,
  onMetric,
}: {
  periods: string[];
  period: string | null;
  onPeriod: (p: string) => void;
  metric: NumericMetricKey;
  onMetric: (m: NumericMetricKey) => void;
}) {
  return (
    <Card>
      <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:gap-6">
        <label className="flex items-center gap-2">
          <span className="num text-2xs font-semibold uppercase" style={{ letterSpacing: '0.1em', color: 'var(--text-tertiary)' }}>
            Period
          </span>
          <select
            value={period ?? ''}
            onChange={(e) => onPeriod(e.target.value)}
            className="num rounded-md px-2.5 py-1 text-xs"
            style={{ background: 'var(--surface-raised)', color: 'var(--text-primary)', border: '1px solid var(--border-strong)' }}
          >
            {periods.map((p) => (
              <option key={p} value={p}>
                FY{p}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          <span className="num text-2xs font-semibold uppercase" style={{ letterSpacing: '0.1em', color: 'var(--text-tertiary)' }}>
            Metric
          </span>
          <select
            value={metric}
            onChange={(e) => onMetric(e.target.value as NumericMetricKey)}
            className="rounded-md px-2.5 py-1 text-xs"
            style={{ background: 'var(--surface-raised)', color: 'var(--text-primary)', border: '1px solid var(--border-strong)' }}
          >
            {METRIC_KEYS.map((k) => (
              <option key={k} value={k}>
                {METRIC_LABELS[k]}
              </option>
            ))}
          </select>
        </label>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Summary strip — cohort avg / median / p25 / p75 / n for the (period, metric).
// ---------------------------------------------------------------------------

function SummaryStrip({
  metric,
  period,
  summary,
  loading,
}: {
  metric: NumericMetricKey;
  period: string | null;
  summary: { avg: number | null; median: number | null; p25: number | null; p75: number | null; n: number } | null;
  loading: boolean;
}) {
  const fmt = metricFormatter(metric);
  const items: Array<{ label: string; value: string }> = [
    { label: 'Average', value: fmt(summary?.avg ?? null) },
    { label: 'Median', value: fmt(summary?.median ?? null) },
    { label: 'P25', value: fmt(summary?.p25 ?? null) },
    { label: 'P75', value: fmt(summary?.p75 ?? null) },
    { label: 'Properties (n)', value: summary ? fmtNum(summary.n) : '—' },
  ];
  return (
    <Card>
      <CardHeader
        title={`${METRIC_LABELS[metric]} · FY${period ?? '—'}`}
        trailing={<Badge tone="gold">portfolio cohort</Badge>}
      />
      {loading ? (
        <div className="p-4">
          <Skeleton style={{ height: 48 }} />
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-x-6 gap-y-3 px-4 py-3 sm:grid-cols-3 md:grid-cols-5">
          {items.map((it) => (
            <div key={it.label}>
              <div className="num text-2xs font-semibold uppercase" style={{ letterSpacing: '0.1em', color: 'var(--text-tertiary)' }}>
                {it.label}
              </div>
              <div className="num mt-1 text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
                {it.value}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Rankings — a sortable table (rank, property, value, quartile) + a BarList visual.
// ---------------------------------------------------------------------------

interface RankRow extends PropertyRank {
  propertyName: string;
}

function RankingsCard({
  rankings,
  nameById,
  fmt,
  metric,
  singletonCohort,
  loading,
  onOpenProperty,
}: {
  rankings: PropertyRank[];
  nameById: Map<string, string>;
  fmt: (n: number | null) => string;
  metric: NumericMetricKey;
  singletonCohort: boolean;
  loading: boolean;
  onOpenProperty: (id: string) => void;
}) {
  const rows: RankRow[] = useMemo(
    () => rankings.map((r) => ({ ...r, propertyName: nameById.get(r.propertyId) ?? r.propertyId })),
    [rankings, nameById],
  );

  const barItems: BarListItem[] = useMemo(
    () =>
      rows.map((r) => ({
        label: r.propertyName,
        // BarList sizes bars by a non-negative magnitude; rank values can be negative (a
        // loss-making property), so use the absolute value for the bar width.
        value: Math.abs(r.value),
        display: fmt(r.value),
        href: () => onOpenProperty(r.propertyId),
      })),
    [rows, fmt, onOpenProperty],
  );

  const columns: Column<RankRow>[] = [
    {
      key: 'rank',
      header: 'Rank',
      align: 'right',
      width: '64px',
      sortValue: (r) => r.rank,
      render: (r) => <span style={{ color: 'var(--text-secondary)' }}>{r.rank}</span>,
    },
    {
      key: 'property',
      header: 'Property',
      align: 'left',
      sortValue: (r) => r.propertyName,
      render: (r) => <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{r.propertyName}</span>,
    },
    {
      key: 'value',
      header: METRIC_LABELS[metric],
      align: 'right',
      sortValue: (r) => r.value,
      render: (r) => <span style={{ color: 'var(--text-primary)' }}>{fmt(r.value)}</span>,
    },
    {
      key: 'quartile',
      header: 'Quartile',
      align: 'left',
      sortValue: (r) => r.quartile ?? null,
      render: (r) => <QuartileBadge quartile={r.quartile} />,
    },
  ];

  return (
    <Card>
      <CardHeader
        title="Rankings"
        trailing={
          // Gate the singleton-cohort note on `!loading`: during a metric-change refetch the
          // previous (healthy) cohort's data is still mounted, so deriving "insufficient
          // peers" mid-flight made the badge flash on a perfectly good cohort. Only flag it
          // once the refetch settles AND the cohort is genuinely singleton/empty.
          !loading && singletonCohort ? (
            <Badge tone="neutral">insufficient peers for quartiles</Badge>
          ) : (
            <Badge tone="gold">{rows.length} properties</Badge>
          )
        }
      />
      {loading ? (
        <div className="p-4">
          <Skeleton style={{ height: 220 }} />
        </div>
      ) : rows.length === 0 ? (
        <div className="px-4 py-10 text-center text-sm" style={{ color: 'var(--text-tertiary)' }}>
          No ranked properties for this period and metric.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 p-0 lg:grid-cols-[1fr_360px]">
          <DataTable
            columns={columns}
            rows={rows}
            getRowId={(r) => r.propertyId}
            initialSort={{ key: 'rank', dir: 'asc' }}
            onRowClick={(r) => onOpenProperty(r.propertyId)}
            minWidth={480}
          />
          <div className="border-t p-4 lg:border-l lg:border-t-0" style={{ borderColor: 'var(--border-subtle)' }}>
            <div className="num mb-2 text-2xs font-semibold uppercase" style={{ letterSpacing: '0.08em', color: 'var(--text-tertiary)' }}>
              {METRIC_LABELS[metric]} by property
            </div>
            <BarList items={barItems} />
          </div>
        </div>
      )}
    </Card>
  );
}

function QuartileBadge({ quartile }: { quartile: Quartile }) {
  if (quartile === null) return <Badge tone="neutral">n/a</Badge>;
  return <Badge tone={QUARTILE_TONE[quartile]}>Q{quartile}</Badge>;
}

// ---------------------------------------------------------------------------
// NOI-by-property matrix — periods as columns (YTD tagged), em-dash for a missing period.
// Moved here from the old 'overview' tab so all periods sit in one place.
// ---------------------------------------------------------------------------

function NoiMatrixCard({ matrix }: { matrix: NoiMatrixCell[] }) {
  const { periods, rows } = useMemo(() => groupNoiByProperty(matrix), [matrix]);
  // Tag a YTD column: the NOI matrix carries period strings only (no grain hint), so a
  // 4-digit year is a full year and anything else (e.g. '2026-YTD' / '2026-06') is partial.
  const isYtd = (p: string) => !/^\d{4}$/.test(p);

  return (
    <Card>
      <CardHeader title="NOI by Property" trailing={<Badge tone="gold">{rows.length} properties</Badge>} />
      {rows.length === 0 ? (
        <div className="px-4 py-10 text-center text-sm" style={{ color: 'var(--text-tertiary)' }}>
          No committed financials yet. Run the warehouse backfill or approve a pending import.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse" style={{ minWidth: 480 }}>
            <thead>
              <tr>
                <th className="px-3 py-2 text-left text-2xs font-semibold uppercase" style={{ letterSpacing: '0.08em', color: 'var(--text-tertiary)', borderBottom: '1px solid var(--border-strong)' }}>
                  Property
                </th>
                {periods.map((p) => (
                  <th
                    key={p}
                    className="num px-3 py-2 text-right text-2xs font-semibold uppercase"
                    style={{ letterSpacing: '0.08em', color: 'var(--text-tertiary)', borderBottom: '1px solid var(--border-strong)' }}
                  >
                    {isYtd(p) ? `${p} YTD` : `FY${p}`}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.propertyId} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                  <td className="px-3 py-2 text-sm" style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
                    {r.propertyName}
                  </td>
                  {periods.map((p) => {
                    const v = r.byPeriod[p];
                    return (
                      <td
                        key={p}
                        className="num px-3 py-2 text-right text-xs"
                        style={{ color: v === undefined ? 'var(--text-tertiary)' : 'var(--text-primary)' }}
                      >
                        {v === undefined ? '—' : fmtUsd(v)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
