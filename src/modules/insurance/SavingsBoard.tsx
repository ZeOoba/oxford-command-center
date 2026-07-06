// src/modules/insurance/SavingsBoard.tsx
//
// Savings Board tab (Phase 4a.3 UI): re-bid candidates + renewal watch, driven entirely by
// GET /api/warehouse/insurance/analysis (InsuranceAnalysisReport). Exactly two tiers — a future
// coverage/deductible optimization tier (P4c) has no data source yet and must never be
// fabricated here.
//
// DOCTRINE: excessPremiumVsMedian is dispersion vs the own-book median, never a savings
// promise — this view labels it "premium above book median", never "savings".
import { Card, CardHeader } from '@/primitives/Card';
import { Badge } from '@/primitives/Badge';
import { TierBoard } from '@/primitives/TierBoard';
import { useInsuranceAnalysis, buildSavingsTiers, benchmarkSublabel } from './hooks';

export function SavingsBoard() {
  const { data: report } = useInsuranceAnalysis();

  if (!report) return null;

  const { benchmark } = report;

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
      <TierBoard tiers={buildSavingsTiers(report)} columns={2} />
    </div>
  );
}
