// src/modules/insurance/hooks.ts
//
// TanStack Query hook + pure display helpers for the Insurance Savings Board (Phase 4a.3 UI).
//
// Consumes:
//   GET /api/warehouse/insurance/analysis → InsuranceAnalysisReport
//
// Error policy mirrors debt/hooks.ts: fetchParsedOrMirror degrades gracefully on a
// 503/non-JSON mirror response (WarehouseUnavailableError → module renders an empty state);
// a real API error (4xx/5xx with a JSON body) surfaces as a thrown Error.
//
// DOCTRINE (mirrors src/contracts/insurance-analysis.ts): the benchmark is an own-book median,
// never a market rate, and excessPremiumVsMedian is dispersion, NOT a savings promise. Every
// helper below that surfaces it labels it "premium above book median" — never "savings".
import { useQuery } from '@tanstack/react-query';
import { fetchParsedOrMirror, QUERY_OPTS } from '../intel/hooks';
import { InsuranceAnalysisReport, PremiumHistoryReport } from '@contracts/insurance-analysis';
import type { PolicyEconomics, RenewalBucket, BookBenchmark } from '@contracts/insurance-analysis';
import { InsuranceLossReport } from '@contracts/insurance-loss';
import type { DeductibleReview } from '@contracts/insurance-loss';
import { fmtUsdCompact } from '@analytics/index';
import type { Tier, TierItem } from '@/primitives/TierBoard';

export const INSURANCE_ANALYSIS_KEY = ['warehouse', 'insurance', 'analysis'] as const;
export const INSURANCE_LOSS_KEY = ['warehouse', 'insurance', 'loss'] as const;
export const PREMIUM_HISTORY_KEY = ['warehouse', 'insurance', 'premium-history'] as const;

/**
 * Insurance re-bid analysis report — re-bid candidates, renewal calendar, and the own-book
 * rate benchmark. Degrades gracefully on the static mirror (WarehouseUnavailableError → empty
 * state), same as every other warehouse-backed module.
 */
export function useInsuranceAnalysis() {
  return useQuery({
    queryKey: INSURANCE_ANALYSIS_KEY,
    queryFn: () => fetchParsedOrMirror('/api/warehouse/insurance/analysis', InsuranceAnalysisReport),
    ...QUERY_OPTS,
  });
}

/**
 * Per-line premium terms + policy-year totals (Task 24's GET .../insurance/analysis/history).
 * Same degrade-gracefully policy as useInsuranceAnalysis: WarehouseUnavailableError on the
 * static mirror → PremiumHistoryCard renders its offline state instead of throwing.
 */
export function usePremiumHistory() {
  return useQuery({
    queryKey: PREMIUM_HISTORY_KEY,
    queryFn: () => fetchParsedOrMirror('/api/warehouse/insurance/analysis/history', PremiumHistoryReport),
    ...QUERY_OPTS,
  });
}

// ── Pure display helpers (unit-testable; no React dependencies) ──────────────────────────

const RENEWAL_WATCH_BUCKETS: readonly RenewalBucket[] = ['now-45', 'soon-90'];

const RENEWAL_BUCKET_LABEL: Record<RenewalBucket, string> = {
  'now-45': 'Due ≤45d',
  'soon-90': 'Due ≤90d',
  later: 'Later',
  expired: 'Expired',
  unknown: 'Unknown renewal',
};

/** premium per $100 of TIV, displayed as a small dollar figure (e.g. "$0.42"). */
export function fmtRatePer100(n: number | null): string {
  return n === null || !Number.isFinite(n) ? '—' : `$${n.toFixed(2)}`;
}

/** "n=12 policies" when the cohort is large enough to trust; the insufficient-cohort state
 *  otherwise — the median itself is already null in that case (engine-enforced), so this is
 *  the only place the insufficiency is spelled out for a reader. */
export function benchmarkSublabel(benchmark: BookBenchmark): string {
  return benchmark.sufficient
    ? `n=${benchmark.cohortN} policies`
    : `insufficient cohort — n=${benchmark.cohortN}`;
}

/** Sum of excessPremiumVsMedian across rebid candidates. Defensive Math.max(0, …) guard even
 *  though the engine only ever populates rebidCandidates with positive excess — this is
 *  dispersion vs a cohort median, never a savings figure. */
export function sumPremiumAboveMedian(candidates: readonly PolicyEconomics[]): number {
  return candidates.reduce((sum, p) => sum + Math.max(0, p.excessPremiumVsMedian ?? 0), 0);
}

