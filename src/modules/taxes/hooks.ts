// src/modules/taxes/hooks.ts
//
// Phase 6 — Taxes module (Property Tax Analysis + Appeals) data hooks.
//
// Read:  GET  /api/warehouse/tax/analysis → TaxAnalysisReport (assessments + appeals + advisory
//        appeal/assessment-watch opportunities). Degrades to the static mirror / offline empty
//        state exactly like debt/hooks.ts and intel/hooks.ts (fetchParsedOrMirror + QUERY_OPTS).
// Write: POST /api/warehouse/tax/appeals → create (id absent) or update (id present) a
//        tax_appeals row. Invalidates the analysis query on success (mirrors
//        acquisitions/hooks.ts's useSetCandidateStatus: an own useQueryClient + own query-key
//        invalidation — taxes has no other warehouse query family yet, so no shared cross-module
//        invalidator like intel/hooks.ts's useWarehouseInvalidate is needed).
//
// Basis doctrine (contracts/tax.ts header): assessments/millage/the ledger 'Taxes' category are
// FULL-ASSET, while every cross-module ranked $ figure must use `savingsOxfordShare`, never
// `savingsFullAsset`. The pure helpers below enforce that at the boundary so no component body
// has to re-derive it, and so the rule is unit-testable independent of any rendering.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchParsedOrMirror, QUERY_OPTS } from '../intel/hooks';
import { TaxAnalysisReport, TaxAppeal } from '@contracts/tax';
import type { TaxAppealInput, TaxAppealStatus, TaxOpportunity, TaxAssessment } from '@contracts/tax';
import { TaxStrategyReport } from '@contracts/tax-strategy';
import type { CostSegOpportunity, EntityStrategyItem, FiledReturnMeta, StrategyDataSource } from '@contracts/tax-strategy';
import type { BadgeTone } from '@/primitives/Badge';
import type { Tier, TierItem } from '@/primitives/TierBoard';

export type { TaxAnalysisReport, TaxAppeal, TaxAppealInput, TaxAppealStatus, TaxOpportunity, TaxAssessment };
export type { TaxStrategyReport, CostSegOpportunity, EntityStrategyItem, FiledReturnMeta, StrategyDataSource };

// ── Query keys ───────────────────────────────────────────────────────────────────────────────

export const TAX_KEYS = {
  analysis: ['warehouse', 'tax', 'analysis'] as const,
};

// ── Read hook ────────────────────────────────────────────────────────────────────────────────

/** Full tax analysis report (assessments, appeals, opportunities). Degrades gracefully on the
 *  static mirror (WarehouseUnavailableError → module renders an informational empty state). */
export function useTaxAnalysis() {
  return useQuery({
    queryKey: TAX_KEYS.analysis,
    queryFn: () => fetchParsedOrMirror('/api/warehouse/tax/analysis', TaxAnalysisReport),
    ...QUERY_OPTS,
  });
}

// ── Write hook ───────────────────────────────────────────────────────────────────────────────

/** POST /api/warehouse/tax/appeals — create (no `id`) or update (`id` present) one appeal row.
 *  Returns the server's Zod-validated TaxAppeal. Mirrors prospect-demand-hooks.ts's
 *  addProspectEvent (plain async fetch helper, not itself a hook — the hook wraps it below). */
