// src/modules/debt/ScorecardView.tsx
//
// Phase 2 Step 6 — Per-property debt score table.
// Displays DSCR, debt yield, LTV, signal, and score band for every scored property.
// Consumes useDebtScores() — degrades to an informational empty state when unavailable.
import { useMemo } from 'react';
import { Skeleton } from '@/primitives/Skeleton';
import { Card, CardHeader } from '@/primitives/Card';
import { Badge } from '@/primitives/Badge';
import { DataTable, type Column } from '@/primitives/DataTable';
import { fmtPct } from '@analytics/index';
import { GOVERNOR_FALLBACK } from '@contracts/index';
import { useSnapshot } from '@/data/queries';
import { noiBasisLabel } from '@/lib/spine-label';
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

// I10 refute fix: the DSCR cell used to color at a hardcoded 1.25 — after a DB-only
// re-ratification it would color a property "healthy" that the payload-governed alert engine
// already flags as breaching. Built per-render from the live governors (see ScorecardView).
function buildColumns(dscrFloor: number): Column<DebtScore>[] {
  return [
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
      <span className="num text-xs" style={{ color: row.dscr !== null && row.dscr < dscrFloor ? 'var(--text-neg)' : 'var(--text-primary)' }}>
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
    render: (row) => <span className="num text-2xs" style={{ color: 'var(--text-tertiary)' }}>{noiBasisLabel(row.noiBasis)}</span>,
    sortValue: (row) => row.noiBasis,
  },
  ];
}

export function ScorecardView() {
  const { data, isLoading, error } = useDebtScores();
  const { data: snapshotResponse } = useSnapshot();
  const dscrFloor = (snapshotResponse?.snapshot.governors ?? GOVERNOR_FALLBACK).dscrFloor;
  const columns = useMemo(() => buildColumns(dscrFloor), [dscrFloor]);

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
            Scores are computed from the warehouse ledger + workbook loan snapshot. This deployed
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

  const scores = data?.scores ?? [];
  // Round 19d: trust comes from the ENVELOPE, so it survives an empty score list — the
  // total-destruction case, which is exactly when the operator most needs to be told.
  const bookTrust = data?.bookTrust ?? 'trusted';

  const criticalCount = scores.filter((s) => s.scoreBand === 'critical').length;
  const watchCount = scores.filter((s) => s.scoreBand === 'watch').length;

  // Round 19d: read trust from the envelope, so it survives `scores.length === 0`. 19b derived it
  // with scores.find(...), which could say nothing in exactly the worst case — a write that
  // destroyed every row — and the empty state then told the operator to "run a debt snapshot" as
  // if the book were merely unpopulated.
  const distrusted = bookTrust !== 'trusted';
  const trustHeadline =
    bookTrust === 'degraded'
      ? 'Debt book DEGRADED — rows were lost by the last snapshot write.'
      : bookTrust === 'refused'
        ? 'Debt book STALE — the last snapshot write was refused.'
        : 'Debt book NOT LOADED — no debt snapshot has been written.';
  const trustDetail =
    bookTrust === 'degraded'
      ? 'Per-property DSCR/LTV are withheld: computed from the surviving rows they would be wrong in either direction. Nothing below is a governor verdict.'
      : bookTrust === 'refused'
        ? 'Figures below are the last trusted book and may be out of date; clearance-direction actions are withheld.'
        : 'No properties are confirmed unlevered — their debt is simply unknown until a snapshot lands.';

  return (
    <Card>
      <CardHeader
        title="Debt Scorecard"
        trailing={
          <div className="flex items-center gap-1.5">
            {distrusted && (
              <Badge tone={bookTrust === 'unknown' ? 'amber' : 'red'}>
                {bookTrust === 'unknown' ? 'book not loaded' : 'book not trusted'}
              </Badge>
            )}
            {criticalCount > 0 && <Badge tone="red">{criticalCount} critical</Badge>}
            {watchCount > 0 && <Badge tone="amber">{watchCount} watch</Badge>}
            <Badge tone="neutral">{scores.length} properties</Badge>
          </div>
        }
      />
      {distrusted && (
        <div
          className="px-4 py-3 text-2xs"
          style={{ color: 'var(--text-neg)', borderBottom: '1px solid var(--border-subtle)' }}
        >
          <strong>{trustHeadline}</strong> {trustDetail}
        </div>
      )}
      {scores.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
          <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            {bookTrust === 'degraded'
              ? 'No scored debt positions — the book was DESTROYED, not merely unpopulated.'
              : 'No scored debt positions.'}
          </div>
          <div className="text-2xs" style={{ color: 'var(--text-tertiary)', maxWidth: 400 }}>
            {bookTrust === 'degraded'
              ? 'The last snapshot write lost every active row. Resolve the debt-snapshot marker before trusting any debt figure on this dashboard.'
              : 'Run a debt snapshot (POST /api/warehouse/debt/snapshot) after the master workbook is refreshed to populate the scoring engine.'}
          </div>
        </div>
      ) : (
        <DataTable
          columns={columns}
          rows={scores}
          getRowId={(s) => s.propertyId}
          initialSort={{ key: 'score', dir: 'asc' }}
          minWidth={720}
        />
      )}
    </Card>
  );
}
