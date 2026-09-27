// src/modules/insurance/SavingsBoard.tsx
//
// Savings Board tab (Phase 4a.3 UI, extended P4c): re-bid candidates + renewal watch, driven by
// GET /api/warehouse/insurance/analysis (InsuranceAnalysisReport), plus a third, OPTIONAL
// "Optimize Coverage" tier driven by GET /api/warehouse/insurance/loss (InsuranceLossReport —
// Tasks 3/4/5). That third tier renders ONLY once the loss report has resolved — i.e. a loss/dec
// data source exists (placeholder fixture or live warehouse) — and is never fabricated
// in-component while the loss query is loading or unavailable (WarehouseUnavailableError).
//
// DOCTRINE: excessPremiumVsMedian is dispersion vs the own-book median, never a savings
// promise — this view labels it "premium above book median", never "savings". The Optimize
// Coverage tier is a retained-risk REVIEW QUEUE (impactUsd always null, see buildOptimizeTier),
// never a savings claim either.
import { Card, CardHeader } from '@/primitives/Card';
import { Badge } from '@/primitives/Badge';
import { Skeleton } from '@/primitives/Skeleton';
import { TierBoard } from '@/primitives/TierBoard';
import { EmptyState } from '@/primitives/EmptyState';
import { EMPTY_COPY, isInsuranceAnalysisEmpty } from '@/lib/warehouse-empty';
import { isWarehouseUnavailable } from '../intel/hooks';
import { useInsuranceAnalysis, useInsuranceLoss, buildSavingsTiers, buildOptimizeTier, benchmarkSublabel } from './hooks';

export function SavingsBoard() {
  const { data: report, isLoading, error } = useInsuranceAnalysis();
  const { data: lossReport } = useInsuranceLoss();

  // Rule G: Savings Board is Insurance's DEFAULT view, so on the static mirror (analysis route 503s)
  // a bare `return null` left the whole panel blank under four "—" KPI tiles, with no explanation —
  // while the sibling Taxes tab and Self-Insure & Bids view both say why. Same three states, same
  // copy shape as taxes/TaxesModule.tsx and ./SelfInsureView.tsx.
  if (isLoading) return <Skeleton style={{ height: 320 }} />;

  if (isWarehouseUnavailable(error)) {
    return (
      <Card>
        <CardHeader title="Savings Board" trailing={<Badge tone="neutral">offline</Badge>} />
        <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
          <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            Re-bid analysis requires the live brain server.
          </div>
          <div className="text-2xs" style={{ color: 'var(--text-tertiary)', maxWidth: 420 }}>
            Re-bid candidates, the renewal watch and the own-book rate benchmark are computed from the
            warehouse policy snapshot. This deployed mirror does not include the live warehouse.
          </div>
        </div>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardHeader title="Savings Board" trailing={<Badge tone="red">error</Badge>} />
        <div className="px-4 py-6 text-sm" style={{ color: 'var(--text-neg)' }}>
          {error instanceof Error ? error.message : 'Failed to load the insurance analysis.'}
        </div>
      </Card>
    );
  }

  if (!report) return null;
  if (isInsuranceAnalysisEmpty(report)) return <EmptyState {...EMPTY_COPY.insurance} />;

  const { benchmark } = report;
  const tiers = lossReport
    ? [...buildSavingsTiers(report), buildOptimizeTier(lossReport)]
    : buildSavingsTiers(report);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          title="Book Benchmark"
          trailing={
            <Badge tone={benchmark.sufficient ? 'neutral' : 'amber'}>{benchmarkSublabel(benchmark)}</Badge>
          }
        />
        <div className="px-4 py-3 text-xs" style={{ color: 'var(--text-tertiary)' }}>
          {benchmark.basisNote}
        </div>
      </Card>
      <TierBoard tiers={tiers} columns={tiers.length === 3 ? 3 : 2} />
    </div>
  );
}
