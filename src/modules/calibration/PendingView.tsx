// src/modules/calibration/PendingView.tsx
//
// The pending-resolution queue (§3.2): verdicts whose evaluation horizon is DUE (a strictly-later
// same-grain period exists) but which carry no blessed outcome yet — the analyst-review surface.
// Each row offers "Resolve", which opens the confirm-before-write ResolveDialog. Empty [] is the
// NORMAL state until a horizon elapses — shown as an explicit, non-alarming empty state.
import { Card, CardHeader } from '@/primitives/Card';
import { Badge } from '@/primitives/Badge';
import { Button } from '@/primitives/Button';
import { DataTable, type Column } from '@/primitives/DataTable';
import type { CalibrationLogRow } from './hooks';
import { kindTone } from './format';

export function PendingView({ rows, onResolve }: { rows: CalibrationLogRow[]; onResolve: (row: CalibrationLogRow) => void }) {
  const cols: Column<CalibrationLogRow>[] = [
    { key: 'subjectId', header: 'Subject', render: (r) => <span className="num text-2xs" style={{ color: 'var(--text-secondary)' }}>{r.subjectId}</span>, sortValue: (r) => r.subjectId },
    { key: 'verdictKind', header: 'Kind', render: (r) => <Badge tone={kindTone(r.verdictKind)}>{r.verdictKind}{r.verdictSubkind ? `/${r.verdictSubkind}` : ''}</Badge>, sortValue: (r) => r.verdictKind },
    { key: 'predictedBand', header: 'Predicted', render: (r) => r.predictedBand ?? (r.predictedValue !== null ? r.predictedValue.toFixed(0) : '—'), sortValue: (r) => r.predictedBand ?? '' },
    { key: 'asOfPeriod', header: 'As-of', align: 'right', render: (r) => <span className="num">{r.asOfPeriod}</span>, sortValue: (r) => r.asOfPeriod },
    { key: 'horizonPeriods', header: 'Horizon', align: 'right', render: (r) => <span className="num">{r.horizonPeriods === null ? '—' : `${r.horizonPeriods}y`}</span>, sortValue: (r) => r.horizonPeriods ?? -1 },
    {
      key: 'resolve', header: '', align: 'right',
      render: (r) => (
        <Button size="sm" variant="subtle" onPress={() => onResolve(r)} aria-label={`Resolve verdict ${r.id}`}>Resolve</Button>
      ),
    },
  ];

  return (
    <Card>
      <CardHeader
        title="Pending Resolution"
        trailing={<Badge tone={rows.length === 0 ? 'green' : 'amber'}>{rows.length} due</Badge>}
      />
      {rows.length === 0 ? (
        <div className="px-4 py-10 text-center text-sm" style={{ color: 'var(--text-tertiary)' }}>
          Nothing due for resolution. A verdict appears here once a later same-grain period covers its evaluation horizon.
        </div>
      ) : (
        <DataTable rows={rows} columns={cols} initialSort={{ key: 'asOfPeriod', dir: 'asc' }} getRowId={(r) => String(r.id)} />
      )}
    </Card>
  );
}
