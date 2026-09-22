// src/modules/command-brain/ReportGate.tsx
//
// Rule G (IA decongestion Phase 4e): the Command Brain's whole-module offline / loading gate — and the
// disclaimer + KPI strip that only make sense over a resolved BrainReport — are scoped to the three
// report-backed panels (Track record, Feedback, Memory). Digest (PrincipalModule) and Insights
// (InsightsModule) read the snapshot and work on the static mirror, so a 503 from /brain/report must never
// blank them. The gate therefore lives INSIDE the panels, not above the strip.
//
// On the static mirror / a cold brain server the /brain/report route 503s → useBrainReport surfaces
// isWarehouseUnavailable and the panel degrades to one informational Card, mirroring CalibrationModule's
// own offline treatment. The JSX below is moved verbatim from the former whole-module gate.
import type { ReactNode } from 'react';
import { Gauge } from 'lucide-react';
import { Card, CardHeader } from '@/primitives/Card';
import { Badge } from '@/primitives/Badge';
import { KpiStat } from '@/primitives/KpiStat';
import { Skeleton } from '@/primitives/Skeleton';
import { isWarehouseUnavailable, useBrainReport } from './hooks';

/** The resolved composed report — what `useBrainReport().data` holds once loaded. */
export type BrainReport = NonNullable<ReturnType<typeof useBrainReport>['data']>;

function fmtPct(n: number | null): string {
  if (n === null || Number.isNaN(n)) return '—';
  return `${Math.round(n * 100)}%`;
}

function fmtCount(n: number | null): string {
  return n === null || Number.isNaN(n) ? '—' : String(n);
}

function accuracySublabel(
  ci: { lo: number; hi: number } | null,
  overallHitRate: number | null,
  resolvedTotal: number,
): string | undefined {
  if (ci) return `95% CI ${Math.round(ci.lo * 100)}–${Math.round(ci.hi * 100)}%`;
  if (overallHitRate === null) return `${resolvedTotal} resolved outcome${resolvedTotal === 1 ? '' : 's'} — too few to compute a rate`;
  return undefined;
}

export function ReportGate({ children }: { children: (r: BrainReport) => ReactNode }) {
  const report = useBrainReport();

  if (isWarehouseUnavailable(report.error)) {
    return (
      <Card>
        <CardHeader title="Command Brain" trailing={<Badge tone="neutral">offline</Badge>} />
        <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
          <Gauge size={28} style={{ color: 'var(--text-tertiary)' }} />
          <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>The Command Brain requires the live brain server.</div>
          <div className="text-2xs" style={{ color: 'var(--text-tertiary)', maxWidth: 440 }}>
            The composed accuracy / track-record / confidence report runs locally alongside the brain
            server. This deployed mirror is read-only and does not include it.
          </div>
        </div>
      </Card>
    );
  }

  if (report.isLoading || !report.data) {
    return <Skeleton style={{ height: 320 }} />;
  }

  const r = report.data;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader title="Command Brain" trailing={<Badge tone="neutral">advisory only</Badge>} />
        <div className="px-4 py-2.5 text-2xs" style={{ color: 'var(--text-tertiary)' }}>
          Every figure below traces to a resolved calibration outcome or a confidence-by-cohort
          computation — nothing here is invented. Feedback is display-only: accepting or dismissing a
          question records a decision but never re-weights or re-ranks the scoring engine.
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiStat
          label="Flag Accuracy"
          value={r.overallHitRate}
          format={fmtPct}
          accentColor="var(--accent)"
          sublabel={accuracySublabel(r.overallCi, r.overallHitRate, r.resolvedTotal)}
        />
        <KpiStat label="Signals Watched" value={r.watchedSignals} format={fmtCount} accentColor="var(--color-info)" />
        <KpiStat
          label="Recalibrations"
          value={r.recalibrations}
          format={fmtCount}
          accentColor="var(--color-pos)"
          sublabel="distinct scoring-config versions"
        />
        <KpiStat label="Resolved Outcomes" value={r.resolvedTotal} format={fmtCount} accentColor="var(--color-accent2)" />
      </div>

      {children(r)}
    </div>
  );
}
