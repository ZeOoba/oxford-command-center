// src/modules/insurance/SelfInsureView.tsx
//
// Phase 4c — Self-Insure & Bids tab: retained-vs-transferred loss split, per-property expected
// annual loss (EAL), a deductible-review table, and the re-bid pipeline. Consumes
// GET /api/warehouse/insurance/loss (InsuranceLossReport) — see src/contracts/insurance-loss.ts
// for the dispersion/arithmetic-only doctrine (no risk-load, no savings claim).
//
// Loading/offline/error states mirror debt/LadderView.tsx and taxes/TaxesModule.tsx exactly:
// Skeleton while loading, an informational offline card when the warehouse routes are unreachable
// (static mirror), a red error card on a real failure.
//
// PLACEHOLDER DOCTRINE: when isAnyPlaceholder(report) is true (loss runs and/or dec-page terms
// are synthetic fixtures, not broker data), a PlaceholderBanner renders above every figure on
// this tab — nothing here is decision-grade until real loss runs + dec pages replace the fixture.
import { Card, CardHeader } from '@/primitives/Card';
import { Badge } from '@/primitives/Badge';
import { Skeleton } from '@/primitives/Skeleton';
import { DataTable, type Column } from '@/primitives/DataTable';
import { TierBoard, type Tier, type TierItem } from '@/primitives/TierBoard';
import { PlaceholderBanner } from '@/primitives/PlaceholderBanner';
import { fmtUsdCompact, fmtNum, fmtPct } from '@analytics/index';
import { isWarehouseUnavailable } from '../intel/hooks';
import { useInsuranceLoss, isAnyPlaceholder, placeholderDetailInsurance, unmatchedPolicyRefsDetail } from './hooks';
import type {
  InsuranceLossReport,
  PropertyEal,
  DeductibleReview,
  RebidPipelineItem,
  RebidStage,
  SelfInsureSplit,
} from '@contracts/insurance-loss';

// ── Retained vs Transferred split bar ──────────────────────────────────────────────────────

function SplitBar({ split }: { split: SelfInsureSplit }) {
  const total = split.retainedUsd + split.transferredUsd;
  // Min-width guard: when either side is 0 (or both are, if total is 0), flexGrow alone would
  // collapse that segment to zero width — fall back to an equal 1/1 split so the label + $0
  // figure stays legible instead of disappearing.
  const retainedFlex = total > 0 ? split.retainedUsd : 1;
  const transferredFlex = total > 0 ? split.transferredUsd : 1;

  return (
    <Card>
      <CardHeader title="Retained vs Transferred" />
      <div className="flex h-12 gap-1 px-4 py-3">
        <div
          className="flex min-w-[96px] items-center justify-center rounded-[var(--radius-sm)] px-2 text-2xs font-semibold"
          style={{
            flexGrow: retainedFlex,
            flexBasis: 0,
            background: 'var(--color-warn)',
            color: 'var(--text-primary)',
          }}
        >
          Retained · {fmtUsdCompact(split.retainedUsd)}
        </div>
        <div
          className="flex min-w-[96px] items-center justify-center rounded-[var(--radius-sm)] px-2 text-2xs font-semibold"
          style={{
            flexGrow: transferredFlex,
            flexBasis: 0,
            background: 'var(--color-info)',
            color: 'var(--text-primary)',
          }}
        >
          Transferred · {fmtUsdCompact(split.transferredUsd)}
        </div>
      </div>
    </Card>
  );
}

// ── Expected annual loss table ─────────────────────────────────────────────────────────────

const EAL_COLUMNS: Column<PropertyEal>[] = [
  { key: 'property', header: 'Property', render: (p) => p.property, sortValue: (p) => p.property },
  { key: 'events', header: 'Events', align: 'right', render: (p) => fmtNum(p.eventsN), sortValue: (p) => p.eventsN },
  {
    key: 'gross',
    header: 'Gross Σ',
    align: 'right',
    render: (p) => fmtUsdCompact(p.grossIncurredTotal),
    sortValue: (p) => p.grossIncurredTotal,
  },
  { key: 'years', header: 'Years', align: 'right', render: (p) => fmtNum(p.observationYears), sortValue: (p) => p.observationYears },
  {
    key: 'eal',
    header: 'EAL / yr',
    align: 'right',
    render: (p) => (
      <div className="flex items-center justify-end gap-1.5">
        <span>{fmtUsdCompact(p.ealAnnual)}</span>
        {p.indeterminate && <Badge tone="amber">indeterminate</Badge>}
      </div>
    ),
    sortValue: (p) => p.ealAnnual,
  },
];

function EalTable({ eal }: { eal: PropertyEal[] }) {
  return (
    <Card>
      <CardHeader
        title="Expected Annual Loss by Property"
        trailing={<Badge tone="neutral">{eal.length} properties</Badge>}
      />
      <DataTable
        columns={EAL_COLUMNS}
        rows={eal}
        getRowId={(p) => p.propertyId}
        initialSort={{ key: 'eal', dir: 'desc' }}
      />
    </Card>
  );
}

// ── Deductible review table ────────────────────────────────────────────────────────────────

