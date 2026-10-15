// src/modules/property-condition/InfoLaneView.tsx
//
// 29000 Information Ln (Easton Tech Commons) drill-down: report facts, the uninflated reserve schedule by
// year, the system breakdown and the conflicts list. Year 1 / Year 2 are RESERVE outlays — never shown as
// Immediate / Short-term (the register once did; see the correction note).
import { Card, CardHeader } from '@/primitives/Card';
import { Badge } from '@/primitives/Badge';
import { fmtUsd } from '@analytics/index';
import { INFO_LANE_DETAIL as D } from './pca-overlay';
import { fmtPsf } from './hooks';

const muted = { color: 'var(--text-tertiary)' } as const;
const YEAR_ORDER = ['yr1', 'yr2', 'yr6', 'yr7', 'yr10', 'yr11'] as const;
const YEAR_MAX = Math.max(...YEAR_ORDER.map((k) => D.reserveScheduleUninfl[k]));

export function InfoLaneView({ rentRollMonths }: { rentRollMonths: number | null }) {
  const scheduleTotal = YEAR_ORDER.reduce((a, k) => a + D.reserveScheduleUninfl[k], 0);
  const systemTotal = D.systems.reduce((a, s) => a + s.usd, 0);
  const rr = D.rentRoll;
  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardHeader title={D.label} trailing={<Badge tone="amber">{D.provenance.status}</Badge>} />
        <div className="px-4 pb-2 text-2xs" style={{ color: 'var(--text-warn)' }}>{D.correctionNote}</div>
        <dl className="grid gap-x-4 gap-y-1 px-4 pb-3 text-xs" style={{ gridTemplateColumns: 'max-content 1fr' }}>
          {D.facts.map((f) => (
            <div key={f.label} style={{ display: 'contents' }}>
              <dt style={muted}>{f.label}</dt>
              <dd style={{ color: 'var(--text-secondary)' }}>{f.value}</dd>
            </div>
          ))}
        </dl>
        <div className="grid grid-cols-2 gap-3 px-4 pb-3 md:grid-cols-4">
          <Stat label="Immediate (ADA)" value={fmtUsd(D.immediateUsd)} sub={D.immediateItems.map((i) => `${i.item} ${fmtUsd(i.usd)}`).join(' · ')} />
          <Stat label="Short-term" value={fmtUsd(D.shortTermUsd)} sub="Intertek: none" />
          <Stat label="Reserves (uninflated)" value={fmtUsd(D.reservesUninflUsd)} sub={`inflated ${fmtUsd(D.reservesInflUsd)} · ${D.termYears} yrs`} />
          <Stat label="$/SF/yr" value={fmtPsf(D.reservesUninflUsd / D.sf / D.termYears)} sub={`reserves ÷ ${D.sf.toLocaleString('en-US')} SF ÷ ${D.termYears} · matches the PCR's printed $0.23`} />
        </div>
      </Card>

      <Card>
        <CardHeader title="Reserve schedule by year (uninflated)" trailing={<Badge tone="neutral">estimate basis</Badge>} />
        <ul>
          {YEAR_ORDER.map((k) => (
            <li key={k} className="flex items-center gap-3 px-4 py-1.5 text-xs" style={{ borderTop: '1px solid var(--border-subtle)' }}>
              <span className="num" style={{ width: 60, ...muted }}>Year {k.slice(2)}</span>
              <div style={{ flex: 1, height: 6, borderRadius: 3, background: 'var(--border-subtle)', overflow: 'hidden' }}>
                <div style={{ width: `${(D.reserveScheduleUninfl[k] / YEAR_MAX) * 100}%`, height: '100%', background: 'var(--color-info)' }} />
              </div>
              <span className="num" style={{ width: 80, textAlign: 'right' }}>{fmtUsd(D.reserveScheduleUninfl[k])}</span>
            </li>
          ))}
          <li className="flex px-4 py-1.5 text-xs" style={{ borderTop: '1px solid var(--border-subtle)', fontWeight: 600 }}>
            <span style={{ flex: 1 }}>Total (ties to reserves)</span>
            <span className="num">{fmtUsd(scheduleTotal)}</span>
          </li>
        </ul>
      </Card>

      <Card>
        <CardHeader title="System breakdown" trailing={<Badge tone="neutral">{fmtUsd(systemTotal)}</Badge>} />
        <ul>
          {D.systems.map((s) => (
            <li key={s.system} className="flex px-4 py-1.5 text-xs" style={{ borderTop: '1px solid var(--border-subtle)' }}>
              <span style={{ flex: 1 }}>{s.system}</span>
              <span className="num">{fmtUsd(s.usd)}</span>
              <span className="num" style={{ width: 52, textAlign: 'right', ...muted }}>{((s.usd / systemTotal) * 100).toFixed(0)}%</span>
            </li>
          ))}
        </ul>
        <div className="num px-4 py-2 text-2xs" style={muted}>
          Intertek unit costs (PCA estimate basis, not contractor prices):{' '}
          {D.unitCosts.map((u) => `${u.item} $${u.usd.toFixed(2)}/${u.uom}`).join(' · ')}
        </div>
      </Card>

      <Card>
        <CardHeader title="Conflicts and open questions" trailing={<Badge tone="amber">{D.conflicts.length}</Badge>} />
        <ul>
          {D.conflicts.map((c) => (
            <li key={c.text} className="px-4 py-1.5 text-xs" style={{ borderTop: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}>
              {c.speculative && <strong>[SPECULATIVE] </strong>}
              {c.text}
            </li>
          ))}
        </ul>
      </Card>

      <Card>
        <CardHeader title={`Rent roll ${rr.asOf}`} trailing={<Badge tone="amber">STALE{rentRollMonths === null ? '' : ` · ${rentRollMonths} mo`}</Badge>} />
        <div className="num px-4 pb-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
          {rr.leases} leases · {fmtUsd(rr.baseRentUsd)} base (${rr.baseRentPsf.toFixed(2)}/SF) · WALT {rr.waltYears} yrs · {rr.nnnLeases} NNN / {rr.grossLeases} gross
        </div>
        <div className="num px-4 pb-3 text-2xs" style={muted}>
          Rollover SF by lease-end year:{' '}
          {Object.entries(rr.rolloverSfByLeaseEndYear).map(([y, sf]) => `${y}: ${sf.toLocaleString('en-US')}`).join(' · ')}
          . Units 105 and 106 since re-let; 7 leases (10,500 SF) ended by 2026-10-08 — pull a current roll.
        </div>
      </Card>
      <p className="num px-1 text-2xs" style={muted}>
        Source: {D.provenance.sourceFile} · {D.provenance.sourceDate} · basis {D.provenance.priceBasis} · {D.provenance.status}.
        The Intertek DRAFT is the only 2025 report on hand; the final PCR is outstanding.
      </p>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div>
      <div className="text-2xs" style={muted}>{label}</div>
      <div className="num" style={{ fontSize: 18, fontWeight: 600, color: 'var(--text-primary)' }}>{value}</div>
      <div className="num text-2xs" style={muted}>{sub}</div>
    </div>
  );
}
