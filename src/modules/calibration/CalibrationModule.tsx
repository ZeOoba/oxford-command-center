// src/modules/calibration/CalibrationModule.tsx
//
// The Calibration surface (a tab of the Data destination since IA decongestion Phase 4a; /calibration
// is a legacy alias) — the 40-year feedback loop made visible. Three views, switched by a
// SegmentedControl on `?view=` (rule R5: the Data destination already owns the tab strip, so no
// nested tabs):
//   Report   · the §4 aggregate (per-kind hit-rate + Wilson CI + treatment-adjusted + bias) — DEFAULT
//   Pending  · the due-but-unresolved queue + manual resolution (the only calibration write)
//   Log      · the full verdict ledger (every prediction + its blessed outcome)
//
// CORRECT ON EMPTY DATA (the normal Phase-2 state until outcomes accrue): every tab has an explicit
// empty state, no NaN, no 0/0, no crash. On the static mirror / cold brain the calibration routes 503
// → the hooks surface `isUnavailable` and the whole module degrades to one informational Card.
import { useState } from 'react';
import { Gauge } from 'lucide-react';
import { Card, CardHeader } from '@/primitives/Card';
import { Badge } from '@/primitives/Badge';
import { Skeleton } from '@/primitives/Skeleton';
import { SegmentedControl } from '@/primitives/SegmentedControl';
import { useTabParam } from '@/lib/useTabParam';
import { isWarehouseUnavailable, useWarehouseLive, useWarehouseFreshness } from '../intel/hooks';
import { useCalibrationLog, useCalibrationPending, useCalibrationReport, type CalibrationLogRow } from './hooks';
import { ReportView } from './ReportView';
import { PendingView } from './PendingView';
import { LogView } from './LogView';
import { ResolveDialog } from './ResolveDialog';

type View = 'report' | 'pending' | 'log';
const VIEW_KEYS: readonly View[] = ['report', 'pending', 'log'];
const VIEWS: Array<{ value: View; label: string }> = [
  { value: 'report', label: 'Report' },
  { value: 'pending', label: 'Pending' },
  { value: 'log', label: 'Log' },
];

export function CalibrationModule() {
  const [view, setView] = useTabParam<View>(VIEW_KEYS, 'report', 'view');
  const [resolving, setResolving] = useState<CalibrationLogRow | null>(null);

  const report = useCalibrationReport();
  const pending = useCalibrationPending();
  const log = useCalibrationLog();
  // Live workstation vs. baked mirror. On the mirror the data is read-only and computed from a
  // snapshot, so the resolve WRITE is hidden and an honest freshness badge replaces "Live".
  const live = useWarehouseLive();
  const freshness = useWarehouseFreshness();

  const unavailable =
    isWarehouseUnavailable(report.error) || isWarehouseUnavailable(pending.error) || isWarehouseUnavailable(log.error);

  if (unavailable) {
    return (
      <Card>
        <CardHeader title="Calibration Log" trailing={<Badge tone="neutral">offline</Badge>} />
        <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
          <Gauge size={28} style={{ color: 'var(--text-tertiary)' }} />
          <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>The calibration log requires the live brain server.</div>
          <div className="text-2xs" style={{ color: 'var(--text-tertiary)', maxWidth: 440 }}>
            The financial warehouse — and the score-vs-outcome calibration log — runs locally alongside the brain server. This deployed mirror is read-only and does not include it.
          </div>
        </div>
      </Card>
    );
  }

  const loading = report.isLoading || pending.isLoading || log.isLoading;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          title="Score-vs-Outcome Calibration"
          trailing={
            !live && (
              <Badge tone="neutral">
                {`Computed from snapshot${freshness.detail ? ` · ${freshness.detail}` : ''}`}
              </Badge>
            )
          }
        />
        <div className="px-4 py-2.5 text-2xs" style={{ color: 'var(--text-tertiary)' }}>
          Every warehouse verdict is dated, frozen against the exact ledger+config state that produced it, and graded once its
          horizon elapses. This is advisory evidence for weight re-ratification — it never changes a governor on its own.
        </div>
      </Card>

      {live && resolving && <ResolveDialog row={resolving} onClose={() => setResolving(null)} />}

      {loading ? (
        <Skeleton style={{ height: 220 }} />
      ) : (
        <div className="flex flex-col gap-3">
          <SegmentedControl options={VIEWS} value={view} onChange={setView} aria-label="Calibration views" />
          {view === 'report' && <ReportView report={report.data} />}
          {view === 'pending' && <PendingView rows={pending.data ?? []} onResolve={setResolving} canResolve={live} />}
          {view === 'log' && <LogView rows={log.data ?? []} />}
        </div>
      )}
    </div>
  );
}
