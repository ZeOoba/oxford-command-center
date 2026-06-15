// src/modules/calibration/ReportView.tsx
//
// The §4 calibration report: per-kind hit-rate (with Wilson interval), directional accuracy, bias,
// per-band breakdown, and the treatment-adjusted hit-rate (action_taken='none' rows only — the clean
// natural experiments, §4.1/§5). RENDERS CORRECTLY ON EMPTY DATA: when nothing is scoreable yet (the
// normal Phase-2 state) it shows an explicit "no resolved outcomes yet" panel, never NaN, never 0/0.
import { Card, CardHeader } from '@/primitives/Card';
import { Badge } from '@/primitives/Badge';
import { KpiStat } from '@/primitives/KpiStat';
import type { CalibrationReportResponse } from './hooks';
import { fmtRate, fmtInterval, fmtSigned, kindTone, reportIsEmpty } from './format';

export function ReportView({ report }: { report: CalibrationReportResponse | undefined }) {
  if (reportIsEmpty(report)) {
    return (
      <Card>
        <CardHeader title="Calibration Report" trailing={<Badge tone="neutral">accumulating</Badge>} />
        <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
          <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>No resolved outcomes yet.</div>
          <div className="text-2xs" style={{ color: 'var(--text-tertiary)', maxWidth: 520 }}>
            {report
              ? `${report.totalVerdicts} verdict${report.totalVerdicts === 1 ? '' : 's'} logged; none have a resolved outcome to score against yet. `
              : 'The verdict log is still accumulating. '}
            Outcomes can only be scored once at least one evaluation horizon has elapsed — the first ~5
            years are data-accumulation, not actionable calibration.
          </div>
        </div>
      </Card>
    );
  }

  const r = report!;
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          title="Calibration Report"
          trailing={<Badge tone="green">{r.resolvedVerdicts} resolved</Badge>}
        />
        <div className="px-4 py-3">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <KpiStat label="Overall Hit-Rate" value={r.overallHitRate ?? null} format={(n) => (n === null ? '—' : `${Math.round(n * 100)}%`)} accentColor="var(--accent)" sublabel={`${r.scoreableVerdicts} scoreable`} />
            <KpiStat label="Treatment-Adjusted" value={r.treatmentAdjustedHitRate ?? null} format={(n) => (n === null ? '—' : `${Math.round(n * 100)}%`)} accentColor="var(--color-info)" sublabel={`${r.treatmentAdjustedScoreable} clean tests`} />
            <KpiStat label="Total Verdicts" value={r.totalVerdicts} format={(n) => (n === null ? '—' : String(Math.round(n)))} accentColor="var(--color-pos)" />
            <KpiStat label="Resolved" value={r.resolvedVerdicts} format={(n) => (n === null ? '—' : String(Math.round(n)))} accentColor="var(--color-pos)" />
          </div>
          <div className="mt-3 text-2xs" style={{ color: 'var(--text-tertiary)' }}>{r.dataMaturityNote}</div>
        </div>
      </Card>

      {r.byKind.map((k) => (
        <Card key={k.verdictKind}>
          <CardHeader
            title={<span className="flex items-center gap-2"><Badge tone={kindTone(k.verdictKind)}>{k.verdictKind}</Badge></span>}
            trailing={<span className="num text-2xs" style={{ color: 'var(--text-tertiary)' }}>n={k.scoreable} scoreable · {k.resolved} resolved · {k.total} total</span>}
          />
          <div className="grid grid-cols-2 gap-3 px-4 py-3 md:grid-cols-4">
            <Metric label="Hit-Rate" value={fmtRate(k.hitRate)} sub={`95% CI ${fmtInterval(k.wilsonLow, k.wilsonHigh)}`} />
            <Metric label="Directional" value={fmtRate(k.directionalAccuracy)} sub={`${k.directionalScoreable} directional`} />
            <Metric label="Bias (pred−real)" value={fmtSigned(k.meanSignedError)} sub="mean signed error" />
            <Metric label="Hits" value={`${k.hits}/${k.scoreable}`} sub="hit / scoreable" />
          </div>
          {k.byBand.length > 0 && (
            <div className="px-4 pb-3">
              <div className="text-2xs uppercase" style={{ letterSpacing: '0.06em', color: 'var(--text-tertiary)' }}>By predicted band</div>
              <div className="mt-1.5 flex flex-wrap gap-2">
                {k.byBand.map((b) => (
                  <span key={b.band} className="num rounded-md px-2 py-1 text-2xs"
                    style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)' }}>
                    {b.band}: {fmtRate(b.hitRate)} <span style={{ color: 'var(--text-tertiary)' }}>({b.hits}/{b.scoreable})</span>
                  </span>
                ))}
              </div>
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}

function Metric({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-2xs uppercase" style={{ letterSpacing: '0.06em', color: 'var(--text-tertiary)' }}>{label}</span>
      <span className="num text-base font-semibold" style={{ color: 'var(--text-primary)' }}>{value}</span>
      <span className="text-2xs" style={{ color: 'var(--text-tertiary)' }}>{sub}</span>
    </div>
  );
}
