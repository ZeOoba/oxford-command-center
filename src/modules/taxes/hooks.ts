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
import type { BadgeTone } from '@/primitives/Badge';

export type { TaxAnalysisReport, TaxAppeal, TaxAppealInput, TaxAppealStatus, TaxOpportunity, TaxAssessment };

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
