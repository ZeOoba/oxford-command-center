// server/warehouse/reconcile-noi.ts
//
// PFI Phase 1c — A↔B NOI reconciliation. The master plan's Revision-1 keystone: tie out the
// workbook's Property.noi (Spine A, the live current-state spine, Oxford-share) against the
// warehouse's oxfordNoi (Spine B, the time dimension) at the property's latest full-year period.
//
// Why Oxford-share-to-Oxford-share: Both sides already carry the ownership overlay. The workbook
// reports Oxford-share NOI directly (50%/25% applied at source); the warehouse computes
// oxfordNoi = noi × ownershipPct in metrics.ts. Comparing 100%-basis warehouse NOI to
// Oxford-share workbook NOI on a 50%-owned property would manufacture a 50% phantom drift —
// the bug this reconciliation exists to catch in the OTHER spine.
//
// The slug bridge is direct: workbook parse.ts:124 produces `id = slug(name)`, and
// property_master.id is the same canonical slug. No alias table needed (verified 2026-06-13).
//
// Pure classifier + assembler at the top of the file; thin DB wrapper at the bottom for the
// gate / UI integration.

import type { PortfolioSnapshot } from '../../src/contracts/index';
import type { WarehouseDb } from './db';
import { latestFullYearPeriod, propertyPeriodMetrics, type PeriodMetrics } from './metrics';

export interface Tolerance {
  /** Relative band: |delta| / max(|wbNoi|, |whNoi|) ≤ pctBand ⇒ in-tolerance. */
  pctBand: number;
  /** Absolute band ($): |delta| ≤ absBandUsd ⇒ in-tolerance (protects small-NOI properties). */
  absBandUsd: number;
  /** Threshold at or above which the row is large-drift (error severity): deltaPct ≥ largeDriftPct. */
  largeDriftPct: number;
}

export const DEFAULT_TOLERANCE: Tolerance = {
  pctBand: 0.05,
  absBandUsd: 10000,
  largeDriftPct: 0.20,
};

export type NoiReconciliationStatus =
  | 'match'
  | 'in-tolerance'
  | 'drift'
  | 'large-drift'
  | 'missing-from-workbook'
  | 'missing-from-warehouse'
  | 'lease-run-skipped'
  // Both spines report null — e.g., a newly-acquired property pre-ingest. Not a defect; nothing
  // is actually missing FROM either spine. Severity info so dashboards don't triage to the
  // wrong spine (the prior 'missing-from-workbook' label confused readers).
  | 'no-data';

export type NoiReconciliationSeverity = 'info' | 'warn' | 'error';

export interface NoiReconcileInput {
  propertyId: string;
  propertyName: string | null;
  workbookOxfordNoi: number | null;
  warehouseOxfordNoi: number | null;
  warehousePeriod: string | null;
  warehouseBasis: string | null;
  isLeaseRun: boolean;
  isResidence: boolean;
}

export interface NoiReconciliationRow {
  propertyId: string;
  propertyName: string | null;
  period: string | null;
  workbookOxfordNoi: number | null;
  warehouseOxfordNoi: number | null;
  delta: number | null;   // workbook − warehouse (sign preserved; Oxford-share dollars)
  deltaPct: number | null; // |delta| / max(|wb|, |wh|) — always non-negative
  basis: string;          // warehouse basis at the FY period; 'unknown' when not available
  status: NoiReconciliationStatus;
  severity: NoiReconciliationSeverity;
  reason: string;
}

function formatUsd(n: number): string {
  return (n < 0 ? '-' : '') + '$' + Math.round(Math.abs(n)).toLocaleString();
}

