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
// The slug bridge is direct: workbook parse.ts:124 produces `id = slug(name)`. For most
// properties the workbook name slugs to the same string as property_master.id; FVC and Solar
// use longer descriptive names that slug differently — RECONCILE_SLUG_ALIASES handles these (H4).
//
// Pure classifier + assembler at the top of the file; thin DB wrapper at the bottom for the
// gate / UI integration.

import type { Lease, PortfolioSnapshot } from '../../src/contracts/index';
import type { WarehouseDb } from './db';
import { latestFullYearPeriod, propertyPeriodMetrics, type PeriodMetrics } from './metrics';
import { PROPERTY_ALIASES } from './property-crosswalk';

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
  // OI-137 (2026-08-17): a large drift explained by ownership or tenancy changing since the
  // warehouse's latest-full-year comparison period is NOT an integrity break — Spine A (workbook,
  // current rent roll) and Spine B (warehouse, that period's historical actuals) are both correct;
  // they're answering different questions. Distinct from 'large-drift' so a genuine disagreement
  // still gates while a timing difference doesn't. Severity 'warn', not 'info' — still visible in
  // every report and count, just doesn't fail the gate.
  | 'structural-mismatch'
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
  /** Property.acqDate (ISO date), normalized to null when unknown/absent. Ownership-change signal
   *  for the structural-mismatch downgrade (OI-137) — an acquisition on/after the comparison
   *  period's start means the warehouse actuals may predate or only partially reflect ownership. */
  acqDate: string | null;
  /** Sum of CURRENT annualRent (Spine A) across this property's leases whose leaseStart falls on
   *  or after the warehouse FY comparison period's first day. Tenancy-change signal for the
   *  structural-mismatch downgrade (OI-137). Null only when there is no comparison period to
   *  evaluate leaseStart against (never null merely because no lease qualified — that's a real 0). */
  recentTenancyAnnualRent: number | null;
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

/**
 * Decides whether a large drift is plausibly explained by ownership or tenancy changing since the
 * warehouse's comparison period, rather than a genuine integrity break (OI-137). Returns the
 * evidence sentence to fold into the row's reason, or null when there isn't enough evidence.
 *
 *  - Tenancy alone: leases that started on or after the comparison period's first day contribute
 *    AT LEAST HALF of the drift's dollar magnitude to the current rent roll — large enough that
 *    their absence from that period's actuals plausibly explains most of the disagreement. Half,
 *    not "any", because a single small recent lease next to an otherwise-unexplained large gap is
 *    weak evidence of a structural cause and should not mask a real integrity break.
 *  - Ownership + tenancy corroboration: the property was acquired ON OR AFTER the comparison
 *    period's first day AND there is at least SOME rent-roll evidence of leasing activity since
 *    then (any nonzero recentTenancyAnnualRent, even below the tenancy-alone bar). A bare
 *    acquisition date is deliberately NOT sufficient on its own (adversarial-review finding,
 *    2026-08-17): without requiring corroboration, any same-sign large-drift at a newly-acquired
 *    property would be waved through indefinitely regardless of cause, masking exactly the kind of
 *    ingestion bug (duplicate rows, misattributed import, decimal error) most likely to go
 *    unnoticed at a property whose numbers are least familiar.
 *
 * Deliberately conservative: never fires on missing evidence (a null acqDate and a null/zero
 * recentTenancyAnnualRent prove nothing), and the caller must never invoke this when the two NOIs
 * disagree on sign — a profit-vs-loss disagreement is always a genuine concern regardless of
 * tenancy/ownership history. Known accepted residual risk (not closed by this function): the
 * "half the delta" tenancy bar is a proportionality heuristic, not a dollar-exact reconciliation —
 * an unrelated genuine drift sitting next to an even larger legitimate new lease at the SAME
 * property could still clear it. Gabriel ruled against normalizing the spines to close this
 * precisely (2026-08-17, OI-137 fix-shape decision); tightening further would re-open that choice.
 *
 * DIRECTION (2026-08-17 adversarial finding, financial-code integrity sweep): the tenancy-alone
 * rung's evidence sentence — "the warehouse actuals could not have collected that rent" — is only
 * coherent when the WORKBOOK exceeds the WAREHOUSE (delta > 0): new leases add rent Spine A
 * collects that Spine B's historical actuals predate. When the warehouse exceeds the workbook
 * (delta < 0), the same recent-lease evidence makes the disagreement MORE anomalous, not less — it
 * is the signature of a warehouse-side double-count or misattributed import, exactly the ingestion
 * bug this gate exists to catch. This rung is therefore gated on `delta > 0`. The ownership+tenancy
 * corroboration rung below stays bidirectional — partial-year blended actuals from a change in
 * ownership can plausibly cut either way.
 */
