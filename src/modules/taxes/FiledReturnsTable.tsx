// src/modules/taxes/FiledReturnsTable.tsx
//
// Phase 6 / P4c — Taxes module Filed Returns tab (Task 10).
//
// C2 confidentiality boundary (src/contracts/tax-strategy.ts header, rule 1): filed returns are
// METADATA-ONLY, PERMANENTLY. Return CONTENTS never enter this system — not in placeholder form
// now, not when real accountant records replace the placeholder fixture (Task 11's real-data
// swap). This table renders exactly the metadata FiledReturnMeta carries (tax year, entity,
// preparer, status, storage note) and nothing else; there is deliberately no column — and no
// field on the contract — for return contents.
//
// RESOLVED data-flow: TaxesModule calls useTaxStrategy() itself and passes the resolved
// TaxStrategyReport down as the `report` prop — this component calls no hook of its own (mirrors
// StrategyBoard's existing opportunities-as-prop pattern exactly).
import { Card, CardHeader } from '@/primitives/Card';
import { Badge, type BadgeTone } from '@/primitives/Badge';
import { DataTable, type Column } from '@/primitives/DataTable';
import { PlaceholderBanner } from '@/primitives/PlaceholderBanner';
import { placeholderDetailTax } from './hooks';
import type { TaxStrategyReport, FiledReturnMeta } from './hooks';

const STATUS_TONE: Record<FiledReturnMeta['status'], BadgeTone> = {
  filed: 'green',
  extended: 'amber',
  amended: 'blue',
};

const BOUNDARY_SENTENCE =
  'Return contents never enter this system — metadata and SharePoint link-out only, by ' +
  'confidentiality design (cut-list C2).';

const COLUMNS: Column<FiledReturnMeta>[] = [
  {
    key: 'taxYear',
    header: 'Tax Year',
    align: 'right',
    render: (r) => <span className="num">{r.taxYear}</span>,
    sortValue: (r) => r.taxYear,
  },
  {
    key: 'entity',
    header: 'Entity',
    render: (r) => r.entity,
    sortValue: (r) => r.entity,
  },
  {
    key: 'preparer',
    header: 'Preparer',
    render: (r) => r.preparer ?? <span style={{ color: 'var(--text-tertiary)' }}>—</span>,
    sortValue: (r) => r.preparer ?? '',
  },
  {
    key: 'status',
    header: 'Status',
    render: (r) => <Badge tone={STATUS_TONE[r.status]}>{r.status}</Badge>,
    sortValue: (r) => r.status,
  },
  {
    key: 'storageNote',
    header: 'Storage',
    render: (r) => r.storageNote,
  },
];

export function FiledReturnsTable({ report }: { report: TaxStrategyReport }) {
  return (
    <div className="flex flex-col gap-4">
      <PlaceholderBanner label="PLACEHOLDER METADATA" detail={placeholderDetailTax(report)} />
      <Card>
        <CardHeader
          title="Filed Returns"
          trailing={<Badge tone="neutral">{report.filedReturns.length} returns</Badge>}
        />
        <DataTable
          columns={COLUMNS}
          rows={report.filedReturns}
          getRowId={(r) => r.id}
          initialSort={{ key: 'taxYear', dir: 'desc' }}
        />
      </Card>
      <div className="px-1 text-2xs leading-relaxed" style={{ color: 'var(--text-tertiary)' }}>
        {BOUNDARY_SENTENCE}
      </div>
    </div>
  );
}
