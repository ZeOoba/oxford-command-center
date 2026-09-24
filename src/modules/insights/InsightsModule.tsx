// src/modules/insights/InsightsModule.tsx
//
// Unified Insights board — reconciles Spine-A `Insight` (live PortfolioSnapshot conditions)
// with Spine-B/cross `InsightCandidate` (warehouse Insight Engine, GET /api/warehouse/insights)
// into one ranked, filterable, tiered view. All merge/tier/summary logic lives in
// insights.logic.ts — this file only wires data in and renders.
//
// Design reference: design_handoff_ora_command_center/app/Insights.html (results banner +
// category pills + 3-tier Critical/Priority/Monitor board).
import { useMemo, useState } from 'react';
import { useSnapshot, useAnalytics } from '@/data/queries';
import { isWarehouseUnavailable } from '../intel/hooks';
import { useWarehouseInsights } from './hooks';
import {
  mergeInsightSources,
  buildTiers,
  buildSummary,
  buildCategoryCounts,
} from './insights.logic';
import type { TierTotal } from '@/primitives/TierBoard';
import { TierBoard } from '@/primitives/TierBoard';
import { Card, CardHeader } from '@/primitives/Card';
import { KpiStat } from '@/primitives/KpiStat';
import { Badge } from '@/primitives/Badge';
import { Skeleton } from '@/primitives/Skeleton';
import { fmtUsdCompact } from '@analytics/index';

// Quoted verbatim from server/insights/rank.ts's INSIGHT_CONFIG header comment, so this badge
// never drifts out of sync with the engine's own disclaimer.
const RANKING_DISCLAIMER =
  'Proposed weights — tunable by Gabriel; NOT a financial governor. Ratification of these values is a RED (human event).';

// Anatomy matches KpiStat.tsx's non-interactive Card exactly (July visual-parity pass dropped
// KpiStat's left accent bar; this local stat block had drifted and kept its own — see IA
// decongestion Phase 1 plan residual (b)). No accentColor prop — KpiStat's own accentColor only
// ever colors its sparkline, and SpineSplitStat has none, so there is nothing left for it to do.
function SpineSplitStat({
  label,
  totals,
}: {
  label: string;
  totals: TierTotal[];
}) {
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-col gap-2 px-4 pt-3.5 pb-3.5">
        <div
          className="num text-2xs font-semibold uppercase"
          style={{ letterSpacing: '0.12em', color: 'var(--text-tertiary)' }}
        >
          {label}
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-1">
          {totals.map((t) => (
            <div key={t.label}>
              <div className="num text-lg font-semibold leading-none" style={{ color: 'var(--text-primary)' }}>
                {fmtUsdCompact(t.totalUsd)}
              </div>
              <div className="num mt-1 text-2xs" style={{ color: 'var(--text-tertiary)' }}>
                {t.label}
              </div>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}

function FilterPill({
  label,
  count,
  active,
  onSelect,
}: {
  label: string;
  count: number;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className="num rounded-[var(--radius-sm)] px-3 py-1 text-2xs font-medium transition-colors"
      style={{
        background: active ? 'var(--accent)' : 'var(--surface-overlay)',
        color: active ? 'var(--text-on-accent)' : 'var(--text-secondary)',
        border: '1px solid var(--border-subtle)',
      }}
    >
      {label} · {count}
    </button>
  );
}

export function InsightsModule() {
  const snapshotQuery = useSnapshot();
  const { analytics } = useAnalytics();
  const insightsQuery = useWarehouseInsights();
  const [category, setCategory] = useState<string>('all');

  const snapshot = snapshotQuery.data?.snapshot ?? null;
  const spineAInsights = useMemo(() => analytics?.insights ?? [], [analytics]);
  const candidates = useMemo(() => insightsQuery.data?.candidates ?? [], [insightsQuery.data]);

  const { merged, supersededCount } = useMemo(
    () => (snapshot ? mergeInsightSources(spineAInsights, candidates, snapshot) : { merged: [], supersededCount: 0 }),
    [snapshot, spineAInsights, candidates],
  );

  const filtered = useMemo(
    () => (category === 'all' ? merged : merged.filter((m) => m.category === category)),
    [merged, category],
  );

  const tiers = useMemo(() => buildTiers(filtered), [filtered]);
  const summary = useMemo(() => buildSummary(filtered), [filtered]);
  const categoryCounts = useMemo(() => buildCategoryCounts(merged), [merged]);

  const warehouseUnavailable = isWarehouseUnavailable(insightsQuery.error);
  const warehouseErrored = insightsQuery.isError && !warehouseUnavailable;

  if (snapshotQuery.isLoading || !analytics) {
    return <Skeleton style={{ height: 420 }} />;
  }

  if (snapshotQuery.isError || !snapshot) {
    return (
      <Card>
        <CardHeader title="Insights" trailing={<Badge tone="red">error</Badge>} />
        <div className="px-4 py-6 text-sm" style={{ color: 'var(--text-neg)' }}>
          Failed to load the portfolio snapshot — Workbook insights are unavailable.
        </div>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          title="Insights"
          trailing={
            <span title={RANKING_DISCLAIMER}>
              <Badge tone="amber">Ranking weights: proposed, pending ratification</Badge>
            </span>
          }
        />

        <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-3">
          <SpineSplitStat label="Risk Impact" totals={summary.riskImpactBySpine} />
          <SpineSplitStat label="Monitor Impact" totals={summary.monitorImpactBySpine} />
          <KpiStat label="Open Insights" value={summary.count} format={(n) => (n === null ? '—' : String(n))} />
        </div>

        {warehouseUnavailable && (
          <div className="px-4 pb-3 text-2xs" style={{ color: 'var(--text-tertiary)' }}>
            Warehouse candidates unavailable on this deployment — showing workbook-based insights only.
          </div>
        )}
        {warehouseErrored && (
          <div className="px-4 pb-3 text-2xs" style={{ color: 'var(--text-neg)' }}>
            {insightsQuery.error instanceof Error
              ? insightsQuery.error.message
              : 'Failed to load warehouse insight candidates.'}
          </div>
        )}
        {supersededCount > 0 && (
          <div className="px-4 pb-3 text-2xs" style={{ color: 'var(--text-tertiary)' }}>
            {supersededCount} workbook insight{supersededCount === 1 ? '' : 's'} superseded by a richer ledger
            candidate.
          </div>
        )}

        <div className="flex flex-wrap gap-2 px-4 pb-4">
          <FilterPill label="All" count={merged.length} active={category === 'all'} onSelect={() => setCategory('all')} />
          {categoryCounts.map((c) => (
            <FilterPill
              key={c.category}
              label={c.category}
              count={c.count}
              active={category === c.category}
              onSelect={() => setCategory(c.category)}
            />
          ))}
        </div>
      </Card>

      <TierBoard tiers={tiers} columns={3} />
    </div>
  );
}
