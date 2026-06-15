// src/modules/calibration/CalibrationModule.tsx
//
// The /calibration view — the 40-year feedback loop made visible. Three tabs:
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
import { cn } from '@/lib/cn';
import { isWarehouseUnavailable } from '../intel/hooks';
import { useCalibrationLog, useCalibrationPending, useCalibrationReport, type CalibrationLogRow } from './hooks';
import { ReportView } from './ReportView';
import { PendingView } from './PendingView';
import { LogView } from './LogView';
import { ResolveDialog } from './ResolveDialog';

type Tab = 'report' | 'pending' | 'log';
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'report', label: 'Report' },
  { id: 'pending', label: 'Pending' },
  { id: 'log', label: 'Log' },
];

export function CalibrationModule() {
  const [tab, setTab] = useState<Tab>('report');
  const [resolving, setResolving] = useState<CalibrationLogRow | null>(null);

  const report = useCalibrationReport();
  const pending = useCalibrationPending();
  const log = useCalibrationLog();

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
            <div className="flex items-center gap-1.5">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={cn('num rounded-full px-2.5 py-0.5 text-2xs font-semibold uppercase transition-colors', tab === t.id ? 'cursor-default' : 'cursor-pointer')}
                  style={
                    tab === t.id
                      ? { background: 'color-mix(in oklab, var(--accent) 16%, transparent)', color: 'var(--accent)', border: '1px solid color-mix(in oklab, var(--accent) 45%, transparent)', letterSpacing: '0.06em' }
                      : { background: 'transparent', color: 'var(--text-tertiary)', border: '1px solid transparent', letterSpacing: '0.06em' }
                  }
                >
                  {t.label}
                </button>
              ))}
            </div>
          }
        />
        <div className="px-4 py-2.5 text-2xs" style={{ color: 'var(--text-tertiary)' }}>
          Every warehouse verdict is dated, frozen against the exact ledger+config state that produced it, and graded once its
          horizon elapses. This is advisory evidence for weight re-ratification — it never changes a governor on its own.
        </div>
      </Card>

      {resolving && <ResolveDialog row={resolving} onClose={() => setResolving(null)} />}

      {loading ? (
        <Skeleton style={{ height: 220 }} />
      ) : tab === 'report' ? (
        <ReportView report={report.data} />
      ) : tab === 'pending' ? (
        <PendingView rows={pending.data ?? []} onResolve={setResolving} />
      ) : (
        <LogView rows={log.data ?? []} />
      )}
    </div>
  );
}
