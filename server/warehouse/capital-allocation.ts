// server/warehouse/capital-allocation.ts
//
// Phase 5 — Capital Allocation Capstone synthesis engine.
//
// buildCapitalAllocationReport(): pure synthesis — reads from existing engines/spines,
// never duplicates their math, never writes to DB or overlay.
//
// Data sources (read-only):
//   Spine A: PortfolioSnapshot (brain.getSnapshot()) → property NOI, SF, leases
//   scores.ts: scoreProperties() → per-property health, attentionBand, capitalAction
//   debt-scoring.ts: scoreDebtPositions() → per-property debtScore, DSCR
//   DB (debt_positions): soonest balloon months_to_maturity per property (not on DebtScore)
//   src/analytics/lease-forecast.ts: renewalSignals(), bucketExpiry() → leasing signals
//   server/macro/getMacro.ts: FRED macro context (fail-open)
//
// Priority score formula (financial-decision code — adversarial refute MANDATORY):
//   priorityScore = clamp(
//     (100 - healthScore) * 0.35
//     + attentionScore    * 0.30
//     + leasingRisk       * 0.20
//     + debtUrgency       * 0.15,
//     0, 100
//   )
//   Null health/attention → 50 (neutral, not 0 — avoids penalizing data-poor properties)
//   leasingRisk capped at 50 when noi=0 (vacant property guard)
//   debtUrgency=0 when no debt (balloonMonths === null)
//
// NOI basis: ALL NOI/SF figures are tagged noiBasis:'spine-a' (workbook ownership layer).
// NEVER mix with Spine-B warehouse ledger NOI — they are independent computations.
import type { WarehouseDb } from './db';
import { scoreProperties } from './scores';
import { scoreDebtPositions } from './debt-scoring';
import { propertyPeriodMetrics } from './metrics';
import { renewalSignals, bucketExpiry } from '../../src/analytics/lease-forecast';
import { getMacro } from '../macro/getMacro';
import type { PortfolioSnapshot } from '../../src/contracts/index';
import type { CapitalAllocationReport, CapitalAllocationEntry, MacroContext } from '../../src/contracts/capital-allocation';

// ── Internal helpers ───────────────────────────────────────────────────────────────────────

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * Map an attentionBand string to a numeric score for the priority formula.
 * null/undefined/unknown → 0 (green equivalent — conservative default)
 * This is an explicit mapping table, not a numeric conversion — never interpolate between bands.
 */
function attentionBandScore(band: string | null | undefined): number {
  if (band === 'red') return 100;
  if (band === 'orange') return 66;
  if (band === 'yellow') return 33;
  return 0; // 'green' or null/unknown → 0
}

// ── DB read: soonest balloon months_to_maturity per property ──────────────────────────────
// The DebtScore contract does not include balloon months_to_maturity — it was not needed for
// the debt scorecard but IS needed for the debtUrgencyComponent. Query it directly.
interface BalloonRow {
  property_id: string;
  months_to_maturity: number | null;
  dscr_override: number | null; // not used, dscr comes from DebtScore
}

/**
 * For each property with active debt, return the soonest months_to_maturity across all
 * its balloon loans. Null when a property has no active balloon loans (only term/demand).
 * demand notes (months_to_maturity = null) are excluded here — the DebtScore signal
 * handles them separately; for capital urgency we want the closest KNOWN expiry.
 */
function getBalloonMonthsByProperty(db: WarehouseDb): Map<string, number | null> {
  const rows = db
    .prepare(
      `SELECT property_id,
              MIN(months_to_maturity) AS months_to_maturity
       FROM debt_positions
       WHERE status = 'active'
         AND balloon = 1
         AND property_id IS NOT NULL
         AND months_to_maturity IS NOT NULL
       GROUP BY property_id`,
    )
    .all() as BalloonRow[];

  const result = new Map<string, number | null>();
  for (const row of rows) {
    if (row.property_id !== null) {
      result.set(row.property_id, row.months_to_maturity);
    }
  }
  return result;
}

// ── Main synthesis function ────────────────────────────────────────────────────────────────

/**
 * Build the Capital Allocation Report by synthesizing all existing intelligence streams.
 *
 * @param db - Warehouse DB connection (Spine B — used ONLY for scores + debt queries)
 * @param snapshot - Current Spine A portfolio snapshot (source for NOI, SF, leases)
 * @returns CapitalAllocationReport sorted DESC by priorityScore
 */
