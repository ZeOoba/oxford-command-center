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
import { TierBoard } from '@/primitives/TierBoard';
import { useInsuranceAnalysis, useInsuranceLoss, buildSavingsTiers, buildOptimizeTier, benchmarkSublabel } from './hooks';

export function SavingsBoard() {
  const { data: report } = useInsuranceAnalysis();
  const { data: lossReport } = useInsuranceLoss();

  if (!report) return null;

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
