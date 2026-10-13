// src/modules/property-condition/CapexOutlookView.tsx
//
// "What do I owe the buildings, and when?" One row per property, built from that property's CURRENT report
// (the most recent we have). Reports dated before 2024 stay in the table, badged STALE, but are history only: they
// are excluded from the KPI totals, the near-term rollup and reserve intensity. Older reports are counted, not summed. Reserves are uninflated, over each report's own term (10–12 yrs), so the $/SF/yr
// column is the comparable figure across properties.
//
// This is also the PCA Register: status (CURRENT / DRAFT / STALE), consultant + date, SF, Immediate,
// Short-term, reserves (uninflated + inflated), term and $/SF/yr — with data-quality flags beside the
// numbers they qualify. Below the table: the near-term rollup (concentration) and reserve intensity.
import { Card, CardHeader } from '@/primitives/Card';
import { Badge } from '@/primitives/Badge';
import { DataTable, type Column } from '@/primitives/DataTable';
import { fmtUsd, fmtSf } from '@analytics/index';
import type { AdjustedProperty, NearTermRollup, PcaStatus } from '@/analytics/pca-intelligence';
import { ageLabel, ageTone, fmtPartialDate, fmtPsf, truncate, usabilityBadge } from './hooks';

const muted = { color: 'var(--text-tertiary)' } as const;

const STATUS_TONE: Record<PcaStatus, 'green' | 'amber' | 'neutral'> = { CURRENT: 'green', DRAFT: 'amber', STALE: 'neutral' };

function FlagList({ flags }: { flags: string[] }) {
  if (flags.length === 0) return null;
  return (
    <ul className="text-2xs" style={{ color: 'var(--text-warn)', marginTop: 2 }}>
      {flags.map((f) => (
        <li key={f}>⚑ {f}</li>
      ))}
    </ul>
  );
}

/** $/SF/yr with its origin: derived values are tagged, n/a is never imputed. */
function PsfCell({ p }: { p: AdjustedProperty }) {
  if (p.psf.origin === 'n/a') {
    return (
      <span
        className="num text-xs"
        style={muted}
        title={p.psf.stated === null ? undefined : `Report prints ${fmtPsf(p.psf.stated)} but no uninflated reserve / SF / term to reproduce it`}
      >
        n/a
      </span>
    );
  }
  return (
    <span className="num text-xs" title={p.psf.stated === null ? undefined : `Stated in report: ${fmtPsf(p.psf.stated)}`}>
      {fmtPsf(p.psf.value)}
      {p.psf.origin === 'derived' && <span className="text-2xs" style={muted}> derived</span>}
    </span>
  );
}

