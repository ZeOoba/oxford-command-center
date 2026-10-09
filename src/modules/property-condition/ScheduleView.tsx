// src/modules/property-condition/ScheduleView.tsx
//
// "What is aging out?" Two tables on DIFFERENT evidence bases, kept visibly separate:
//   1. Install & warranty facts (register Asset_Facts — dates read from documents, warranty end year only
//      when the document states it).
//   2. Consultant lifecycle lines from each property's CURRENT report (estimate basis). The due year is
//      derived = report year + integer RUL; a range RUL ("1-2") shows as printed rather than guessed.
import { Card, CardHeader } from '@/primitives/Card';
import { Badge } from '@/primitives/Badge';
import { DataTable, type Column } from '@/primitives/DataTable';
import { fmtUsd } from '@analytics/index';
import type { PcaLifecycleRow, PcaScheduleRow } from '@contracts/property-condition';
import { fmtPartialDate, warrantyBadge } from './hooks';

const muted = { color: 'var(--text-tertiary)' } as const;

const SCHEDULE_COLS: Column<PcaScheduleRow>[] = [
  {
    key: 'property',
    header: 'Property / component',
    render: (r) => (
      <div>
        <div style={{ fontWeight: 600, fontSize: '0.75rem', color: 'var(--text-primary)' }}>{r.propertyLabel}</div>
        <div className="text-2xs" style={muted}>{r.component}</div>
      </div>
    ),
    sortValue: (r) => r.propertyLabel,
  },
  {
    key: 'installed',
    header: 'Installed',
    align: 'right',
    render: (r) => (
      <div>
        <div className="num text-xs">{r.installYear ?? '—'}</div>
        <div className="num text-2xs" style={muted}>{r.ageYears === null ? '' : `${r.ageYears} yrs old`}</div>
      </div>
    ),
    sortValue: (r) => r.installYear,
  },
  {
    key: 'warranty',
    header: 'Warranty',
    render: (r) => {
      const b = warrantyBadge(r.warrantyStatus);
      return (
        <div>
          <Badge tone={b.tone}>{b.label}</Badge>
          {r.warranty && <div className="text-2xs" style={muted}>{r.warranty}</div>}
        </div>
      );
    },
    sortValue: (r) => r.warrantyEndYear,
  },
  {
    key: 'flag',
    header: 'Flag',
    render: (r) => <span className="text-2xs" style={muted}>{r.flag ?? ''}</span>,
  },
];

const LIFECYCLE_COLS: Column<PcaLifecycleRow>[] = [
  {
    key: 'property',
    header: 'Property / system',
    render: (r) => (
      <div>
        <div style={{ fontWeight: 600, fontSize: '0.75rem', color: 'var(--text-primary)' }}>{r.propertyLabel}</div>
        <div className="text-2xs" style={muted}>{r.system}</div>
      </div>
    ),
    sortValue: (r) => r.propertyLabel,
  },
  {
    key: 'due',
    header: 'Due',
    align: 'right',
    render: (r) => (
      <div>
        <div className="num text-xs">{r.dueYear ?? (r.rulRaw ? `RUL ${r.rulRaw}` : '—')}</div>
        <div className="num text-2xs" style={muted}>{r.timing ?? ''}</div>
      </div>
    ),
    sortValue: (r) => r.dueYear,
  },
  {
    key: 'life',
    header: 'EUL / age',
    align: 'right',
    render: (r) => (
      <span className="num text-xs">
        {r.eul ?? '—'} / {r.age ?? '—'}
      </span>
    ),
    sortValue: (r) => r.eul,
  },
  {
    key: 'total',
    header: 'Estimate',
    align: 'right',
    render: (r) => <span className="num text-xs">{fmtUsd(r.totalUsd)}</span>,
    sortValue: (r) => r.totalUsd,
  },
  {
    key: 'report',
    header: 'Report',
    align: 'right',
    render: (r) => <span className="num text-2xs" style={muted}>{fmtPartialDate(r.reportDate)}</span>,
    sortValue: (r) => r.reportDate,
  },
];

export function ScheduleView({ schedule, lifecycle }: { schedule: PcaScheduleRow[]; lifecycle: PcaLifecycleRow[] }) {
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader title="Install & warranty facts" trailing={<Badge tone="neutral">{schedule.length} components</Badge>} />
        {schedule.length === 0 ? (
          <div className="px-4 py-6 text-sm" style={{ color: 'var(--text-secondary)' }}>No install facts loaded.</div>
        ) : (
          <DataTable columns={SCHEDULE_COLS} rows={schedule} getRowId={(r) => `${r.propertyKey}|${r.component}`} minWidth={640} />
        )}
      </Card>
      <Card>
        <CardHeader title="Consultant lifecycle (current reports)" trailing={<Badge tone="amber">Estimate basis</Badge>} />
        {lifecycle.length === 0 ? (
          <div className="px-4 py-6 text-sm" style={{ color: 'var(--text-secondary)' }}>No component lines loaded.</div>
        ) : (
          <DataTable
            columns={LIFECYCLE_COLS}
            rows={lifecycle}
            getRowId={(r) => `${r.reportId}|${r.system}|${r.timing ?? ''}|${r.totalUsd ?? ''}`}
            initialSort={{ key: 'due', dir: 'asc' }}
            minWidth={640}
            maxHeight={520}
          />
        )}
      </Card>
      <p className="num px-1 text-2xs" style={muted}>
        Warranty end years appear only where the source document states them — none are derived from install
        year. Lifecycle due year = report year + integer RUL; a range RUL is shown as printed, not guessed.
        Lifecycle lines are consultant estimates for each property's most recent report only.
      </p>
    </div>
  );
}