/** Pure classifier: takes one property's tie-out inputs, returns one row. */
export function classifyNoiReconciliation(
  input: NoiReconcileInput,
  tolerance: Tolerance,
): NoiReconciliationRow {
  const basis = input.warehouseBasis ?? 'unknown';
  const baseRow: NoiReconciliationRow = {
    propertyId: input.propertyId,
    propertyName: input.propertyName,
    period: input.warehousePeriod,
    workbookOxfordNoi: input.workbookOxfordNoi,
    warehouseOxfordNoi: input.warehouseOxfordNoi,
    delta: null,
    deltaPct: null,
    basis,
    status: 'match',
    severity: 'info',
    reason: '',
  };

  // Lease-run properties (Fishel, Sunburst — ratified 2026-06-12): no real P&L; not a defect.
  if (input.isLeaseRun) {
    return {
      ...baseRow,
      status: 'lease-run-skipped',
      severity: 'info',
      reason: 'Property runs off master lease with estimated capex — no warehouse P&L expected by ratification.',
    };
  }

  // Missing branches first — never compute a delta when either side is null.
  if (input.workbookOxfordNoi !== null && input.warehouseOxfordNoi === null) {
    return {
      ...baseRow,
      status: 'missing-from-warehouse',
      severity: 'warn',
      reason: input.warehousePeriod === null
        ? 'Warehouse has no full-year period for this property — cannot tie out an annual workbook NOI against a partial period.'
        : 'Warehouse oxfordNoi is null for the full-year period — cannot tie out.',
    };
  }
  if (input.workbookOxfordNoi === null && input.warehouseOxfordNoi !== null) {
    return {
      ...baseRow,
      status: 'missing-from-workbook',
      severity: 'warn',
      reason: 'Workbook Property.noi is null — cannot tie out.',
    };
  }
  if (input.workbookOxfordNoi === null && input.warehouseOxfordNoi === null) {
    return {
      ...baseRow,
      status: 'no-data',
      severity: 'info',
      reason: 'Neither spine reports an NOI value for this property — likely a newly-acquired property pre-ingest.',
    };
  }

  // Both present — compute delta and classify by tolerance.
  const wb = input.workbookOxfordNoi!;
  const wh = input.warehouseOxfordNoi!;
  const delta = wb - wh;
  const absDelta = Math.abs(delta);
  const denom = Math.max(Math.abs(wb), Math.abs(wh));
  const deltaPct = denom === 0 ? 0 : absDelta / denom;

  // Sign-parity guard: both non-zero with opposite signs = one spine shows profit, the other a loss.
  // The absolute floor ($10k) was designed for same-sign small-NOI drift; it must not silently
  // reconcile a profit-vs-loss disagreement between the spines.
  const signsConflict = wb !== 0 && wh !== 0 && Math.sign(wb) !== Math.sign(wh);

  let status: NoiReconciliationStatus;
  let severity: NoiReconciliationSeverity;
  let reason: string;

  if (delta === 0) {
    status = 'match';
    severity = 'info';
    reason = 'Workbook NOI ties out exactly to warehouse oxfordNoi.';
  } else if (!signsConflict && (deltaPct <= tolerance.pctBand || absDelta <= tolerance.absBandUsd)) {
    status = 'in-tolerance';
    severity = 'info';
    reason =
      `Delta ${formatUsd(delta)} (${(deltaPct * 100).toFixed(2)}%) is within tolerance ` +
      `(±${(tolerance.pctBand * 100).toFixed(0)}% or ±${formatUsd(tolerance.absBandUsd)}).`;
  } else if (deltaPct < tolerance.largeDriftPct) {
    const direction = wb > wh
      ? 'Workbook NOI exceeds warehouse oxfordNoi'
      : 'Warehouse oxfordNoi exceeds workbook NOI';
    const signNote = signsConflict
      ? ' Sign inversion: the spines disagree on profit vs loss.'
      : '';
    status = 'drift';
    severity = 'warn';
    reason =
      `Drift: ${direction} by ${(deltaPct * 100).toFixed(2)}% (${formatUsd(delta)}) — ` +
      `above tolerance but below large-drift threshold.${signNote}`;
  } else {
    const direction = wb > wh
      ? 'Workbook NOI exceeds warehouse oxfordNoi'
      : 'Warehouse oxfordNoi exceeds workbook NOI';
    const signNote = signsConflict
      ? ' Sign inversion: the spines disagree on profit vs loss.'
      : '';
    status = 'large-drift';
    severity = 'error';
    reason =
      `Large drift: ${direction} by ${(deltaPct * 100).toFixed(2)}% (${formatUsd(delta)}) — ` +
      `workbook and warehouse materially disagree on NOI.${signNote}`;
  }

  // Basis-unknown downgrade (Phase 1a discipline): a 'match' on basis='unknown' is low-confidence
  // (the comparison isn't proven like-for-like), so info → warn even when the values agree.
  if (basis === 'unknown' && severity === 'info' && (status === 'match' || status === 'in-tolerance')) {
    severity = 'warn';
    reason = reason + ' Basis unknown (header parse miss) — comparison is low-confidence.';
  }

  return { ...baseRow, delta, deltaPct, status, severity, reason };
}