const COLUMNS: Column<AdjustedProperty>[] = [
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
        <FlagList flags={p.flags} />
      </div>
    ),
    sortValue: (p) => p.propertyLabel,
  },
  {
    key: 'report',
    header: 'Status',
    render: (p) => {
      const u = usabilityBadge(p.current.usabilityClass);
      return (
        <div className="flex flex-wrap items-center gap-1">
          <Badge tone={STATUS_TONE[p.status]}>{p.status}</Badge>
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
    render: (p) => <span className="num text-xs">{p.current.sf === null ? 'n/a' : fmtSf(p.current.sf)}</span>,
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
        <div className="num text-xs">{p.current.reservesUninflUsd === null ? 'n/a' : fmtUsd(p.current.reservesUninflUsd)}</div>
        <div className="num text-2xs" style={muted}>
          infl {p.current.reservesInflUsd === null ? 'n/a' : fmtUsd(p.current.reservesInflUsd)} ·{' '}
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
    render: (p) => <PsfCell p={p} />,
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

function NearTermRollupCard({ rollup }: { rollup: NearTermRollup }) {
  const top = rollup.rows[0];
  return (
    <Card>
      <CardHeader
        title="Near-term capex rollup"
        trailing={<Badge tone="neutral">Immediate + Short-term · {fmtUsd(rollup.totalUsd)}</Badge>}
      />
      {top && (
        <div className="px-4 pb-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
          <strong style={{ color: 'var(--text-primary)' }}>{top.propertyLabel}</strong> is{' '}
          <span className="num">{(rollup.topShare * 100).toFixed(0)}%</span> of the near-term total — concentration risk.
        </div>
      )}
      <ul>
        {rollup.rows.map((r) => (
          <li
            key={r.propertyKey}
            className="flex items-center gap-3 px-4 py-2"
            style={{ borderTop: '1px solid var(--border-subtle)', fontSize: 13 }}
          >
            <div style={{ width: 210, flexShrink: 0, color: 'var(--text-primary)', fontWeight: 600 }}>
              {r.propertyLabel}
              {r.status === 'DRAFT' && <span className="text-2xs" style={muted}> · DRAFT</span>}
            </div>
            <div style={{ flex: 1, height: 6, borderRadius: 3, background: 'var(--border-subtle)', overflow: 'hidden' }}>
              <div style={{ width: `${r.share * 100}%`, height: '100%', background: 'var(--color-warn)' }} />
            </div>
            <div className="num text-xs" style={{ width: 90, textAlign: 'right' }}>{fmtUsd(r.totalUsd)}</div>
            <div className="num text-2xs" style={{ width: 44, textAlign: 'right', ...muted }}>{(r.share * 100).toFixed(1)}%</div>
          </li>
        ))}
        <li
          className="flex items-center gap-3 px-4 py-2"
          style={{ borderTop: '1px solid var(--border-subtle)', fontSize: 13, fontWeight: 600 }}
        >
          <div style={{ flex: 1 }}>Total</div>
          <div className="num text-xs">{fmtUsd(rollup.totalUsd)}</div>
        </li>
      </ul>
      <p className="num px-4 py-2 text-2xs" style={muted}>
        PCA consultant estimates. Excludes {rollup.excludedStale} STALE report{rollup.excludedStale === 1 ? '' : 's'} (pre-2024:
        install-date history only); the KPI strip above applies the same exclusion.
      </p>
    </Card>
  );
}

function ReserveIntensityCard({ properties }: { properties: AdjustedProperty[] }) {
  const stale = properties.filter((p) => p.status === 'STALE');
  const live = properties.filter((p) => p.status !== 'STALE');
  const ranked = live
    .filter((p) => p.psf.value !== null)
    .sort((a, b) => (b.psf.value ?? 0) - (a.psf.value ?? 0));
  const unavailable = live.filter((p) => p.psf.value === null);
  const max = Math.max(...ranked.map((p) => p.psf.value ?? 0), 0.01);
  return (
    <Card>
      <CardHeader title="Reserve intensity ($/SF/yr, uninflated)" trailing={<Badge tone="neutral">reserves ÷ SF ÷ term</Badge>} />
      <ul>
        {ranked.map((p) => (
          <li key={p.propertyKey} className="px-4 py-2" style={{ borderTop: '1px solid var(--border-subtle)', fontSize: 13 }}>
            <div className="flex items-center gap-3">
              <div style={{ width: 210, flexShrink: 0, color: 'var(--text-primary)', fontWeight: 600 }}>{p.propertyLabel}</div>
              <div style={{ flex: 1, height: 6, borderRadius: 3, background: 'var(--border-subtle)', overflow: 'hidden' }}>
                <div style={{ width: `${((p.psf.value ?? 0) / max) * 100}%`, height: '100%', background: 'var(--color-info)' }} />
              </div>
              <div className="num text-xs" style={{ width: 120, textAlign: 'right' }}>
                {fmtPsf(p.psf.value)}
                {p.psf.origin === 'derived' && <span className="text-2xs" style={muted}> derived</span>}
              </div>
              {p.flags.length > 0 && <Badge tone="amber">data-quality flag</Badge>}
            </div>
            <FlagList flags={p.flags} />
          </li>
        ))}
        {unavailable.map((p) => (
          <li key={p.propertyKey} className="px-4 py-2" style={{ borderTop: '1px solid var(--border-subtle)', fontSize: 13 }}>
            <div className="flex items-center gap-3">
              <div style={{ width: 210, flexShrink: 0, color: 'var(--text-primary)', fontWeight: 600 }}>{p.propertyLabel}</div>
              <div className="num text-xs" style={{ flex: 1, ...muted }}>n/a — not imputed</div>
              {p.flags.length > 0 && <Badge tone="amber">data-quality flag</Badge>}
            </div>
            <FlagList flags={p.flags} />
          </li>
        ))}
      </ul>
      <p className="num px-4 py-2 text-2xs" style={muted}>
        Consultant estimates on each report's own term — comparable across properties only with the flags in view.
        Roof lines are the least reliable (see Estimate vs actual).
        {stale.length > 0 ? ` ${stale.length} stale (pre-2024) report${stale.length === 1 ? '' : 's'} left out — history only; see Building specs.` : ''}
      </p>
    </Card>
  );
}

export function CapexOutlookView({ properties, rollup }: { properties: AdjustedProperty[]; rollup: NearTermRollup }) {
  // Current + draft first (largest near-term exposure first), STALE history after — stale dollars never lead the table.
  const ordered = [...properties].sort(
    (a, b) =>
      Number(a.status === 'STALE') - Number(b.status === 'STALE') ||
      (b.current.immediateUsd ?? 0) + (b.current.shortTermUsd ?? 0) - ((a.current.immediateUsd ?? 0) + (a.current.shortTermUsd ?? 0)),
  );
  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardHeader title="Capex outlook by property" trailing={<Badge tone="neutral">{properties.length} properties</Badge>} />
        <DataTable
          columns={COLUMNS}
          rows={ordered}
          getRowId={(p) => p.propertyKey}
          minWidth={900}
        />
      </Card>
      <NearTermRollupCard rollup={rollup} />
      <ReserveIntensityCard properties={properties} />
      <p className="num px-1 text-2xs" style={muted}>
        Each row is the most recent report we have for that property. A pre-2024 report still appears (badged STALE)
        but is history only — it is left out of the KPI totals, the rollup and reserve intensity. Reserves are
        uninflated and span each report's own term; $/SF/yr = reserves ÷ SF ÷ term, computed here and tagged
        "derived" unless the report's printed figure reconciles. Where no uninflated reserve exists the figure is
        n/a, never imputed. Older reports are counted, never summed. Narrative-only reports carry no dollar
        figures. These are capex reserve estimates, not NOI.
      </p>
    </div>
  );
}