/** Count of renewalCalendar entries due within 90 days ('now-45' or 'soon-90'). */
export function countRenewalsWithin90(renewalCalendar: readonly PolicyEconomics[]): number {
  return renewalCalendar.filter((p) => RENEWAL_WATCH_BUCKETS.includes(p.renewalBucket)).length;
}

export interface InsuranceKpis {
  premiumAnnualTotal: number | null;
  medianRatePer100Tiv: number | null;
  benchmarkSublabel: string;
  premiumAboveMedian: number | null;
  renewalsWithin90: number | null;
}

/** Derives the 4 headline KPIs from the analysis report. Returns an all-null shape while the
 *  report is loading/unavailable so KpiStat renders its own "—" state rather than the caller
 *  branching on presence. */
export function computeInsuranceKpis(report: InsuranceAnalysisReport | undefined): InsuranceKpis {
  if (!report) {
    return {
      premiumAnnualTotal: null,
      medianRatePer100Tiv: null,
      benchmarkSublabel: '—',
      premiumAboveMedian: null,
      renewalsWithin90: null,
    };
  }
  return {
    premiumAnnualTotal: report.premiumAnnualTotal,
    medianRatePer100Tiv: report.benchmark.medianRatePer100Tiv,
    benchmarkSublabel: benchmarkSublabel(report.benchmark),
    premiumAboveMedian: sumPremiumAboveMedian(report.rebidCandidates),
    renewalsWithin90: countRenewalsWithin90(report.renewalCalendar),
  };
}

function rebidTierItem(p: PolicyEconomics, rank: number): TierItem {
  return {
    id: p.policyId,
    rank,
    category: p.carrier ?? undefined,
    impactUsd: p.excessPremiumVsMedian,
    impactKind: 'risk',
    title: p.property,
    detail: 'premium above book median',
    chips: RENEWAL_WATCH_BUCKETS.includes(p.renewalBucket) ? [RENEWAL_BUCKET_LABEL[p.renewalBucket]] : undefined,
  };
}

function renewalWatchTierItem(p: PolicyEconomics, rank: number): TierItem {
  return {
    id: p.policyId,
    rank,
    category: p.carrier ?? undefined,
    impactUsd: p.premium,
    impactKind: 'info',
    title: p.property,
    detail:
      p.daysToExpiry !== null
        ? `annual premium · ${RENEWAL_BUCKET_LABEL[p.renewalBucket]} · ${p.daysToExpiry}d`
        : `annual premium · ${RENEWAL_BUCKET_LABEL[p.renewalBucket]}`,
  };
}

/**
 * Builds the two Savings Board tiers driven by the analysis report. A third, optional tier
 * (Optimize Coverage — see `buildOptimizeTier` below) is built separately from the LOSS report
 * (P4c) and appended by the caller only when that report has resolved — never fabricated here.
 *
 * "Re-bid — above book median": every rebidCandidates entry (server-sorted by
 * excessPremiumVsMedian DESC — not re-sorted here).
 * "Renewal watch": renewalCalendar entries due within 90 days that are NOT already a rebid
 * candidate (deduped by policyId), preserving the server's ascending daysToExpiry order.
 */
export function buildSavingsTiers(report: InsuranceAnalysisReport): Tier[] {
  const rebidIds = new Set(report.rebidCandidates.map((p) => p.policyId));
  const renewalWatch = report.renewalCalendar.filter(
    (p) => RENEWAL_WATCH_BUCKETS.includes(p.renewalBucket) && !rebidIds.has(p.policyId),
  );

  return [
    {
      key: 'rebid',
      title: 'Re-bid — above book median',
      subtitle: 'ranked by dollar impact vs the benchmark above',
      tone: 'warn',
      items: report.rebidCandidates.map((p, i) => rebidTierItem(p, i + 1)),
    },
    {
      key: 'renewal-watch',
      title: 'Renewal watch',
      subtitle: 'due within 90 days',
      tone: 'info',
      items: renewalWatch.map((p, i) => renewalWatchTierItem(p, i + 1)),
    },
  ];
}

// ── Insurance LOSS reasoning (P4c) — GET /api/warehouse/insurance/loss ────────────────────
//
// Doctrine (contracts/insurance-loss.ts): dispersion/arithmetic only — EAL, the retained/
// transferred split, and loss ratio are mechanical roll-ups of observed loss runs vs the stated
// deductible/limit. No risk-load, no savings claim. `isAnyPlaceholder` gates the Self-Insure &
// Bids tab's advisory banner and the Optimize Coverage tier's chips; `buildOptimizeTier` never
// claims a $ savings figure (impactUsd is always null) — it is a retained-risk REVIEW QUEUE
// ranked by dollars retained, not a coverage-optimization promise.