const DEDUCTIBLE_COLUMNS: Column<DeductibleReview>[] = [
  {
    key: 'policy',
    header: 'Policy',
    render: (d) => (
      <div className="max-w-[240px]">
        <div className="truncate" style={{ fontWeight: 600 }}>{d.property}</div>
        <div className="num truncate text-2xs" style={{ color: 'var(--text-tertiary)' }}>{d.policyId}</div>
      </div>
    ),
    sortValue: (d) => d.property,
  },
  {
    key: 'deductible',
    header: 'Deductible',
    align: 'right',
    render: (d) => (
      <div className="flex items-center justify-end gap-1.5">
        <span>{fmtUsdCompact(d.deductible)}</span>
        {d.decSource === 'placeholder' && <Badge tone="amber">placeholder</Badge>}
      </div>
    ),
    sortValue: (d) => d.deductible,
  },
  { key: 'below', header: 'Below', align: 'right', render: (d) => fmtNum(d.lossesBelowDeductible), sortValue: (d) => d.lossesBelowDeductible },
  { key: 'above', header: 'Above', align: 'right', render: (d) => fmtNum(d.lossesAboveDeductible), sortValue: (d) => d.lossesAboveDeductible },
  { key: 'retained', header: 'Retained', align: 'right', render: (d) => fmtUsdCompact(d.retainedUsd), sortValue: (d) => d.retainedUsd },
  {
    key: 'transferred',
    header: 'Transferred',
    align: 'right',
    render: (d) => fmtUsdCompact(d.transferredUsd),
    sortValue: (d) => d.transferredUsd,
  },
  {
    key: 'lossRatio',
    header: 'Loss Ratio',
    align: 'right',
    render: (d) => fmtPct(d.lossRatio, 1),
    sortValue: (d) => d.lossRatio,
  },
];

function DeductibleReviewTable({ reviews }: { reviews: DeductibleReview[] }) {
  return (
    <Card>
      <CardHeader title="Deductible Review" trailing={<Badge tone="neutral">{reviews.length} policies</Badge>} />
      <DataTable
        columns={DEDUCTIBLE_COLUMNS}
        rows={reviews}
        getRowId={(d) => d.policyId}
        initialSort={{ key: 'retained', dir: 'desc' }}
      />
    </Card>
  );
}

// ── Re-bid pipeline ─────────────────────────────────────────────────────────────────────────

const REBID_STAGE_DEFS: Array<{ id: RebidStage; title: string; tone: Tier['tone'] }> = [
  { id: 'watch', title: 'Watch', tone: 'info' },
  { id: 'quote', title: 'Quote', tone: 'warn' },
  { id: 'rebid', title: 'Re-bid', tone: 'accent' },
];

function rebidTierItem(item: RebidPipelineItem, rank: number, placeholder: boolean): TierItem {
  return {
    id: item.policyId,
    rank,
    title: item.property,
    detail: item.reason,
    impactUsd: item.excessPremiumVsMedian,
    impactKind: item.excessPremiumVsMedian !== null ? 'risk' : undefined,
    chips: placeholder ? ['PLACEHOLDER'] : undefined,
  };
}

function buildRebidPipelineTiers(report: InsuranceLossReport): Tier[] {
  const placeholder = isAnyPlaceholder(report);
  return REBID_STAGE_DEFS.map((def) => ({
    key: def.id,
    title: def.title,
    tone: def.tone,
    items: report.rebidPipeline
      .filter((i) => i.stage === def.id)
      .map((i, idx) => rebidTierItem(i, idx + 1, placeholder)),
  }));
}

// ── Main view ───────────────────────────────────────────────────────────────────────────────

export function SelfInsureView() {
  const { data: report, isLoading, error } = useInsuranceLoss();

  if (isLoading) return <Skeleton style={{ height: 320 }} />;

  if (isWarehouseUnavailable(error)) {
    return (
      <Card>
        <CardHeader title="Self-Insure & Bids" trailing={<Badge tone="neutral">offline</Badge>} />
        <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
          <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            Loss reasoning requires the live brain server.
          </div>
          <div className="text-2xs" style={{ color: 'var(--text-tertiary)', maxWidth: 420 }}>
            Expected annual loss, deductible review, and the re-bid pipeline are computed from the
            warehouse loss-run + dec-page snapshot. This deployed mirror does not include the live
            warehouse.
          </div>
        </div>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardHeader title="Self-Insure & Bids" trailing={<Badge tone="red">error</Badge>} />
        <div className="px-4 py-6 text-sm" style={{ color: 'var(--text-neg)' }}>
          {error instanceof Error ? error.message : 'Failed to load loss reasoning.'}
        </div>
      </Card>
    );
  }

  if (!report) return null;

  // Independent of the placeholder banner: an unmatched policy_ref is a real-data signal
  // (loss-run typo / register gap) and must surface on warehouse-sourced reports too.
  const unmatchedDetail = unmatchedPolicyRefsDetail(report);

  return (
    <div className="flex flex-col gap-4">
      {isAnyPlaceholder(report) && <PlaceholderBanner detail={placeholderDetailInsurance(report)} />}
      {unmatchedDetail !== null && <PlaceholderBanner label="UNMATCHED POLICY REFS" detail={unmatchedDetail} />}
      <SplitBar split={report.selfInsure} />
      <EalTable eal={report.eal} />
      <DeductibleReviewTable reviews={report.deductibleReviews} />
      <TierBoard tiers={buildRebidPipelineTiers(report)} columns={3} />
    </div>
  );
}
