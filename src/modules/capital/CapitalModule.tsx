// src/modules/capital/CapitalModule.tsx
//
// Phase 5 W2 — Capital Allocation capstone module.
// Two panels:
//   1. Portfolio Allocation — ranked AllocationCard list across all assets.
//   2. Pipeline — T1/T2 candidates from portfolio.pipeline.
// Top: HurdleRateBanner (visible while hurdle rate is proposed).
import type { AllocationAction } from '@contracts/capital';
import { Card, CardHeader } from '@/primitives/Card';
import { Badge } from '@/primitives/Badge';
import { Skeleton } from '@/primitives/Skeleton';
import { useCapitalAllocation, actionLabel, actionColor } from './hooks';
import { AllocationCard } from './AllocationCard';
import { HurdleRateBanner } from './HurdleRateBanner';

function fmtPct(n: number | null): string {
  if (n === null) return '—';
  return `${(n * 100).toFixed(1)}%`;
}

export function CapitalModule() {
  const { data, isLoading, error } = useCapitalAllocation();

  if (isLoading) return (
    <div className="flex flex-col gap-4">
      {[1, 2, 3].map(i => <Skeleton key={i} style={{ height: 80, borderRadius: 8 }} />)}
    </div>
  );

  if (error || !data) return (
    <Card>
      <div style={{ padding: 20, color: 'var(--text-secondary)', fontSize: 13 }}>
        Capital allocation data unavailable — warehouse may be offline.
      </div>
    </Card>
  );

  const { portfolio, hurdleRate } = data;
  const actionEntries = Object.entries(portfolio.actionCounts) as Array<[string, number]>;

  return (
    <div className="flex flex-col gap-4">
      {/* Advisory banner — shown while hurdle rate is proposed */}
      <HurdleRateBanner hurdleRate={hurdleRate} />

      {/* Summary header */}
      <Card>
        <CardHeader
          title="Capital Allocation"
          trailing={
            <div style={{ display: 'flex', gap: 6 }}>
              {actionEntries.filter(([, n]) => n > 0).map(([action, count]) => (
                <span key={action} style={{
                  fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 4,
                  background: `color-mix(in oklab, ${actionColor(action as AllocationAction)} 12%, transparent)`,
                  color: actionColor(action as AllocationAction),
                  border: `1px solid color-mix(in oklab, ${actionColor(action as AllocationAction)} 35%, transparent)`,
                }}>
                  {actionLabel(action as AllocationAction)} {count}
                </span>
              ))}
            </div>
          }
        />
      </Card>

      {/* Portfolio allocation list */}
      <div className="flex flex-col gap-3">
        {portfolio.verdicts.length === 0 ? (
          <Card>
            <div style={{ padding: 20, color: 'var(--text-secondary)', fontSize: 13 }}>
              No verdicts — run a full warehouse ingest first.
            </div>
          </Card>
        ) : (
          portfolio.verdicts.map(v => (
            <AllocationCard
              key={v.propertyId}
              verdict={v}
              hurdleRatePct={hurdleRate.hurdleRatePct}
            />
          ))
        )}
      </div>

      {/* Pipeline candidates */}
      {portfolio.pipeline.length > 0 && (
        <Card>
          <CardHeader title="Buy Pipeline" trailing={<Badge tone="neutral">{portfolio.pipeline.length} candidates</Badge>} />
          <div style={{ padding: '8px 0' }}>
            {portfolio.pipeline.map(c => (
              <div key={c.candidateId} style={{
                display: 'flex', alignItems: 'center', gap: 12,
                padding: '8px 14px', borderTop: '1px solid var(--border)', fontSize: 13,
              }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600 }}>{c.address ?? c.candidateId}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{c.market ?? '—'}</div>
                </div>
                {c.tier && <Badge tone={c.tier === 'T1' ? 'green' : 'neutral'}>{c.tier}</Badge>}
                <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                  IRR {fmtPct(c.leveredIrr)}
                </span>
                {c.basisDiscountPct !== null && (
                  <span style={{ fontSize: 12, color: 'var(--color-pos, #22c55e)' }}>
                    {fmtPct(c.basisDiscountPct)} disc.
                  </span>
                )}
                {c.composite !== null && (
                  <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' }}>
                    {Math.round(c.composite)}/100
                  </span>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
