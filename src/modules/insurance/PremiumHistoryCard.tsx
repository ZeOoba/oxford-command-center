// src/modules/insurance/PremiumHistoryCard.tsx
//
// Premium History card (2026-09-23 review, Task 25): policy-year premium bars + a per-line
// renewal sparkline for every multi-term line, driven by GET /api/warehouse/insurance/analysis/history
// (PremiumHistoryReport — Task 24). Rendered above Policy Tracker in the Policy Register view.
//
// Loading/offline/error states mirror SavingsBoard.tsx / SelfInsureView.tsx / TaxesModule.tsx
// exactly: Skeleton while loading, an explanatory "offline" card on the static mirror
// (WarehouseUnavailableError), a red error card on a real failure. A successfully-loaded but
// empty report (no priced/dated policy-line rows yet) renders nothing — Policy Tracker still
// shows above it in that case, so a blank supplementary card would just be noise.
import { Card, CardHeader } from '@/primitives/Card';
import { Badge } from '@/primitives/Badge';
import { Skeleton } from '@/primitives/Skeleton';
import { BarChart } from '@/charts/BarChart';
import { Sparkline } from '@/charts/Sparkline';
import { fmtUsdCompact } from '@analytics/index';
import { isWarehouseUnavailable } from '../intel/hooks';
import { usePremiumHistory, PREMIUM_HISTORY_KEY } from './hooks';

export { PREMIUM_HISTORY_KEY };

export function PremiumHistoryCard() {
  const { data, isLoading, error } = usePremiumHistory();

  if (isLoading) return <Skeleton style={{ height: 200 }} />;

  if (isWarehouseUnavailable(error)) {
    return (
      <Card>
        <CardHeader title="Premium History" trailing={<Badge tone="neutral">offline</Badge>} />
        <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
          <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            Premium history requires the live brain server.
          </div>
          <div className="text-2xs" style={{ color: 'var(--text-tertiary)', maxWidth: 420 }}>
            Policy-year totals and per-line renewal trends are computed from the warehouse policy
            snapshot. This deployed mirror does not include the live warehouse.
          </div>
        </div>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardHeader title="Premium History" trailing={<Badge tone="red">error</Badge>} />
        <div className="px-4 py-6 text-sm" style={{ color: 'var(--text-neg)' }}>
          {error instanceof Error ? error.message : 'Failed to load premium history.'}
        </div>
      </Card>
    );
  }

  if (!data || data.byYear.length === 0) return null;

  const multi = data.lines.filter((l) => l.terms.length >= 2);

  return (
    <Card>
      <CardHeader title="Premium History" trailing={<Badge tone="neutral">{multi.length} lines with renewal history</Badge>} />
      <div className="px-3 pb-2 pt-3">
        <BarChart data={data.byYear.map((y) => ({ label: String(y.year), value: y.premium }))} valueFormat={fmtUsdCompact} height={200} />
      </div>
      <ul className="grid grid-cols-1 gap-2 px-4 pb-4 md:grid-cols-2">
        {multi.map((l) => {
          const first = l.terms[0]!.premium;
          const last = l.terms.at(-1)!.premium;
          const chg = first ? (last - first) / first : 0;
          return (
            <li key={l.lineKey} className="flex items-center justify-between gap-3 text-2xs">
              <span style={{ color: 'var(--text-secondary)' }}>{l.property} · {l.policyType}</span>
              <span className="flex items-center gap-2">
                <Sparkline data={l.terms.map((t) => t.premium)} width={64} height={20} />
                <span className="num" style={{ color: chg > 0 ? 'var(--text-neg)' : 'var(--text-pos)' }}>
                  {`${chg >= 0 ? '+' : ''}${(chg * 100).toFixed(1)}%`}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
