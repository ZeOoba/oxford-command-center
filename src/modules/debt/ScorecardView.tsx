// src/modules/debt/ScorecardView.tsx
//
// Phase 2 Step 6 — Per-property debt score table.
// Displays DSCR, debt yield, LTV, signal, and score band for every scored property.
// Consumes useDebtScores() — degrades to an informational empty state when unavailable.
import { Skeleton } from '@/primitives/Skeleton';
import { Card, CardHeader } from '@/primitives/Card';
import { Badge } from '@/primitives/Badge';
import { DataTable, type Column } from '@/primitives/DataTable';
import { fmtPct } from '@analytics/index';
import { isWarehouseUnavailable } from '../intel/hooks';
import { useDebtScores, signalTone, signalLabel, bandTone } from './hooks';
import type { DebtScore } from './hooks';

function fmtDscr(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  return `${n.toFixed(2)}×`;
}

function fmtDebtYield(n: number | null): string {
  return fmtPct(n, 1);
}

const COLS: Column<DebtScore>[] = [
  {
    key: 'property',
    header: 'Property',
    render: (row) => (
      <div className="num text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
        {row.propertyName}
      </div>
    ),
    sortValue: (row) => row.propertyName,
  },
  {
    key: 'score',
    header: 'Score',
    align: 'right',
    render: (row) => (
      <div className="flex items-center justify-end gap-1.5">
        <span className="num text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
          {row.score.toFixed(0)}
        </span>
        <Badge tone={bandTone(row.scoreBand)}>{row.scoreBand}</Badge>
      </div>
    ),
    sortValue: (row) => row.score,
  },
  {
    key: 'signal',
    header: 'Signal',
    render: (row) => <Badge tone={signalTone(row.signal)}>{signalLabel(row.signal)}</Badge>,
    sortValue: (row) => row.signal,
  },
  {
    key: 'dscr',
    header: 'DSCR',
    align: 'right',
    render: (row) => (
      <span className="num text-xs" style={{ color: row.dscr !== null && row.dscr < 1.25 ? 'var(--text-neg)' : 'var(--text-primary)' }}>
        {fmtDscr(row.dscr)}
      </span>
    ),
    sortValue: (row) => row.dscr ?? -1,
  },
  {
    key: 'dscrHeadroom',
    header: 'DSCR Room',
    align: 'right',
    render: (row) => (
      <span className="num text-xs" style={{ color: row.dscrHeadroom !== null && row.dscrHeadroom < 0 ? 'var(--text-neg)' : 'var(--text-tertiary)' }}>
        {row.dscrHeadroom !== null ? fmtDscr(row.dscrHeadroom) : '—'}
      </span>
    ),
    sortValue: (row) => row.dscrHeadroom ?? -999,
  },
  {
    key: 'debtYield',
    header: 'Debt Yield',
    align: 'right',
    render: (row) => <span className="num text-xs">{fmtDebtYield(row.debtYield)}</span>,
    sortValue: (row) => row.debtYield ?? -1,
  },
  {
    key: 'noiBasis',
    header: 'NOI Period',
    render: (row) => <span className="num text-2xs" style={{ color: 'var(--text-tertiary)' }}>{row.noiBasis}</span>,
    sortValue: (row) => row.noiBasis,
  },
];

export function ScorecardView() {
  const { data, isLoading, error } = useDebtScores();

  if (isLoading) return <Skeleton style={{ height: 280 }} />;

  if (isWarehouseUnavailable(error)) {
    return (
      <Card>
        <CardHeader title="Debt Scorecard" trailing={<Badge tone="neutral">offline</Badge>} />
        <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
          <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            Debt scoring requires the live brain server.
          </div>
          <div className="text-2xs" style={{ color: 'var(--text-tertiary)', maxWidth: 420 }}>
            Scores are computed from the warehouse ledger + Spine A loan snapshot. This deployed
            mirror does not include the live warehouse.
          </div>
        </div>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardHeader title="Debt Scorecard" trailing={<Badge tone="red">error</Badge>} />
        <div className="px-4 py-6 text-sm" style={{ color: 'var(--text-neg)' }}>
          {error instanceof Error ? error.message : 'Failed to load debt scores.'}
        </div>
      </Card>
    );
  }

  const scores = data ?? [];

  const criticalCount = scores.filter((s) => s.scoreBand === 'critical').length;
  const watchCount = scores.filter((s) => s.scoreBand === 'watch').length;

  return (
    <Card>
      <CardHeader
        title="Debt Scorecard"
        trailing={
          <div className="flex items-center gap-1.5">
            {criticalCount > 0 && <Badge tone="red">{criticalCount} critical</Badge>}
            {watchCount > 0 && <Badge tone="amber">{watchCount} watch</Badge>}
            <Badge tone="neutral">{scores.length} properties</Badge>
          </div>
        }
      />
      {scores.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
          <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>No scored debt positions.</div>
          <div className="text-2xs" style={{ color: 'var(--text-tertiary)', maxWidth: 400 }}>
            Run a debt snapshot (POST /api/warehouse/debt/snapshot) after the master workbook is
            refreshed to populate the scoring engine.
          </div>
        </div>
      ) : (
        <DataTable
          columns={COLS}
          rows={scores}
          getRowId={(s) => s.propertyId}
          initialSort={{ key: 'score', dir: 'asc' }}
          minWidth={720}
        />
      )}
    </Card>
  );
}
