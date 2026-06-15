// src/modules/intel/ManagersView.tsx
//
// PM scorecards (PFI Phase B.2). One row per property manager: property count, avg NOI/SF,
// avg NOI growth, avg expense growth, and a "small sample" flag. Ordered by avg NOI growth
// descending (best first; null-growth managers sink to the bottom — sortScorecards).
//
// This is the canon small-n surface: the firm has few managers across few properties, so a
// header note states the rankings are "directional, not definitive" and any manager whose
// scorecard rests on too few properties carries an amber "small sample" Badge. Growth cells
// are signed + colored (positive green, negative red); every null renders an em-dash, never
// `.toFixed(null)` (pre-mortem #2). On an unavailable warehouse the offline Card shows; no
// raw hex — theme tokens only.
import { useMemo } from 'react';
import { Database } from 'lucide-react';
import { fmtPct, fmtUsd } from '@analytics/index';
import { Card, CardHeader } from '@/primitives/Card';
import { Badge } from '@/primitives/Badge';
import { Skeleton } from '@/primitives/Skeleton';
import { DataTable, type Column } from '@/primitives/DataTable';
import { isWarehouseUnavailable } from './hooks';
import { usePmScorecards, type PmScorecard } from './analytics-hooks';
import { sortScorecards } from './managers-intel';
import { ExportBriefingButton } from './ExportBriefingButton';
import { managerSlug } from '@contracts/briefing';

/**
 * Displays property manager scorecards with performance metrics in a sortable table.
 *
 * The table shows manager names, property counts, average NOI per square foot, NOI growth, and expense growth, sorted by NOI growth (best first). Handles loading, unavailable warehouse, and empty data states with appropriate messaging.
 */
export function ManagersView() {
  const pm = usePmScorecards();

  const unavailable = isWarehouseUnavailable(pm.error);

  const rows = useMemo(() => sortScorecards(pm.data ?? []), [pm.data]);

  if (pm.isLoading) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton style={{ height: 56 }} />
        <Skeleton style={{ height: 240 }} />
      </div>
    );
  }

  if (unavailable) {
    return (
      <Card>
        <CardHeader title="Property Managers" trailing={<Badge tone="neutral">offline</Badge>} />
        <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
          <Database size={28} style={{ color: 'var(--text-tertiary)' }} />
          <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            PM scorecards require the live brain server.
          </div>
          <div className="text-2xs" style={{ color: 'var(--text-tertiary)', maxWidth: 420 }}>
            The financial warehouse runs locally alongside the brain server. This deployed mirror is read-only.
          </div>
        </div>
      </Card>
    );
  }

  if (rows.length === 0) {
    return (
      <Card>
        <CardHeader title="Property Managers" />
        <div className="px-4 py-12 text-center text-sm" style={{ color: 'var(--text-secondary)' }}>
          No manager scorecards yet — managers derive from committed financials with a mapped PM.
        </div>
      </Card>
    );
  }

  const columns: Column<PmScorecard>[] = [
    {
      key: 'manager',
      header: 'Manager',
      align: 'left',
      sortValue: (r) => r.propertyManager,
      render: (r) => (
        <span className="flex items-center gap-2">
          <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{r.propertyManager}</span>
          {r.smallSample && <Badge tone="amber">small sample</Badge>}
        </span>
      ),
    },
    {
      key: 'count',
      header: 'Properties',
      align: 'right',
      sortValue: (r) => r.propertyCount,
      render: (r) => <span style={{ color: 'var(--text-secondary)' }}>{r.propertyCount}</span>,
    },
    {
      key: 'noiPerSf',
      header: 'Avg NOI / SF',
      align: 'right',
      sortValue: (r) => r.avgNoiPerSf ?? null,
      render: (r) => (
        <span style={{ color: r.avgNoiPerSf === null ? 'var(--text-tertiary)' : 'var(--text-primary)' }}>
          {r.avgNoiPerSf === null ? '—' : fmtUsd(r.avgNoiPerSf, true)}
        </span>
      ),
    },
    {
      key: 'noiGrowth',
      header: 'Avg NOI Growth',
      align: 'right',
      sortValue: (r) => r.avgNoiGrowth ?? null,
      render: (r) => <SignedPct value={r.avgNoiGrowth} />,
    },
    {
      key: 'expenseGrowth',
      header: 'Avg Expense Growth',
      align: 'right',
      // Expense growth: rising expenses are the unfavorable direction, but the sort is by
      // raw value (the cell color carries the favorable/unfavorable read).
      sortValue: (r) => r.avgExpenseGrowth ?? null,
      render: (r) => <SignedPct value={r.avgExpenseGrowth} invert />,
    },
    {
      key: 'export',
      header: '',
      align: 'right',
      render: (r) => <ExportBriefingButton kind="manager" id={managerSlug(r.propertyManager)} label="PDF" />,
    },
  ];

  return (
    <Card>
      <CardHeader
        title="Property Manager Scorecards"
        trailing={<Badge tone="neutral">by avg NOI growth · best first</Badge>}
      />
      <div className="px-4 pt-2 text-2xs" style={{ color: 'var(--text-tertiary)' }}>
        Few managers across few properties — directional, not definitive.
      </div>
      <DataTable
        columns={columns}
        rows={rows}
        getRowId={(r) => r.propertyManager}
        initialSort={{ key: 'noiGrowth', dir: 'desc' }}
        minWidth={680}
      />
    </Card>
  );
}

/** Signed percentage with +/- color. `invert` flags a metric where rising is unfavorable
 *  (expense growth) — positive renders red, negative green. Null → an em-dash. */
function SignedPct({ value, invert = false }: { value: number | null; invert?: boolean }) {
  if (value === null || !Number.isFinite(value)) {
    return <span style={{ color: 'var(--text-tertiary)' }}>—</span>;
  }
  const favorable = invert ? value <= 0 : value >= 0;
  const text = value >= 0 ? `+${fmtPct(value)}` : fmtPct(value);
  return <span style={{ color: favorable ? 'var(--color-pos)' : 'var(--color-neg)' }}>{text}</span>;
}