/** Expected annual loss report — retained/transferred split, EAL, deductible reviews, and the
 *  re-bid pipeline. Degrades gracefully on the static mirror (WarehouseUnavailableError → the
 *  Self-Insure & Bids tab renders an informational empty state), same as every other
 *  warehouse-backed module. */
export function useInsuranceLoss() {
  return useQuery({
    queryKey: INSURANCE_LOSS_KEY,
    queryFn: () => fetchParsedOrMirror('/api/warehouse/insurance/loss', InsuranceLossReport),
    ...QUERY_OPTS,
  });
}

/** True when either the loss runs or the dec-page terms fell back to placeholder fixtures. */
export function isAnyPlaceholder(report: InsuranceLossReport): boolean {
  return report.lossDataSource === 'placeholder' || report.decPageDataSource === 'placeholder';
}

const PLACEHOLDER_DETAIL_BASE =
  'Synthetic loss runs and blanket deductible/limit assumptions pending broker loss runs + dec pages. ' +
  'No figure on this tab is decision-grade.';

/** Advisory banner detail for the Self-Insure & Bids tab. Appends a dropped-row count when the
 *  fixture loader had to discard malformed rows, so a data-quality issue never disappears
 *  silently behind the placeholder banner's fixed sentence. */
export function placeholderDetailInsurance(report: InsuranceLossReport): string {
  if (report.droppedFixtureRows > 0) {
    const rows = report.droppedFixtureRows === 1 ? 'row' : 'rows';
    return `${PLACEHOLDER_DETAIL_BASE} (${report.droppedFixtureRows} fixture ${rows} dropped.)`;
  }
  return PLACEHOLDER_DETAIL_BASE;
}

/** How many unmatched-ref entries the notice spells out before collapsing to ", and K more". */
const UNMATCHED_REF_LIST_MAX = 5;

/**
 * Data-quality notice detail for `report.unmatchedPolicyRefs` (loss events whose policy_ref names
 * no policy on file at their property — see contracts/insurance-loss.ts). Null when there are
 * none. Rendered INDEPENDENTLY of the placeholder banner: this matters most on real warehouse
 * loss runs. The wording claims only that the ref was ignored — where each event then landed
 * (covering term, most recent policy, or EAL-only) varies, so the notice does not say.
 */
export function unmatchedPolicyRefsDetail(report: InsuranceLossReport): string | null {
  const refs = report.unmatchedPolicyRefs;
  const n = refs.length;
  if (n === 0) return null;
  const head = n === 1
    ? '1 loss event carries a policy number that matches no policy on file at its property'
    : `${n} loss events carry a policy number that matches no policy on file at their property`;
  const listed = refs
    .slice(0, UNMATCHED_REF_LIST_MAX)
    .map((u) => `${u.property} '${u.policyRef}' (${u.lossDate})`)
    .join(', ');
  const more = n > UNMATCHED_REF_LIST_MAX ? `, and ${n - UNMATCHED_REF_LIST_MAX} more` : '';
  return (
    `${head} — a loss-run typo or a policy missing from the register; the ref was ignored ` +
    `when attaching the event to a policy: ${listed}${more}.`
  );
}

function optimizeTierItem(d: DeductibleReview, rank: number, placeholder: boolean): TierItem {
  return {
    id: d.policyId,
    rank,
    title: d.property,
    detail: `retained ${fmtUsdCompact(d.retainedUsd)} of ${fmtUsdCompact(d.retainedUsd + d.transferredUsd)} · deductible ${fmtUsdCompact(d.deductible)}`,
    impactUsd: null,
    chips: placeholder ? ['PLACEHOLDER'] : undefined,
  };
}

/**
 * Builds the third, optional Savings Board tier from the LOSS report — a retained-risk REVIEW
 * QUEUE, ranked by retainedUsd desc, never a savings claim (impactUsd is always null; this is a
 * candidate list for a broker/coverage conversation, not a dollar figure). The caller (SavingsBoard)
 * gates rendering on `useInsuranceLoss()` data being present — this function itself never
 * fabricates data when the report hasn't resolved.
 */
export function buildOptimizeTier(report: InsuranceLossReport): Tier {
  const placeholder = isAnyPlaceholder(report);
  const ranked = [...report.deductibleReviews].sort((a, b) => b.retainedUsd - a.retainedUsd);
  return {
    key: 'optimize',
    title: 'Optimize Coverage',
    subtitle: 'retained-risk review queue — ranked by dollars retained',
    tone: 'accent',
    items: ranked.map((d, i) => optimizeTierItem(d, i + 1, placeholder)),
  };
}
