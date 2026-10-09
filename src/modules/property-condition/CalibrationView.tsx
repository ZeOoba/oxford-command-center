// src/modules/property-condition/CalibrationView.tsx
//
// "Can I trust the PCA numbers?" Curated estimate-vs-executed pairs on the SAME scope. The delta is
// contractor ÷ estimate − 1, computed from dollars when both exist, else $/SF. A positive delta means the
// estimate understated what contractors charge (the risk direction for a reserve); negative means it
// overstated. n is tiny, so this is directional evidence only — never a correction factor.
import { Card, CardHeader } from '@/primitives/Card';
import { Badge } from '@/primitives/Badge';
import { DataTable, type Column } from '@/primitives/DataTable';
import { fmtUsd } from '@analytics/index';
import type { PcaCalibrationRow } from '@contracts/property-condition';
import { fmtDeltaPct, fmtPsf } from './hooks';

/** '$7.00/SF · PCI 2016' — only the parts that exist, so an absent price never renders '—/SF'. */
function priceLine(psf: number | null, source: string | null): string {
  return [psf === null ? null : `${fmtPsf(psf)}/SF`, source].filter(Boolean).join(' · ');
}

const muted = { color: 'var(--text-tertiary)' } as const;

/** Bar length caps at ±200% so a 3× miss doesn't flatten every other row. */
function DeltaBar({ delta }: { delta: number | null }) {
  if (delta === null) return <span className="num text-xs" style={muted}>—</span>;
  const width = Math.min(Math.abs(delta), 2) / 2 * 100;
  const over = delta > 0; // contractor above estimate → estimate understated
  return (
    <div className="flex items-center justify-end gap-2" style={{ minWidth: 150 }}>
      <div style={{ flex: 1, height: 6, borderRadius: 3, background: 'var(--border-subtle)', overflow: 'hidden' }}>
        <div
          style={{
            width: `${width}%`,
            height: '100%',
            background: over ? 'var(--color-warn)' : 'var(--color-info)',
            marginLeft: over ? 0 : 'auto',
          }}
        />
      </div>
      <span className="num text-xs" style={{ minWidth: 44, textAlign: 'right', color: over ? 'var(--text-warn)' : 'var(--text-info)' }}>
        {fmtDeltaPct(delta)}
      </span>
    </div>
  );
}

const COLUMNS: Column<PcaCalibrationRow>[] = [
  {
    key: 'scope',
    header: 'Property / scope',
    render: (r) => (
      <div>
        <div style={{ fontWeight: 600, fontSize: '0.75rem', color: 'var(--text-primary)' }}>{r.propertyLabel}</div>
        <div className="text-2xs" style={muted}>{r.scope}</div>
      </div>
    ),
    sortValue: (r) => r.propertyLabel,
  },
  {
    key: 'estimate',
    header: 'Estimate',
    align: 'right',
    render: (r) => (
      <div>
        <div className="num text-xs">{fmtUsd(r.estimateUsd)}</div>
        <div className="num text-2xs" style={muted}>{priceLine(r.estimatePsf, r.estimateSource)}</div>
      </div>
    ),
    sortValue: (r) => r.estimatePsf,
  },
  {
    key: 'contractor',
    header: 'Contractor',
    align: 'right',
    render: (r) => (
      <div>
        <div className="num text-xs">{fmtUsd(r.contractorUsd)}</div>
        <div className="num text-2xs" style={muted}>{priceLine(r.contractorPsf, r.contractorSource)}</div>
      </div>
    ),
    sortValue: (r) => r.contractorPsf,
  },
  {
    key: 'delta',
    header: 'Contractor vs estimate',
    align: 'right',
    render: (r) => <DeltaBar delta={r.deltaPct} />,
    sortValue: (r) => r.deltaPct,
  },
  {
    key: 'comment',
    header: 'Note',
    render: (r) => <span className="text-2xs" style={muted}>{r.comment ?? ''}</span>,
  },
];

export function CalibrationView({ rows }: { rows: PcaCalibrationRow[] }) {
  const withDelta = rows.filter((r) => r.deltaPct !== null).length;
  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardHeader
          title="PCA estimate vs executed price"
          trailing={<Badge tone="amber">n={withDelta} · directional only</Badge>}
        />
        {rows.length === 0 ? (
          <div className="px-4 py-6 text-sm" style={{ color: 'var(--text-secondary)' }}>No calibration pairs loaded.</div>
        ) : (
          <DataTable columns={COLUMNS} rows={rows} getRowId={(r) => `${r.propertyKey}|${r.scope}`} minWidth={760} />
        )}
      </Card>
      <p className="num px-1 text-2xs" style={muted}>
        Delta = contractor ÷ estimate − 1 (dollars when both are known, otherwise $/SF). Amber = the estimate
        ran below what contractors charge — the direction that understates a reserve. Pairs are matched by
        hand to the same scope; scope changes (e.g. TPO → EPDM, reused insulation) explain part of the
        spread. With this few observations it is evidence for scrutiny, not a correction factor.
      </p>
    </div>
  );
}
