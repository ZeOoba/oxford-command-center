// src/modules/property-condition/CapexOutlookView.tsx
//
// "What do I owe the buildings, and when?" One row per property, built from that property's CURRENT report
// (the most recent we have — no age cutoff). Age and usability are caveat badges; older reports are
// counted, not summed. Reserves are uninflated, over each report's own term (10–12 yrs), so the $/SF/yr
// column is the comparable figure across properties.
import { Card, CardHeader } from '@/primitives/Card';
import { Badge } from '@/primitives/Badge';
import { DataTable, type Column } from '@/primitives/DataTable';
import { fmtUsd, fmtSf } from '@analytics/index';
import type { PcaPropertySummary } from '@contracts/property-condition';
import { ageLabel, ageTone, fmtPartialDate, fmtPsf, truncate, usabilityBadge } from './hooks';

const muted = { color: 'var(--text-tertiary)' } as const;

const COLUMNS: Column<PcaPropertySummary>[] = [
  {
    key: 'property',
    header: 'Property',
    render: (p) => (
      <div>
        <div style={{ fontWeight: 600, fontSize: '0.75rem', color: 'var(--text-primary)' }}>{p.propertyLabel}</div>
        <div className="num text-2xs" style={muted}>
          {p.current.consultant ?? 'Consultant n/a'} · {fmtPartialDate(p.current.reportDate)}
          {p.propertyMasterId === null ? ' · not in property master' : ''}
        </div>
        {p.current.notes && (
          <div className="text-2xs" style={muted} title={p.current.notes}>
            {truncate(p.current.notes, 96)}
          </div>
        )}
      </div>
    ),
    sortValue: (p) => p.propertyLabel,
  },
  {
    key: 'report',
    header: 'Report',
    render: (p) => {
      const u = usabilityBadge(p.current.usabilityClass);
      return (
        <div className="flex flex-wrap items-center gap-1">
          <Badge tone={u.tone}>{u.label}</Badge>
          <Badge tone={ageTone(p.ageYears)}>{ageLabel(p.ageYears)}</Badge>
        </div>
      );
    },
    sortValue: (p) => p.ageYears ?? -1,
  },
  {
    key: 'sf',
    header: 'SF',
    align: 'right',
    render: (p) => <span className="num text-xs">{p.current.sf === null ? '—' : fmtSf(p.current.sf)}</span>,
    sortValue: (p) => p.current.sf,
  },
  {
    key: 'immediate',
    header: 'Immediate',
    align: 'right',
    render: (p) => <span className="num text-xs">{fmtUsd(p.current.immediateUsd)}</span>,
    sortValue: (p) => p.current.immediateUsd,
  },
  {
    key: 'shortTerm',
    header: 'Yr 1–2',
    align: 'right',
    render: (p) => <span className="num text-xs">{fmtUsd(p.current.shortTermUsd)}</span>,
    sortValue: (p) => p.current.shortTermUsd,
  },
  {
    key: 'reserves',
    header: 'Reserves',
    align: 'right',
    render: (p) => (
      <div>
        <div className="num text-xs">{fmtUsd(p.current.reservesUninflUsd)}</div>
        <div className="num text-2xs" style={muted}>
          {p.current.termYears === null ? 'term n/a' : `${p.current.termYears}-yr term`}
        </div>
      </div>
    ),
    sortValue: (p) => p.current.reservesUninflUsd,
  },
  {
    key: 'psfYr',
    header: '$/SF/yr',
    align: 'right',
    render: (p) => (
      <span
        className="num text-xs"
        title={p.current.psfYrStated === null ? undefined : `Stated in report: ${fmtPsf(p.current.psfYrStated)}`}
      >
        {fmtPsf(p.reservesPsfYr)}
      </span>
    ),
    sortValue: (p) => p.reservesPsfYr,
  },
  {
    key: 'history',
    header: 'Older',
    align: 'right',
    render: (p) => (
      <span className="num text-2xs" style={muted}>
        {p.history.length === 0 ? '—' : `${p.history.length} report${p.history.length === 1 ? '' : 's'}`}
      </span>
    ),
    sortValue: (p) => p.history.length,
  },
];

export function CapexOutlookView({ properties }: { properties: PcaPropertySummary[] }) {
  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardHeader title="Capex outlook by property" trailing={<Badge tone="neutral">{properties.length} properties</Badge>} />
        <DataTable
          columns={COLUMNS}
          rows={properties}
          getRowId={(p) => p.propertyKey}
          initialSort={{ key: 'immediate', dir: 'desc' }}
          minWidth={820}
        />
      </Card>
      <p className="num px-1 text-2xs" style={muted}>
        Each row is the most recent report we have for that property — an older report is still used when it is
        the newest available, and its age and usability show as badges rather than excluding it. Reserves are
        uninflated and span each report's own term; $/SF/yr = reserves ÷ SF ÷ term (the comparable figure). Older
        reports are counted, never summed. Narrative-only reports carry no dollar figures. These are capex
        reserve estimates, not NOI.
      </p>
    </div>
  );
}
