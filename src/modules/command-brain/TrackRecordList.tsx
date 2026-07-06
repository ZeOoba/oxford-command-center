// src/modules/command-brain/TrackRecordList.tsx
//
// The Track Record: report.trackRecord entries (contract already caps ~20, newest first — see
// brain-report.ts's own comment). Rendered via DataTable — subject, kind, predicted vs realized, and
// an outcome Badge with EXACTLY 3 tones (hit/miss/not-scoreable — no 4th "partial" state; see
// TrackRecordOutcome's contract comment). Empty state mirrors CalibrationModule/ReportView's
// honest-empty-state tone: no resolved verdicts is the NORMAL state until outcomes accrue.
import { Card, CardHeader } from '@/primitives/Card';
import { Badge } from '@/primitives/Badge';
import { DataTable, type Column } from '@/primitives/DataTable';
import { outcomeLabel, outcomeTone, fmtBandOrValue } from './hooks';
import type { TrackRecordEntry } from '@contracts/brain-report';

export function TrackRecordList({ entries }: { entries: TrackRecordEntry[] }) {
  const cols: Column<TrackRecordEntry>[] = [
    {
      key: 'subject',
      header: 'Subject',
      render: (r) => <span className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>{r.subject}</span>,
      sortValue: (r) => r.subject,
    },
    {
      key: 'kind',
      header: 'Kind',
      render: (r) => <Badge tone="neutral">{r.kind}</Badge>,
      sortValue: (r) => r.kind,
    },
    {
      key: 'predicted',
      header: 'Predicted',
      render: (r) => (
        <span className="num text-2xs" style={{ color: 'var(--text-secondary)' }}>
          {fmtBandOrValue(r.predictedBand, r.predictedValue)}
        </span>
      ),
      sortValue: (r) => r.predictedBand ?? '',
    },
    {
      key: 'realized',
      header: 'Realized',
      render: (r) => (
        <span className="num text-2xs" style={{ color: 'var(--text-secondary)' }}>
          {fmtBandOrValue(r.realizedBand, r.realizedValue)}
        </span>
      ),
      sortValue: (r) => r.realizedBand ?? '',
    },
    {
      key: 'outcome',
      header: 'Outcome',
      render: (r) => <Badge tone={outcomeTone(r.outcome)}>{outcomeLabel(r.outcome)}</Badge>,
      sortValue: (r) => r.outcome,
    },
    {
      key: 'resolvedAt',
      header: 'Resolved',
      align: 'right',
      render: (r) => <span className="num text-2xs" style={{ color: 'var(--text-tertiary)' }}>{r.resolvedAt ?? '—'}</span>,
      sortValue: (r) => r.resolvedAt ?? '',
    },
  ];

  return (
    <Card>
      <CardHeader
        title="Track Record"
        trailing={<Badge tone="neutral">{`${entries.length} verdict${entries.length === 1 ? '' : 's'}`}</Badge>}
      />
      {entries.length === 0 ? (
        <div className="px-4 py-10 text-center text-sm" style={{ color: 'var(--text-tertiary)' }}>
          No resolved verdicts yet — first outcomes accumulate as acquisitions/allocations/appeals resolve
        </div>
      ) : (
        <DataTable rows={entries} columns={cols} getRowId={(r) => r.verdictId} />
      )}
    </Card>
  );
}