export async function postTaxAppeal(input: TaxAppealInput): Promise<TaxAppeal> {
  const res = await fetch('/api/warehouse/tax/appeals', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Failed to file appeal (${res.status})`);
  }
  return TaxAppeal.parse(await res.json());
}

/** File (create) or update a tax appeal. Invalidates the analysis query on success so the
 *  Assessments & Appeals table and the Appeals-in-Flight KPI both refetch immediately. */
export function useFileAppeal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: postTaxAppeal,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: TAX_KEYS.analysis });
    },
  });
}

// ── Pure display / aggregation helpers (unit-testable; no React dependency) ──────────────────

const CLOSED_APPEAL_STATUSES = new Set<TaxAppealStatus>(['won', 'lost', 'withdrawn']);

/** True when an appeal has not yet reached a terminal outcome (won/lost/withdrawn). */
export function isAppealInFlight(status: TaxAppealStatus): boolean {
  return !CLOSED_APPEAL_STATUSES.has(status);
}

/** Count of appeals not yet won/lost/withdrawn — the "Appeals in Flight" KPI. */
export function countAppealsInFlight(appeals: TaxAppeal[]): number {
  return appeals.filter((a) => isAppealInFlight(a.status)).length;
}

/** Badge tone per appeal lifecycle status: draft=neutral, filed/hearing=blue, won=green,
 *  lost/withdrawn=red. */
export function appealStatusTone(status: TaxAppealStatus): BadgeTone {
  switch (status) {
    case 'draft':
      return 'neutral';
    case 'filed':
    case 'hearing':
      return 'blue';
    case 'won':
      return 'green';
    case 'lost':
    case 'withdrawn':
      return 'red';
  }
}

/**
 * Sum of `savingsOxfordShare` across DETERMINATE `'appeal'`-kind opportunities only — the
 * "Identified Opportunity" KPI. Never sums `savingsFullAsset` (basis doctrine, contracts/tax.ts) —
 * every cross-module ranked $ figure is Oxford-share. Excludes `'assessment-watch'` items and any
 * opportunity whose `savingsOxfordShare` is null — that can happen even for a determinate,
 * `kind === 'appeal'` opportunity when the Oxford ownership % itself is unavailable — a null
 * contributes nothing to the sum, never a guessed number.
 */
export function sumIdentifiedOpportunityUsd(opportunities: TaxOpportunity[]): number {
  return opportunities
    .filter((o) => o.kind === 'appeal' && !o.indeterminate && o.savingsOxfordShare !== null)
    .reduce((sum, o) => sum + (o.savingsOxfordShare as number), 0);
}

/**
 * Portfolio-weighted effective tax rate: Σ annualTaxBilled ÷ Σ assessedValue across assessments
 * where BOTH figures are present (same full-asset basis on both sides of the ratio — no basis
 * mixing). Null when no assessment carries both fields — the "Effective Rate" KPI then falls back
 * to "varies by property — see table" rather than inventing an aggregate the contract doesn't
 * provide.
 */
export function computePortfolioEffectiveRate(assessments: TaxAssessment[]): number | null {
  let taxSum = 0;
  let valueSum = 0;
  for (const a of assessments) {
    if (a.annualTaxBilled !== null && a.assessedValue !== null && a.assessedValue > 0) {
      taxSum += a.annualTaxBilled;
      valueSum += a.assessedValue;
    }
  }
  return valueSum > 0 ? taxSum / valueSum : null;
}

/** propertyId → its opportunity (the analysis engine builds at most one per property, off the
 *  latest tax_year assessment). */
export function opportunityByProperty(opportunities: TaxOpportunity[]): Map<string, TaxOpportunity> {
  return new Map(opportunities.map((o) => [o.propertyId, o]));
}

/** propertyId → all of its appeals (any tax year — appeals have their own lifecycle independent
 *  of the latest assessment), preserving the server's ascending sort. */
export function appealsByProperty(appeals: TaxAppeal[]): Map<string, TaxAppeal[]> {
  const map = new Map<string, TaxAppeal[]>();
  for (const a of appeals) {
    const list = map.get(a.propertyId);
    if (list) list.push(a);
    else map.set(a.propertyId, [a]);
  }
  return map;
}

// ── Tax STRATEGY (P4c / C2) — GET /api/warehouse/tax/strategy ──────────────────────────────
//
// Doctrine (contracts/tax-strategy.ts header): filed returns are METADATA-ONLY, PERMANENTLY
// (rule 1); savingsFullAsset/savingsOxfordShare are hard-null, ALWAYS (rule 2) — this engine
// never invents a tax-savings dollar; firstYearAcceleration* is DEDUCTION TIMING, not tax
// dollars (rule 3). `buildCostSegTier` never claims a savings figure — impactUsd is the
// acceleration figure itself, and every item's detail says so explicitly. RESOLVED data-flow
// (mirrors useTaxAnalysis): TaxesModule calls useTaxStrategy() itself and threads the report
// down as a prop to StrategyBoard and FiledReturnsTable — neither component calls this hook.

export const TAX_STRATEGY_KEY = ['warehouse', 'tax', 'strategy'] as const;

/** Tax STRATEGY report (cost-seg/depreciation acceleration, qualitative entity strategies,
 *  filed-return metadata). Degrades gracefully on the static mirror (WarehouseUnavailableError
 *  → the Strategy Board's third tier and the Filed Returns tab render an informational empty
 *  state), same as every other warehouse-backed module. */
export function useTaxStrategy() {
  return useQuery({
    queryKey: TAX_STRATEGY_KEY,
    queryFn: () => fetchParsedOrMirror('/api/warehouse/tax/strategy', TaxStrategyReport),
    ...QUERY_OPTS,
  });
}

const PLACEHOLDER_DETAIL_TAX_BASE =
  'Synthetic filing metadata pending accountant records. Return contents never enter this system — ' +
  'metadata and SharePoint link-out only, by confidentiality design (cut-list C2).';

/** Advisory banner detail for the Filed Returns tab. Appends a dropped-row count when the
 *  fixture loader had to discard malformed rows, so a data-quality issue never disappears
 *  silently behind the fixed confidentiality-boundary sentence (mirrors
 *  insurance/hooks.ts's placeholderDetailInsurance). */
export function placeholderDetailTax(report: TaxStrategyReport): string {
  if (report.droppedFixtureRows > 0) {
    const rows = report.droppedFixtureRows === 1 ? 'row' : 'rows';
    return `${PLACEHOLDER_DETAIL_TAX_BASE} (${report.droppedFixtureRows} fixture ${rows} dropped.)`;
  }
  return PLACEHOLDER_DETAIL_TAX_BASE;
}

const COST_SEG_DETAIL =
  'Deduction acceleration (placeholder basis), not tax savings — converting to a tax dollar ' +
  'would require a marginal-rate assumption this system does not make.';

function costSegTierItem(o: CostSegOpportunity, rank: number, placeholder: boolean): TierItem {
  return {
    id: o.propertyId,
    rank,
    title: o.propertyName ?? o.propertyId,
    detail: COST_SEG_DETAIL,
    impactUsd: o.firstYearAccelerationOxfordShare,
    impactKind: 'info',
    chips: placeholder ? ['PLACEHOLDER'] : undefined,
  };
}

/**
 * Builds the Strategy Board's third, optional tier from the STRATEGY report — ranked by
 * firstYearAccelerationOxfordShare desc (nulls, i.e. indeterminate bonus-schedule years, sort
 * last — never a guessed $0). `impactUsd` is the deduction-ACCELERATION figure itself, never a
 * tax-savings dollar (contract rule 2/3) — every item's detail says so explicitly. The caller
 * (StrategyBoard) gates rendering on the report being present and not 'absent'-sourced — this
 * function itself never fabricates data when the report hasn't resolved.
 */
export function buildCostSegTier(report: TaxStrategyReport): Tier {
  const placeholder = report.basisDataSource === 'placeholder';
  const ranked = [...report.costSeg].sort(
    (a, b) => (b.firstYearAccelerationOxfordShare ?? -1) - (a.firstYearAccelerationOxfordShare ?? -1),
  );
  return {
    key: 'costseg',
    title: 'Depreciation & Cost-Seg',
    tone: 'accent',
    items: ranked.map((o, i) => costSegTierItem(o, i + 1, placeholder)),
  };
}