export async function buildCapitalAllocationReport(
  db: WarehouseDb,
  snapshot: PortfolioSnapshot,
): Promise<CapitalAllocationReport> {
  const asOf = snapshot.meta.asOf;

  // ── 1. Macro context (fail-open) ──────────────────────────────────────────────────────
  let macro: MacroContext;
  try {
    const live = await getMacro();
    const dgs10 = live.indicators.find((ind) => ind.id === 'DGS10');
    const cpi = live.indicators.find((ind) => ind.id === 'CPIAUCSL');
    macro = {
      tenYearRate: dgs10?.value ?? null,
      cpi: cpi?.value ?? null,
      source: (live.source === 'fred' || live.source === 'mock') ? live.source : 'mock',
      asOf: live.asOf ?? null,
    };
  } catch {
    macro = { tenYearRate: null, cpi: null, source: 'mock', asOf: null };
  }

  // ── 2. Property scores (health/attention/capitalAction) ───────────────────────────────
  const metrics = propertyPeriodMetrics(db);
  const scores = scoreProperties(db, metrics);
  const scoreByPropertyId = new Map(scores.map((s) => [s.propertyId, s]));

  // ── 3. Debt scores (DSCR, score) — market rate null (fail-safe, per spec) ─────────────
  const debtScores = scoreDebtPositions(db, metrics, null);
  const debtByPropertyId = new Map(debtScores.map((d) => [d.propertyId, d]));

  // ── 4. Balloon months_to_maturity per property (direct DB read) ───────────────────────
  const balloonMonthsByProperty = getBalloonMonthsByProperty(db);

  // ── 5. Leasing signals per property ───────────────────────────────────────────────────
  const arrears = snapshot.tenantArrears ?? {};
  const renewalStages = snapshot.renewalStages ?? {};
  const signals = renewalSignals(snapshot.leases, asOf, renewalStages, arrears);

  // Index signals by propertyId for O(1) lookup (RenewalSignal.propertyId is nullable — skip nulls)
  const signalsByProperty = new Map<string, typeof signals>();
  for (const sig of signals) {
    if (sig.propertyId === null) continue;
    const arr = signalsByProperty.get(sig.propertyId) ?? [];
    arr.push(sig);
    signalsByProperty.set(sig.propertyId, arr);
  }

  // ── 6. Per-property near-term expiry rent (≤12m buckets) and at-risk counts ─────────
  // nearTermExpiryRent: sum annualRent for leases in '0-6m' or '6-12m' expiry buckets
  // Lease.propertyId is nullable — skip unmatched leases
  const nearTermExpiryRentByProperty = new Map<string, number>();
  for (const lease of snapshot.leases) {
    if (lease.propertyId === null) continue;
    const bucket = bucketExpiry(lease.monthsToExpiry, lease.leaseEnd, asOf);
    if (bucket === '0-6m' || bucket === '6-12m') {
      const existing = nearTermExpiryRentByProperty.get(lease.propertyId) ?? 0;
      nearTermExpiryRentByProperty.set(lease.propertyId, existing + lease.annualRent);
    }
  }

  // atRiskLikelihoodCount: count of signals where likelihood is 'at-risk' or 'lapsing'
  // RenewalSignal.propertyId is nullable — skip nulls
  const atRiskCountByProperty = new Map<string, number>();
  for (const sig of signals) {
    if (sig.propertyId === null) continue;
    if (sig.likelihood === 'at-risk' || sig.likelihood === 'lapsing') {
      const existing = atRiskCountByProperty.get(sig.propertyId) ?? 0;
      atRiskCountByProperty.set(sig.propertyId, existing + 1);
    }
  }

  // ── 7. Build entries for each Spine A property ──────────────────────────────────────
  const entries: CapitalAllocationEntry[] = [];

  for (const property of snapshot.properties) {
    const propScore = scoreByPropertyId.get(property.id);
    const debtScore = debtByPropertyId.get(property.id);
    const balloonMonths = balloonMonthsByProperty.get(property.id) ?? null;

    // Spine A NOI + SF (Property contract: noi is always number, sf is nonnegative)
    const noi = property.noi;
    const sf = property.sf;
    const noiPerSf = sf > 0 && noi !== 0 ? noi / sf : null;

    // Health/attention from scores.ts (null when no warehouse data for this property)
    // Per spec (Phase 5 docs line 76/133): null -> 50 neutral, never 0
    const healthScore = propScore?.health ?? null;
    const attentionBand = propScore?.attentionBand ?? null;
    const attentionScore = attentionBand === null ? 50 : attentionBandScore(attentionBand);
    const capitalAction = propScore?.capitalAction ?? 'hold';

    // Leasing
    const nearTermExpiryRent = nearTermExpiryRentByProperty.get(property.id) ?? 0;
    const atRiskLikelihoodCount = atRiskCountByProperty.get(property.id) ?? 0;

    // Debt — null when no active debt for this property
    const hasDebt = debtScore !== undefined && debtScore.signal !== 'no-debt';
    const debtScoreValue = hasDebt ? debtScore!.score : null;
    const dscr = hasDebt ? debtScore!.dscr : null;
    const effectiveBalloonMonths = hasDebt ? balloonMonths : null;

    // ── Priority score formula ─────────────────────────────────────────────────────────
    const healthVal = healthScore ?? 50;

    const leasingRisk =
      noi > 0
        ? Math.min(100, (nearTermExpiryRent / noi) * 100 + atRiskLikelihoodCount * 10)
        : Math.min(50, atRiskLikelihoodCount * 10);

    // Decouple DSCR penalty from balloon presence: a term loan (balloon=0, schema default) with sub-governor
    // DSCR should still flag as high-urgency capital. Gate on hasDebt, not on balloon row existence.
    const debtUrgency = !hasDebt
      ? 0
      : clamp(
          (effectiveBalloonMonths === null ? 0 : Math.max(0, 100 - (effectiveBalloonMonths / 12) * 10)) +
            (dscr !== null && dscr < 1.25 ? 30 : 0),
          0,
          100,
        );

    const raw = (100 - healthVal) * 0.35 + attentionScore * 0.30 + leasingRisk * 0.20 + debtUrgency * 0.15;
    const priorityScore = Math.max(0, Math.min(100, raw));

    // ── Rationale (top 3 factors by impact) ──────────────────────────────────────────
    const reasons: Array<{ text: string; impact: number }> = [];

    if (effectiveBalloonMonths !== null && effectiveBalloonMonths < 24) {
      reasons.push({
        text: `Balloon maturity in ${Math.round(effectiveBalloonMonths)} months`,
        impact: debtUrgency * 0.15,
      });
    }
    if (dscr !== null && dscr < 1.25) {
      reasons.push({
        text: `DSCR at ${dscr.toFixed(2)} (below 1.25x governor)`,
        impact: 30 * 0.15,
      });
    }
    if (nearTermExpiryRent > 0 && noi > 0 && nearTermExpiryRent / noi > 0.2) {
      reasons.push({
        text: `${Math.round((nearTermExpiryRent / noi) * 100)}% of NOI expiring ≤12 months`,
        impact: leasingRisk * 0.20,
      });
    }
    if (atRiskLikelihoodCount > 0) {
      reasons.push({
        text: `${atRiskLikelihoodCount} at-risk/lapsing renewal signal${atRiskLikelihoodCount > 1 ? 's' : ''}`,
        impact: atRiskLikelihoodCount * 10 * 0.20,
      });
    }
    if (healthScore !== null && healthScore < 50) {
      reasons.push({
        text: `Health score ${Math.round(healthScore)}/100`,
        impact: (100 - healthVal) * 0.35,
      });
    }
    if (attentionBand !== null && (attentionBand === 'orange' || attentionBand === 'red')) {
      reasons.push({
        text: `Attention band: ${attentionBand}`,
        impact: attentionScore * 0.30,
      });
    }

    reasons.sort((a, b) => b.impact - a.impact);
    const rationale = reasons.slice(0, 3).map((r) => r.text);

    entries.push({
      propertyId: property.id,
      propertyName: property.name ?? null,
      market: property.market ?? null,
      sf,
      capitalAction,
      priorityScore,
      healthScore,
      attentionScore: attentionBand !== null ? attentionScore : null,
      nearTermExpiryRent,
      atRiskLikelihoodCount,
      debtScore: debtScoreValue,
      balloonMonths: effectiveBalloonMonths,
      dscr,
      rationale,
      noi,
      noiPerSf,
      noiBasis: 'spine-a',
    });
  }

  // Sort DESC by priorityScore (highest urgency first), with deterministic tiebreaker on propertyId
  // to avoid order-dependence on workbook row order when scores tie (common case: all healthy -> 0, all distressed -> 100)
  entries.sort((a, b) => b.priorityScore - a.priorityScore || a.propertyId.localeCompare(b.propertyId));

  // ── 8. Aggregate counts ──────────────────────────────────────────────────────────────
  const investCount = entries.filter((e) => e.capitalAction === 'invest').length;
  const holdCount = entries.filter((e) => e.capitalAction === 'hold').length;
  const monitorCount = entries.filter((e) => e.capitalAction === 'monitor').length;
  const dispositionCount = entries.filter((e) => e.capitalAction === 'disposition-candidate').length;
  const portfolioNoi = snapshot.properties.reduce((sum, p) => sum + (p.noi ?? 0), 0);

  return {
    asOf,
    propertyCount: snapshot.properties.length,
    entries,
    portfolioNoi,
    portfolioNoBasis: 'spine-a',
    investCount,
    holdCount,
    monitorCount,
    dispositionCount,
    macro,
  };
}
