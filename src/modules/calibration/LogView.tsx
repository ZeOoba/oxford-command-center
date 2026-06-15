// src/modules/calibration/LogView.tsx
//
// The verdict log: every logged calibration verdict, LEFT-JOINed to its blessed outcome. Filterable
// by verdict kind and open|resolved. Renders an explicit empty state on a no-verdict warehouse.
import { Card, CardHeader } from '@/primitives/Card';
import { Badge } from '@/primitives/Badge';
import { DataTable, type Column } from '@/primitives/DataTable';
import type { CalibrationLogRow } from './hooks';
import { fmtHit, hitTone, kindTone } from './format';

export function LogView({ rows }: { rows: CalibrationLogRow[] }) {
  const cols: Column<CalibrationLogRow>[] = [
    { key: 'subjectId', header: 'Subject', render: (r) => <span className="num text-2xs" style={{ color: 'var(--text-secondary)' }}>{r.subjectId}</span>, sortValue: (r) => r.subjectId },
    { key: 'verdictKind', header: 'Kind', render: (r) => <Badge tone={kindTone(r.verdictKind)}>{r.verdictKind}{r.verdictSubkind ? `/${r.verdictSubkind}` : ''}</Badge>, sortValue: (r) => r.verdictKind },
    { key: 'predictedBand', header: 'Predicted', render: (r) => r.predictedBand ?? (r.predictedValue !== null ? r.predictedValue.toFixed(0) : '—'), sortValue: (r) => r.predictedBand ?? '' },
    { key: 'asOfPeriod', header: 'As-of', align: 'right', render: (r) => <span className="num">{r.asOfPeriod}</span>, sortValue: (r) => r.asOfPeriod },
    { key: 'horizonPeriods', header: 'Horizon', align: 'right', render: (r) => <span className="num">{r.horizonPeriods === null ? '—' : `${r.horizonPeriods}y`}</span>, sortValue: (r) => r.horizonPeriods ?? -1 },
    { key: 'status', header: 'Status', render: (r) => <Badge tone={r.resolved ? hitTone(r.hit, true) : 'neutral'}>{r.resolved ? fmtHit(r.hit) : 'open'}</Badge>, sortValue: (r) => (r.resolved ? 1 : 0) },
    { key: 'outcomePeriod', header: 'Outcome', align: 'right', render: (r) => <span className="num">{r.outcomePeriod ?? '—'}</span>, sortValue: (r) => r.outcomePeriod ?? '' },
    { key: 'emittedBy', header: 'Source', render: (r) => <span className="num text-2xs" style={{ color: 'var(--text-tertiary)' }}>{r.emittedBy}</span>, sortValue: (r) => r.emittedBy },
  ];

  return (
    <Card>
      <CardHeader title="Verdict Log" trailing={<Badge tone="neutral">{rows.length} verdict{rows.length === 1 ? '' : 's'}</Badge>} />
      {rows.length === 0 ? (
        <div className="px-4 py-10 text-center text-sm" style={{ color: 'var(--text-tertiary)' }}>
          No verdicts logged yet. Verdicts are recorded on every committed import and on the quarterly snapshot.
        </div>
      ) : (
        <DataTable rows={rows} columns={cols} initialSort={{ key: 'asOfPeriod', dir: 'desc' }} getRowId={(r) => String(r.id)} />
      )}
    </Card>
  );
}
