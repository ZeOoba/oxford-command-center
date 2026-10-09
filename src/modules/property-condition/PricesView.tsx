// src/modules/property-condition/PricesView.tsx
//
// "What do contractors actually charge?" Two evidence bases, shown in two separate cards and NEVER blended:
//   1. Contractor quotes & awards (capex_quotes) — one row each; $/SF is a per-row derivation (SF-basis rows
//      only). There is no median or average: every scope is n=1, so an aggregate would be false precision.
//   2. Consultant ESTIMATE unit costs (the PCA price book, 2007–2026) — a reference basis, not a price.
import { Card, CardHeader } from '@/primitives/Card';
import { Badge } from '@/primitives/Badge';
import { DataTable, type Column } from '@/primitives/DataTable';
import { fmtUsd } from '@analytics/index';
import type { PcaPriceBookRow, PcaQuoteRow } from '@contracts/property-condition';
import { evidenceBadge, fmtPartialDate, fmtPsf, truncate } from './hooks';

const muted = { color: 'var(--text-tertiary)' } as const;

const QUOTE_COLS: Column<PcaQuoteRow>[] = [
  {
    key: 'record',
    header: 'Record',
    render: (q) => (
      <div>
        <div style={{ fontWeight: 600, fontSize: '0.75rem', color: 'var(--text-primary)' }} title={q.title}>
          {truncate(q.title, 64)}
        </div>
        <div className="num text-2xs" style={muted}>
          {q.vendor ?? 'vendor n/a'} · {q.trade ?? '—'} · {fmtPartialDate(q.docDate)}
        </div>
      </div>
    ),
    sortValue: (q) => q.propertyLabel,
  },
  {
    key: 'class',
    header: 'Evidence',
    render: (q) => {
      const b = evidenceBadge(q.evidenceClass);
      return (
        <div className="flex flex-wrap items-center gap-1">
          <Badge tone={b.tone}>{b.label}</Badge>
          {!q.verified && <Badge tone="neutral">Unverified</Badge>}
        </div>
      );
    },
    sortValue: (q) => q.evidenceClass,
  },
  {
    key: 'total',
    header: 'Total',
    align: 'right',
    render: (q) => (
      <div>
        <div className="num text-xs">{fmtUsd(q.actualUsd ?? q.quotedUsd)}</div>
        <div className="num text-2xs" style={muted}>{q.actualUsd !== null ? 'actual' : 'quoted'}</div>
      </div>
    ),
    sortValue: (q) => q.actualUsd ?? q.quotedUsd,
  },
  {
    key: 'psf',
    header: '$/SF',
    align: 'right',
    render: (q) => (
      <div>
        <div className="num text-xs">{fmtPsf(q.unitPriceUsdPsf)}</div>
        <div className="num text-2xs" style={muted}>{q.qty === null ? '' : `${q.qty.toLocaleString('en-US')} ${q.uom ?? ''}`}</div>
      </div>
    ),
    sortValue: (q) => q.unitPriceUsdPsf,
  },
  {
    key: 'meta',
    header: 'Funding / recovery',
    render: (q) => (
      <span className="text-2xs" style={muted}>
        {q.fundingClass ?? '—'} · {q.leaseRecovery ?? '—'}
      </span>
    ),
  },
];

const PRICE_BOOK_COLS: Column<PcaPriceBookRow>[] = [
  {
    key: 'system',
    header: 'System',
    render: (p) => <span style={{ fontWeight: 600, fontSize: '0.75rem', color: 'var(--text-primary)' }}>{p.system}</span>,
    sortValue: (p) => p.system,
  },
  {
    key: 'unit',
    header: 'Unit cost',
    align: 'right',
    render: (p) => (
      <span className="num text-xs">
        {fmtPsf(p.unitCost)} / {p.uom ?? '—'}
      </span>
    ),
    sortValue: (p) => p.unitCost,
  },
  {
    key: 'year',
    header: 'Report year',
    align: 'right',
    render: (p) => <span className="num text-xs">{p.reportYear ?? '—'}</span>,
    sortValue: (p) => p.reportYear,
  },
  {
    key: 'property',
    header: 'Property',
    render: (p) => <span className="text-2xs" style={muted}>{p.propertyLabel}</span>,
    sortValue: (p) => p.propertyLabel,
  },
];

export function PricesView({ quotes, priceBook }: { quotes: PcaQuoteRow[]; priceBook: PcaPriceBookRow[] }) {
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader title="Contractor quotes & awards" trailing={<Badge tone="neutral">{quotes.length} records</Badge>} />
        {quotes.length === 0 ? (
          <div className="px-4 py-6 text-sm" style={{ color: 'var(--text-secondary)' }}>No quotes loaded.</div>
        ) : (
          <DataTable columns={QUOTE_COLS} rows={quotes} getRowId={(q) => q.quoteKey} minWidth={720} />
        )}
      </Card>
      <Card>
        <CardHeader title="Consultant unit-cost price book" trailing={<Badge tone="amber">Estimate basis — not contractor prices</Badge>} />
        {priceBook.length === 0 ? (
          <div className="px-4 py-6 text-sm" style={{ color: 'var(--text-secondary)' }}>No component unit costs loaded.</div>
        ) : (
          <DataTable
            columns={PRICE_BOOK_COLS}
            rows={priceBook}
            getRowId={(p) => `${p.reportId}|${p.system}|${p.unitCost}`}
            initialSort={{ key: 'system', dir: 'asc' }}
            minWidth={560}
            maxHeight={420}
          />
        )}
      </Card>
      <p className="num px-1 text-2xs" style={muted}>
        Contractor evidence is one record per scope (n=1), so no median or average is shown — a single bid is a
        data point, not a benchmark. Budget-type records and superseded bids are labeled and should not be read
        as executed prices. The price book is consultant estimates from 2007–2026 reports and must not be
        blended with the contractor table above. Funding class and lease recovery are unreviewed human tags.
      </p>
    </div>
  );
}
