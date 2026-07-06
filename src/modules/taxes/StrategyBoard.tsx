// src/modules/taxes/StrategyBoard.tsx
//
// Phase 6 — Taxes module Strategy Board tab.
//
// Two ranked TierBoard tiers built from TaxOpportunity[]:
//   Appeals           — kind === 'appeal', ranked by savingsOxfordShare desc. THIS is the
//                        cross-module ranked $ figure (contracts/tax.ts basis doctrine) — never
//                        savingsFullAsset.
//   Assessment Watch  — kind === 'assessment-watch', including indeterminate items. An
//                        indeterminate (or Oxford-share-null) item renders a null impact, which
//                        TierBoard's own formatImpact turns into "—" — never a guessed $0.
//
// Plus a third, STATIC informational Card — deliberately NOT a TierBoard tier with fabricated
// items. Cost-seg / depreciation / entity-structuring strategies require depreciable-basis and
// land-allocation data this system does not have yet; the honest move is to say so, not invent
// fake strategy cards.
import { TierBoard, type Tier, type TierItem } from '@/primitives/TierBoard';
import { Card, CardHeader } from '@/primitives/Card';
import { fmtPct } from '@analytics/index';
import type { TaxOpportunity } from './hooks';

/** Eff-rate / cohort-percentile chips shown on every appeal/watch card — corroborating context
 *  alongside the basisNote caption. Omitted entirely when the underlying figure is null. */
function metricChips(o: TaxOpportunity): string[] {
  const chips: string[] = [];
  if (o.effectiveRate !== null) chips.push(`Eff. rate ${fmtPct(o.effectiveRate, 2)}`);
  if (o.cohortPercentile !== null) chips.push(`Cohort ${fmtPct(o.cohortPercentile, 0)}ile`);
  return chips;
}

/** Never a guessed number: an indeterminate opportunity (or one whose Oxford ownership % is
 *  itself unavailable, leaving savingsOxfordShare null) renders a null impact — TierBoard's
 *  formatImpact turns that into "—", never a fabricated $0. */
function impactUsd(o: TaxOpportunity): number | null {
  if (o.indeterminate) return null;
  return o.savingsOxfordShare;
}

function toTierItem(o: TaxOpportunity, rank: number, impactKind: 'gain' | 'info'): TierItem {
  return {
    id: `${o.kind}-${o.propertyId}`,
    rank,
    title: o.propertyName ?? o.propertyId,
    detail: o.basisNote,
    impactUsd: impactUsd(o),
    impactKind,
    chips: metricChips(o),
  };
}

/** Appeals tier items — ranked by savingsOxfordShare desc (nulls sort last). */
function buildAppealTierItems(opportunities: TaxOpportunity[]): TierItem[] {
  return opportunities
    .filter((o) => o.kind === 'appeal')
    .slice()
    .sort((a, b) => (b.savingsOxfordShare ?? -1) - (a.savingsOxfordShare ?? -1))
    .map((o, i) => toTierItem(o, i + 1, 'gain'));
}

/** Assessment Watch tier items — includes indeterminate items (null/dash impact). Ranked the
 *  same way as Appeals for consistency; nulls (including all indeterminate items) sort last. */
function buildWatchTierItems(opportunities: TaxOpportunity[]): TierItem[] {
  return opportunities
    .filter((o) => o.kind === 'assessment-watch')
    .slice()
    .sort((a, b) => (b.savingsOxfordShare ?? -1) - (a.savingsOxfordShare ?? -1))
    .map((o, i) => toTierItem(o, i + 1, 'info'));
}

const DEFERRED_SCOPE_TEXT =
  'Cost-seg, depreciation, and entity-structuring strategies require depreciable-basis and ' +
  'land-allocation data not yet in this system — deferred pending that data source.';

/** The third "tier" — a static informational card, not a TierBoard tier with real items. */
function DeferredStrategiesCard() {
  return (
    <Card>
      <CardHeader title="Additional Strategies — Deferred" />
      <div className="px-4 py-4 text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
        {DEFERRED_SCOPE_TEXT}
      </div>
    </Card>
  );
}

export function StrategyBoard({ opportunities }: { opportunities: TaxOpportunity[] }) {
  const tiers: Tier[] = [
    { key: 'appeals', title: 'Appeals', tone: 'pos', items: buildAppealTierItems(opportunities) },
    { key: 'watch', title: 'Assessment Watch', tone: 'info', items: buildWatchTierItems(opportunities) },
  ];

  return (
    <div className="flex flex-col gap-4">
      <TierBoard tiers={tiers} columns={2} />
      <DeferredStrategiesCard />
    </div>
  );
}