/** Assembler: filter residences, classify every other input, stable-sort by propertyId. */
export function reconcileNoiAB(
  inputs: ReadonlyArray<NoiReconcileInput>,
  tolerance: Tolerance = DEFAULT_TOLERANCE,
): NoiReconciliationRow[] {
  const out: NoiReconciliationRow[] = [];
  for (const input of inputs) {
    if (input.isResidence) continue;
    out.push(classifyNoiReconciliation(input, tolerance));
  }
  return out.sort((a, b) => a.propertyId.localeCompare(b.propertyId));
}

// ── DB wrapper ────────────────────────────────────────────────────────────────
//
// The pure functions above don't touch the DB or workbook. This wrapper joins the workbook
// snapshot (Spine A) and the warehouse period_metrics (Spine B) by property slug, then invokes
// the assembler. Workbook id = slug(name) and property_master.id is the same canonical slug
// (verified 2026-06-13), so no alias map is required.

/** Build reconciliation inputs from the live workbook snapshot + warehouse periodMetrics. */
export function buildNoiReconcileInputs(
  snapshot: PortfolioSnapshot,
  periodMetrics: PeriodMetrics[],
  propertyMaster: ReadonlyArray<{ id: string; financialMode: string }>,
): NoiReconcileInput[] {
  const metricsByProperty = new Map<string, PeriodMetrics[]>();
  for (const m of periodMetrics) {
    const arr = metricsByProperty.get(m.propertyId) ?? [];
    arr.push(m);
    metricsByProperty.set(m.propertyId, arr);
  }
  const financialModeById = new Map<string, string>();
  for (const p of propertyMaster) financialModeById.set(p.id, p.financialMode);

  const inputs: NoiReconcileInput[] = [];
  for (const wp of snapshot.properties) {
    const series = metricsByProperty.get(wp.id) ?? [];
    const fyPeriod = latestFullYearPeriod(series);
    const fyRow = fyPeriod !== null ? series.find((m) => m.period === fyPeriod) ?? null : null;
    inputs.push({
      propertyId: wp.id,
      propertyName: wp.name,
      workbookOxfordNoi: Number.isFinite(wp.noi) ? wp.noi : null,
      warehouseOxfordNoi: fyRow ? fyRow.oxfordNoi : null,
      warehousePeriod: fyPeriod,
      warehouseBasis: fyRow ? fyRow.basis : null,
      isLeaseRun: financialModeById.get(wp.id) === 'lease-run',
      isResidence: wp.type === 'Residence',
    });
  }
  return inputs;
}

/** End-to-end DB-driven reconciliation (production callable). */
export function reconcileNoiABFromDb(
  db: WarehouseDb,
  snapshot: PortfolioSnapshot,
  tolerance: Tolerance = DEFAULT_TOLERANCE,
): NoiReconciliationRow[] {
  const periodMetrics = propertyPeriodMetrics(db);
  const propertyMaster = db.prepare(
    `SELECT id, financial_mode AS financialMode FROM property_master`,
  ).all() as Array<{ id: string; financialMode: string }>;
  const inputs = buildNoiReconcileInputs(snapshot, periodMetrics, propertyMaster);
  return reconcileNoiAB(inputs, tolerance);
}