function detectStructuralMismatchReason(input: NoiReconcileInput, delta: number): string | null {
  const absDelta = Math.abs(delta);
  const periodYear = input.warehousePeriod?.slice(0, 4) ?? null;
  if (periodYear === null) return null; // nothing to compare acqDate/leaseStart against
  const periodStart = `${periodYear}-01-01`;

  const recentRent = input.recentTenancyAnnualRent;
  const hasAnyRecentTenancy = recentRent !== null && recentRent > 0;
  const acquiredSincePeriodStart = input.acqDate !== null && input.acqDate >= periodStart;

  if (delta > 0 && hasAnyRecentTenancy && recentRent! >= absDelta * 0.5) {
    return (
      `${formatUsd(recentRent!)}/yr of the current rent roll comes from leases starting on or after ` +
      `${periodStart} — at least half of the ${formatUsd(absDelta)} delta, so the ${periodYear} warehouse ` +
      `actuals could not have collected that rent.`
    );
  }

  if (acquiredSincePeriodStart && hasAnyRecentTenancy) {
    return (
      `Oxford acquired this property ${input.acqDate}, on or after the ${periodYear} comparison period ` +
      `began, and ${formatUsd(recentRent!)}/yr of the current rent roll comes from leases starting since ` +
      `then — the warehouse actuals may predate or only partially reflect Oxford ownership.`
    );
  }

  return null;
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

  // Warehouse-zero guard: a $0 warehouse NOI with a non-zero workbook value indicates the
  // warehouse has no committed P&L entries for this period (all entries net to $0). The absolute
  // band ($10k) was designed for genuine small-NOI near-matches, not for this structural gap —
  // a 100%-relative-delta would pass as in-tolerance without this guard.
  if (wh === 0 && wb !== 0) {
    return {
      ...baseRow,
      status: 'missing-from-warehouse',
      severity: 'warn',
      reason:
        'Warehouse oxfordNoi is $0 with a non-zero workbook NOI — warehouse may have no committed P&L for this period.',
    };
  }
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
  } else if (!signsConflict && (deltaPct <= tolerance.pctBand || (absDelta <= tolerance.absBandUsd && deltaPct < tolerance.largeDriftPct && Math.max(Math.abs(wb), Math.abs(wh)) <= tolerance.absBandUsd * 3))) {
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
    // OI-137: a sign-inverted disagreement is NEVER waved through by a tenancy/ownership
    // explanation — that explains a MAGNITUDE gap, not a profit-vs-loss flip, which points at a
    // parsing or classification defect. Only consulted when the signs agree.
    const structuralEvidence = signsConflict ? null : detectStructuralMismatchReason(input, delta);
    if (structuralEvidence !== null) {
      status = 'structural-mismatch';
      severity = 'warn';
      reason =
        `Structural mismatch, not an integrity break: ${direction} by ${(deltaPct * 100).toFixed(2)}% ` +
        `(${formatUsd(delta)}) — ${structuralEvidence} Spine A (workbook) reflects the current rent ` +
        `roll; Spine B (warehouse) reflects that period's historical actuals — neither is wrong. (OI-137)`;
    } else {
      status = 'large-drift';
      severity = 'error';
      reason =
        `Large drift: ${direction} by ${(deltaPct * 100).toFixed(2)}% (${formatUsd(delta)}) — ` +
        `workbook and warehouse materially disagree on NOI.${signNote}`;
    }
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
// the assembler. Workbook id = slug(name); RECONCILE_SLUG_ALIASES bridges the two properties
// where the workbook name slug diverges from the canonical property_master.id (H4).

// FVC and Solar slug-alias bridge: PROPERTY_ALIASES (property-crosswalk.ts) is the single
// source of truth for workbook-name → property_master.id slug corrections (H4).

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

  // OI-137: leases keyed by their WORKBOOK property id (Lease.propertyId === Property.id, set by
  // parse.ts's resolvePropertyId — see that function's callers). This is the pre-PROPERTY_ALIASES
  // id (wp.id below), never the warehouse-canonical id; the alias bridges workbook-name → warehouse
  // slug mismatches (H4) and is orthogonal to the lease-to-property link within the workbook.
  // `?? []` guards pre-OI-137 test/caller snapshots that never set `leases` at all.
  const leasesByPropertyId = new Map<string, Lease[]>();
  for (const l of snapshot.leases ?? []) {
    if (l.propertyId === null) continue;
    const arr = leasesByPropertyId.get(l.propertyId) ?? [];
    arr.push(l);
    leasesByPropertyId.set(l.propertyId, arr);
  }

  const inputs: NoiReconcileInput[] = [];
  for (const wp of snapshot.properties) {
    const canonicalId = PROPERTY_ALIASES[wp.id] ?? wp.id;
    const series = metricsByProperty.get(canonicalId) ?? [];
    const fyPeriod = latestFullYearPeriod(series);
    const fyRow = fyPeriod !== null ? series.find((m) => m.period === fyPeriod) ?? null : null;

    // OI-137 tenancy signal: sum CURRENT annualRent across leases that started on/after the FY
    // comparison period's first day. Null (not 0) when there is no FY period to compare against —
    // 0 is reserved for "we could compare, and nothing qualified."
    const periodYear = fyPeriod?.slice(0, 4) ?? null;
    const periodStart = periodYear !== null ? `${periodYear}-01-01` : null;
    const recentTenancyAnnualRent = periodStart !== null
      ? (leasesByPropertyId.get(wp.id) ?? [])
          // Also require the lease to be CURRENTLY in force (Active / Expiring Soon) — an Expired
          // or Vacant lease that started and already churned out within the comparison window is
          // no longer part of the current rent roll this signal is meant to represent, and must
          // not count as evidence for a drift it can no longer be causing (adversarial-review
          // finding, 2026-08-17).
          .filter((l) => l.leaseStart !== null && l.leaseStart >= periodStart && (l.status === 'Active' || l.status === 'Expiring Soon'))
          .reduce((sum, l) => sum + l.annualRent, 0)
      : null;

    inputs.push({
      propertyId: canonicalId,
      propertyName: wp.name,
      workbookOxfordNoi: Number.isFinite(wp.noi) ? wp.noi : null,
      warehouseOxfordNoi: fyRow ? fyRow.oxfordNoi : null,
      warehousePeriod: fyPeriod,
      warehouseBasis: fyRow ? fyRow.basis : null,
      isLeaseRun: financialModeById.get(canonicalId) === 'lease-run',
      isResidence: wp.type === 'Residence',
      acqDate: wp.acqDate ?? null,
      recentTenancyAnnualRent,
    });
  }

  // M3: emit a missing-from-workbook row for every warehouse propertyId absent from the workbook
  // spine — without this, warehouse-only properties escape reconciliation entirely.
  const coveredIds = new Set(inputs.map((i) => i.propertyId));
  for (const [pid, series] of metricsByProperty) {
    if (coveredIds.has(pid)) continue;
    const fyPeriod = latestFullYearPeriod(series);
    const fyRow = fyPeriod !== null ? series.find((m) => m.period === fyPeriod) ?? null : null;
    inputs.push({
      propertyId: pid,
      propertyName: series[0]?.propertyName ?? null,
      workbookOxfordNoi: null,
      warehouseOxfordNoi: fyRow ? fyRow.oxfordNoi : null,
      warehousePeriod: fyPeriod,
      warehouseBasis: fyRow ? fyRow.basis : null,
      isLeaseRun: financialModeById.get(pid) === 'lease-run',
      // Residential properties (e.g. Persimmon Drive) are never ingested into the warehouse —
      // they have no P&L files — so this path cannot fire for a residence under current invariants.
      // If property_master gains a `type` column (Pass 4), read it here instead.
      isResidence: false,
      // No workbook Property/Lease record exists on this path (warehouse-only) — no acqDate or
      // rent-roll data to derive OI-137's structural-mismatch signals from. Harmless: this row is
      // always 'missing-from-workbook' (workbookOxfordNoi is null above), never large-drift, so
      // detectStructuralMismatchReason is never invoked against it.
      acqDate: null,
      recentTenancyAnnualRent: null,
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
