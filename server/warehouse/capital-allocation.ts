// server/warehouse/capital-allocation.ts
//
// Phase 5 — Capital Allocation Engine
//
// buildPortfolioAllocation(): pure async fn — loads PropertyScore + DebtScore for every
// active property, maps each to a per-asset AllocationVerdict (hold/sell/refi/improve→hold),
// loads acq pipeline candidates, appends at most one portfolio-level buy verdict (C-3), and
// returns PortfolioAllocation.
//
// Per-asset verdict priority (first match wins):
//   sell       → capitalAction === 'disposition-candidate'
//   refinance  → debtSignal in ('refi' | 'cash-out') AND a drivable refiCashSavingsPct (C-2)
//   improve→hold → capitalAction === 'invest'  (capexIrr estimate deferred to Phase 4 v2)
//   hold       → default (monitor, governor-block, no-debt)
//
// buy (C-3): portfolio-level, not per-asset — emitted only when the acq pipeline has a
// T1/T2 candidate clearing the composite + basis-discount floors (§3.5); never on an
// empty buyable list.
//
// advisoryOnly = true until hurdle rate is ratified (Phase 5 default).
// forecastInputs absent → horizonPeriods=0, confidence01 capped at 0.65.

import { getMacro } from '../macro/getMacro';
import { getMacroMarketBenchmarks } from '../macro/market-benchmarks';
import { getRegionalMacro } from '../macro/regional-macro';
import { propertyPeriodMetrics } from './metrics';
import { scoreProperties } from './scores';
import { scoreDebtPositions } from './debt-scoring';
import { clamp } from './clamp';
import { loadCapitalConfig } from './capital-config';
import { loadGovernors } from './governors';
import { renewalSignals, bucketExpiry } from '../../src/analytics/lease-forecast';
import { classifyCapRateBand, benchmarkKey } from '../../src/contracts/market-intelligence';
import type { CapRateBenchmark, MarketBenchmarkSet } from '../../src/contracts/market-intelligence';
import type { WarehouseDb } from './db';
import type { HealthBand } from '../../src/contracts/warehouse';
import type { DebtScore } from '../../src/contracts/debt';
import type {
  AllocationVerdict,
  PortfolioAllocation,
  RiskBand,
  AllocationAction,
} from '../../src/contracts/capital';
import type { Confidence } from '../../src/contracts/common';
import type { PortfolioSnapshot } from '../../src/contracts/index';
import type {
  CapitalAllocationReport,
  CapitalAllocationEntry,
  MacroContext,
} from '../../src/contracts/capital-allocation';
import type { RegionalMacroSnapshot } from '../../src/contracts/regional-macro';

// ── Helpers ───────────────────────────────────────────────────────────────────

function healthBandToRisk(band: HealthBand): RiskBand {
  const map: Record<HealthBand, RiskBand> = {
    'excellent': 'low',
    'good': 'moderate',
    'watch': 'elevated',
    'concern': 'high',
  };
  return map[band];
}

function confidenceTierFrom(c01: number): Confidence {
  return c01 >= 0.8 ? 'confirmed' : c01 >= 0.5 ? 'estimated' : 'derived';
}

// ── C-3: portfolio-level buy verdict (spec §3.5) ─────────────────────────────
//
// A buy verdict is NOT tied to an owned property, so it cannot honestly populate
// AllocationVerdict.inputs (healthBand/attentionBand/capitalAction/debtSignal/
// debtScoreBand are all required enums designed for scored, owned properties).
// Per Gabriel's decision (2026-07-07): use documented neutral placeholders rather
// than extend the schema, with an explicit reasons[] note that these fields are
// not applicable to a pipeline acquisition candidate.
const BUY_COMPOSITE_FLOOR = 70;
const BASIS_DISCOUNT_FLOOR = 0.05; // [RATIFY] 5% all-in basis discount vs replacement cost

function buildBuyVerdict(
  candidate: PortfolioAllocation['pipeline'][number],
  asOf: string,
  hurdleRatePct: number,
  advisoryOnly: boolean,
  forecastInputs: { periods: number } | undefined,
): AllocationVerdict {
  // PHASE 5 v2 DEFERRAL (C-4): expectedReturnFor('buy', ...) is not yet wired —
  // stays null on this verdict, same convention as every other action in v1/v2.
  const expectedReturnPct: number | null = null;
  const returnAboveHurdle = expectedReturnPct !== null ? expectedReturnPct >= hurdleRatePct : null;

  let confidence01 = 0.80;
  if (forecastInputs === undefined) confidence01 = Math.min(confidence01, 0.65);
  confidence01 = Math.max(0.10, confidence01);

  // A null basisDiscountPct passes the buyable gate (spec §3.5), but null is indistinguishable
  // between "genuinely not applicable" and "the acquisition score never computed it" — surface
  // that ambiguity rather than letting it silently disappear once the gate has passed.
  const dataQuality =
    candidate.basisDiscountPct === null
      ? [
          {
            entity: candidate.candidateId,
            field: 'basisDiscountPct',
            issue: 'basisDiscountPct is null for the top-ranked buyable candidate — the buyable gate treats null as passing, but null cannot distinguish "genuinely no discount data expected" from an acquisition score that never computed this field.',
            severity: 'warn' as const,
          },
        ]
      : [];

  return {
    propertyId: `pipeline:${candidate.candidateId}`,
    propertyName: candidate.address,
    period: asOf,
    action: 'buy',
    expectedReturnPct,
    returnAboveHurdle,
    riskBand: candidate.tier === 'T1' ? 'moderate' : 'elevated',
    timelineMonths: 6, // spec TIMELINE table: buy = 6 (pipeline-dependent placeholder)
    horizonPeriods: forecastInputs?.periods ?? 0,
    confidence01,
    confidenceTier: confidenceTierFrom(confidence01),
    advisoryOnly,
    reasons: [
      `Portfolio buy signal: pipeline candidate ${candidate.candidateId} (tier ${candidate.tier ?? 'unknown'}, composite ${candidate.composite ?? 'unknown'})`,
      'inputs fields (healthBand/attentionBand/capitalAction/debtSignal/debtScoreBand/dscr/ltv/noiPerSf) are not applicable to a pipeline acquisition candidate — neutral placeholder values, not measured data',
    ],
    inputs: {
      healthBand: 'good',
      attentionBand: 'green',
      capitalAction: 'hold',
      debtSignal: 'no-debt',
      debtScoreBand: 'strong',
      dscr: null,
      dscrHeadroom: null,
      ltv: null,
      noiPerSf: null,
      forecastPresent: forecastInputs !== undefined,
    },
    dataQuality,
  };
}

// ── Verdict builder for one property ─────────────────────────────────────────

import type { PropertyScore } from '../../src/contracts/warehouse';

function buildVerdict(
  ps: PropertyScore,
  ds: DebtScore | null,
  hurdleRatePct: number,
  advisoryOnly: boolean,
  forecastInputs: { periods: number } | undefined,
): AllocationVerdict {
  const debtSignal = ds?.signal ?? 'no-debt';
  const debtScoreBand = ds?.scoreBand ?? 'adequate';
  const dscr = ds?.dscr ?? null;
  const dscrHeadroom = ds?.dscrHeadroom ?? null;
  const ltv = ds?.ltv ?? null;

  // Horizon periods
  const horizonPeriods = forecastInputs?.periods ?? 0;

  // Confidence: base 0.6 when both PropertyScore + DebtScore present; boost capped at 0.65/0.85
  const baseConf = (ds !== null) ? 0.6 : 0.45;
  const subBoost = Math.min(0.05, Object.keys(ps.subScores).length * 0.01);
  const rawConf = baseConf + subBoost;
  const confCap = forecastInputs !== undefined ? 0.85 : 0.65;
  const confidence01 = Math.min(rawConf, confCap);
  const confidenceTier = confidenceTierFrom(confidence01);

  // Action priority (first match wins)
  let action: AllocationAction;
  let riskBand: RiskBand;
  // PHASE 5 v2 DEFERRAL (C-4): expectedReturnPct math is not implemented in v1 —
  // it stays null on every branch, which forces returnAboveHurdle null (see below).
  let expectedReturnPct: number | null = null;
  let timelineMonths = 0;
  const reasons: string[] = [...ps.reasons];

  // C-2: refinance additionally requires a drivable post-refi cash-savings computation
  // (spec §3.2 rule 2 — refiCashSavingsPct(d) !== null). Undrivable savings falls through
  // to the next rule (improve/hold) rather than emitting refinance on signal alone.
  const refiSignalPresent = debtSignal === 'refi' || debtSignal === 'cash-out';
  const refiEligible = refiSignalPresent && ds?.refiCashSavingsPct !== null && ds?.refiCashSavingsPct !== undefined;
  if (refiSignalPresent && !refiEligible) {
    reasons.push('Refinance deferred: post-refi cash-savings undrivable (rate, LTV, or balance data insufficient)');
  }

  if (ps.capitalAction === 'disposition-candidate' && ps.healthBand === 'concern') {
    // 1. sell — financial-safety: require BOTH the disposition-candidate capitalAction
    //    AND an independent healthBand==='concern' confirmation at the verdict layer.
    //    Guards against a future scores.ts relaxation emitting disposition-candidate
    //    on a non-distressed property (latent false-positive sell risk).
    action = 'sell';
    riskBand = 'high';
    expectedReturnPct = null;
    timelineMonths = 9; // see I-2 (spec TIMELINE)
    reasons.push('Capital action: disposition-candidate + healthBand: concern');
  } else if (refiEligible) {
    // 2. refinance (governor-block signal falls to hold per priority 4; it cannot match here)
    action = 'refinance';
    riskBand =
      debtScoreBand === 'strong' ? 'low' :
      debtScoreBand === 'adequate' ? 'moderate' :
      'elevated';
    expectedReturnPct = null;
    timelineMonths = 4; // see I-2 (spec TIMELINE)
    reasons.push(`Debt signal: ${debtSignal}`);
    // PHASE 5 v2 DEFERRAL (C-4): expectedReturnPct for refinance (= refiCashSavingsPct)
    // is wired up separately — this rule only gates action selection.
  } else if (ps.capitalAction === 'invest') {
    // 3. improve → degrades to hold in Phase 5 (capexIrr estimate deferred to Phase 4 v2)
    action = 'hold';
    riskBand = healthBandToRisk(ps.healthBand);
    expectedReturnPct = null;
    timelineMonths = 0;
    reasons.push('improve deferred: capexIrr estimate requires Phase 4 v2 data');
  } else {
    // 4. hold (default — handles monitor, governor-block, no-debt)
    // timelineMonths=0: Phase 5 defers a concrete hold timeline (Phase 5 v2 will set 12 months)
    action = 'hold';
    riskBand = healthBandToRisk(ps.healthBand);
    expectedReturnPct = null;
    timelineMonths = 0;
  }

  const returnAboveHurdle =
    expectedReturnPct !== null ? expectedReturnPct >= hurdleRatePct : null;

  // Deferred-state flags added to reasons for transparency
  if (!forecastInputs) {
    reasons.push('Forecast inputs absent: confidence01 capped at 0.65, horizonPeriods=0');
  }
  if (advisoryOnly) {
    reasons.push('advisoryOnly: hurdle rate ratification pending');
  }

  // noiPerSf: not directly available from PropertyScore in this engine layer
  const noiPerSf: number | null = null;

  return {
    propertyId: ps.propertyId,
    propertyName: ps.propertyName,
    period: ps.period,
    action,
    expectedReturnPct,
    returnAboveHurdle,
    riskBand,
    timelineMonths,
    horizonPeriods,
    confidence01,
    confidenceTier,
    advisoryOnly,
    reasons,
    inputs: {
      healthBand: ps.healthBand,
      attentionBand: ps.attentionBand,
      capitalAction: ps.capitalAction,
      debtSignal,
      debtScoreBand,
      dscr,
      dscrHeadroom,
      ltv,
      noiPerSf,
      forecastPresent: forecastInputs !== undefined,
    },
    dataQuality: [],
  };
}

// ── Pipeline candidates ───────────────────────────────────────────────────────

interface AcqCandRow {
  id: string;
  address: string | null;
  market: string | null;
  status: string;
}

interface AcqScoreRow {
  candidate_id: string;
  composite: number;
  tier: string;
  score_json: string | null;
}

import { ClusterTier } from '../../src/contracts/acquisition';

function loadPipelineCandidates(db: WarehouseDb): PortfolioAllocation['pipeline'] {
  const candidates = db.prepare(
    `SELECT id, address, market, status FROM acq_candidates WHERE status = 'active'`,
  ).all() as AcqCandRow[];

  // Hoist prepared statement outside the map loop (Fix A-2)
  const latestScoreStmt = db.prepare(
    `SELECT candidate_id, composite, tier, score_json
     FROM acq_scores WHERE candidate_id = ? ORDER BY scored_at DESC, id DESC LIMIT 1`,
  );

  return candidates.map((c) => {
    // Use acq_scores (Phase 4 table) — get latest score by scored_at DESC
    const scoreRow = latestScoreStmt.get(c.id) as AcqScoreRow | undefined;

    // Validate tier against known values before casting (Fix A-1)
    const tierRaw = scoreRow?.tier ?? null;
    const tier: 'T1' | 'T2' | 'PASS' | 'KILLED' | null =
      tierRaw === 'T1' || tierRaw === 'T2' || tierRaw === 'PASS' || tierRaw === 'KILLED'
        ? tierRaw
        : null;

    // Extract leveredIrr and basisDiscountPct from score_json if present
    let leveredIrr: number | null = null;
    let basisDiscountPct: number | null = null;
    if (scoreRow?.score_json) {
      try {
        const parsed = JSON.parse(scoreRow.score_json) as Record<string, unknown>;
        if (typeof parsed['leveredIrr'] === 'number') leveredIrr = parsed['leveredIrr'];
        if (typeof parsed['basisDiscountPct'] === 'number') basisDiscountPct = parsed['basisDiscountPct'];
      } catch {
        // score_json malformed — silently skip (non-fatal)
      }
    }

    return {
      candidateId: c.id,
      address: c.address,
      // market: validate the raw DB string against ClusterTier — a non-conforming
      // value must NOT crash GET /allocate. safeParse → null on miss.
      market: c.market !== null && ClusterTier.safeParse(c.market).success
        ? (c.market as PortfolioAllocation['pipeline'][number]['market'])
        : null,
      composite: scoreRow?.composite ?? null,
      tier,
      leveredIrr,
      basisDiscountPct,
    };
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function buildPortfolioAllocation(
  db: WarehouseDb,
  asOf: string,
  forecastInputs?: { periods: number },
): Promise<PortfolioAllocation> {
  // Load capital config — fail-closed: cold DB → proposed → advisoryOnly=true
  const config = loadCapitalConfig(db);
  const advisoryOnly = config.hurdleRateRatification === 'proposed';
  const hurdleRatePct = config.hurdleRatePct;

  // Load macro — non-fatal: FRED down = null DGS5 = refi signal suppressed
  const macro = await getMacro().catch(() => null);
  const dgs5Raw = macro?.indicators.find((i) => i.id === 'DGS5')?.value ?? null;
  // FRED reports as percentage (e.g. 4.18 = 4.18%); scoring engine expects decimal (0.0418)
  const dgs5 = dgs5Raw !== null ? dgs5Raw / 100 : null;

  // Spine B: period metrics → property scores + debt scores
  const metrics = propertyPeriodMetrics(db);
  const propertyScores = scoreProperties(db, metrics);
  const debtScores = scoreDebtPositions(db, metrics, dgs5);

  // Index DebtScore by propertyId
  const debtByProperty = new Map<string, DebtScore>();
  for (const ds of debtScores) {
    debtByProperty.set(ds.propertyId, ds);
  }

  // Build verdicts for all properties with a score
  const verdicts: AllocationVerdict[] = propertyScores.map((ps) =>
    buildVerdict(
      ps,
      debtByProperty.get(ps.propertyId) ?? null,
      hurdleRatePct,
      advisoryOnly,
      forecastInputs,
    ),
  );

  // Pipeline candidates (active status only)
  const pipeline = loadPipelineCandidates(db);

  // C-3: portfolio-level buy verdict (spec §3.5) — emitted ONLY when a T1/T2 candidate
  // clears the composite floor and the basis-discount floor (or basis discount is unknown).
  // NEVER emit buy on an empty buyable list (refute lens #4, spec test A-4-neg).
  const buyable = pipeline.filter(
    (c) =>
      (c.tier === 'T1' || c.tier === 'T2') &&
      c.composite !== null &&
      c.composite >= BUY_COMPOSITE_FLOOR &&
      (c.basisDiscountPct === null || c.basisDiscountPct >= BASIS_DISCOUNT_FLOOR),
  );
  if (buyable.length > 0) {
    // Top-ranked = highest composite; tie-break by candidateId for determinism.
    const top = [...buyable].sort((a, b) => {
      const diff = (b.composite ?? 0) - (a.composite ?? 0);
      return diff !== 0 ? diff : a.candidateId.localeCompare(b.candidateId);
    })[0]!;
    verdicts.push(buildBuyVerdict(top, asOf, hurdleRatePct, advisoryOnly, forecastInputs));
  }

  // Action counts — tally across all emitted verdicts (buy included as of C-3).
  const actionCounts: Record<AllocationAction, number> = {
    buy: 0, hold: 0, sell: 0, refinance: 0, improve: 0,
  };
  for (const v of verdicts) actionCounts[v.action]++;

  return {
    asOf,
    hurdleRatePct,
    advisoryOnly,
    verdicts,
    actionCounts,
    pipeline,
  };
}

// ── Capital Allocation Report synthesis (IC Memo + Capital Allocation UI) ────────────────
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
// Priority score formula (financial-decision code — adversarial refute ran on PR #121):
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

// ── Debt reason impacts (exported for unit testing — prefixed _ by convention) ──────────────
//
// Separating this logic into a pure function serves two purposes:
//   1. Testability: tests can assert impact values directly without a full DB fixture.
//   2. Single source of truth: both the reasons[] builder in buildCapitalAllocationReport
//      and any future callers use the same attribution logic.
//
// ATTRIBUTION RULE (M5 fix):
//   - Balloon reason  → impact uses balloonOnlyUrgency (EXCLUDES the DSCR 30-pt component)
//   - DSCR reason     → impact = 30 * 0.15 (sole carrier of the DSCR contribution)
//   - Composite score → unchanged: raw formula still uses full debtUrgency * 0.15
//
// This ensures the 30-pt DSCR penalty appears in exactly ONE reason when both fire.

export interface DebtReasonImpactInput {
  hasDebt: boolean;
  effectiveBalloonMonths: number | null;
  dscr: number | null;
  dscrFloor: number;
}

export interface ReasonImpact {
  text: string;
  impact: number;
}

/**
 * Build the debt-related reason/impact pairs for a single property.
 *
 * Balloon reason impact uses the balloon-timing-only component of debtUrgency,
 * explicitly excluding the DSCR 30-pt sub-component.  The DSCR reason carries
 * that contribution independently so it is counted exactly once.
 *
 * The composite `raw` score formula (debtUrgency * 0.15) is NOT changed here —
 * this function is narrative-attribution only.
 */
export function _buildDebtReasonImpacts(input: DebtReasonImpactInput): ReasonImpact[] {
  const { hasDebt, effectiveBalloonMonths, dscr, dscrFloor } = input;
  if (!hasDebt) return [];

  const reasons: ReasonImpact[] = [];
  const DEBT_WEIGHT = 0.15;
  const dscrFires = dscr !== null && dscr < dscrFloor;

  if (effectiveBalloonMonths !== null && effectiveBalloonMonths < 24) {
    // Balloon-timing-only urgency: compute based solely on months to maturity,
    // excluding the DSCR 30-pt penalty component.  The formula balloonComponent = 100 - (months/12)*10
    // is clamped independently to [0, 100].  The DSCR penalty fires separately below.
    const balloonComponent = Math.max(0, 100 - (effectiveBalloonMonths / 12) * 10);
    const balloonOnlyUrgency = clamp(balloonComponent, 0, 100);
    reasons.push({
      text: `Balloon maturity in ${Math.round(effectiveBalloonMonths)} months`,
      impact: balloonOnlyUrgency * DEBT_WEIGHT,
    });
  }

  if (dscrFires) {
    reasons.push({
      text: `DSCR at ${dscr!.toFixed(2)} (below ${dscrFloor.toFixed(2)}x governor)`,
      impact: 30 * DEBT_WEIGHT,
    });
  }

  // Note on overflow: when balloonComponent + 30 > 100, the composite debtUrgency
  // clamps to 100 (score contribution = 15), but the sum of reason impacts equals
  // (balloonOnlyUrgency + 30) * 0.15 > 15 (e.g. balloonMonths=18 → 85*0.15+4.5=17.25).
  // This over-display is intentional: it correctly shows BOTH the timing and DSCR
  // contributions without conflating them, even though the combined score caps at 100.
  // The excess is cosmetic (rationale text only) — priorityScore is unaffected.

  return reasons;
}

function attentionBandScore(band: string | null | undefined): number {
  if (band === 'red') return 100;
  if (band === 'orange') return 66;
  if (band === 'yellow') return 33;
  return 0;
}

interface BalloonRow {
  property_id: string;
  months_to_maturity: number | null;
  dscr_override: number | null;
}

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

/**
 * Build the Capital Allocation Report by synthesizing all existing intelligence streams.
 * Used by GET /capital-allocation, POST /capital-allocation/sync-notion, and
 * GET /capital-allocation/ic-memo.
 *
 * Restored from PR #121 (f951b40) — squash-merge artifact left this missing from main.
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

  const [macroRes, benchRes, regionalRes] = await Promise.allSettled([
    getMacro(),
    getMacroMarketBenchmarks(),
    getRegionalMacro(),
  ]);

  let macro: MacroContext;
  if (macroRes.status === 'fulfilled') {
    const live = macroRes.value;
    const dgs10 = live.indicators.find((ind) => ind.id === 'DGS10');
    const cpi = live.indicators.find((ind) => ind.id === 'CPIAUCSL');
    macro = {
      tenYearRate: dgs10?.value ?? null,
      cpi: cpi?.value ?? null,
      source: (live.source === 'fred' || live.source === 'mock') ? live.source : 'mock',
      asOf: live.asOf ?? null,
    };
  } else {
    macro = { tenYearRate: null, cpi: null, source: 'mock', asOf: null };
  }

  const benchmarkSet: MarketBenchmarkSet =
    benchRes.status === 'fulfilled'
      ? benchRes.value
      : { available: false, source: 'unavailable', asOf: null, benchmarks: [] };
  const benchmarkByKey = new Map<string, CapRateBenchmark>();
  for (const b of benchmarkSet.benchmarks) {
    benchmarkByKey.set(benchmarkKey(b.market, b.propertyType), b);
  }

  const regionalMacro: RegionalMacroSnapshot | null =
    regionalRes.status === 'fulfilled' ? regionalRes.value : null;

  // Load ratified financial governors from DB (falls back to compile-time constants if DB is empty).
  // Called ONCE here so every site in this function reads the same DB-sourced value.
  const governors = loadGovernors(db);
  const dscrFloor = governors.dscrFloor;

  const metrics = propertyPeriodMetrics(db);
  const scores = scoreProperties(db, metrics);
  const scoreByPropertyId = new Map(scores.map((s) => [s.propertyId, s]));

  const debtScores = scoreDebtPositions(db, metrics, null);
  const debtByPropertyId = new Map(debtScores.map((d) => [d.propertyId, d]));

  const balloonMonthsByProperty = getBalloonMonthsByProperty(db);

  const arrears = snapshot.tenantArrears ?? {};
  const renewalStages = snapshot.renewalStages ?? {};
  const signals = renewalSignals(snapshot.leases, asOf, renewalStages, arrears);

  const signalsByProperty = new Map<string, typeof signals>();
  for (const sig of signals) {
    if (sig.propertyId === null) continue;
    const arr = signalsByProperty.get(sig.propertyId) ?? [];
    arr.push(sig);
    signalsByProperty.set(sig.propertyId, arr);
  }

  // Build an Oxford-share scale factor per property. Lease.annualRent is 100%-basis; property.noi
  // (Spine A) is Oxford-share. Without scaling, leasingRisk = nearTermExpiryRent / noi is inflated
  // by 1/ownershipPct for fractional properties (e.g., 2× for Red Branch 50%, 4× for Solar 25%).
  // Fallback to 1 when a lease's propertyId is not in the snapshot (unknown property = full basis).
  const ownershipPctByProperty = new Map<string, number>(
    snapshot.properties.map((p) => [p.id, p.oxfordOwnPct]),
  );
  const nearTermExpiryRentByProperty = new Map<string, number>();
  for (const lease of snapshot.leases) {
    if (lease.propertyId === null) continue;
    const bucket = bucketExpiry(lease.monthsToExpiry, lease.leaseEnd, asOf);
    if (bucket === '0-6m' || bucket === '6-12m') {
      const existing = nearTermExpiryRentByProperty.get(lease.propertyId) ?? 0;
      const ownershipPct = ownershipPctByProperty.get(lease.propertyId) ?? 1;
      nearTermExpiryRentByProperty.set(lease.propertyId, existing + lease.annualRent * ownershipPct);
    }
  }

  const atRiskCountByProperty = new Map<string, number>();
  for (const sig of signals) {
    if (sig.propertyId === null) continue;
    if (sig.likelihood === 'at-risk' || sig.likelihood === 'lapsing') {
      const existing = atRiskCountByProperty.get(sig.propertyId) ?? 0;
      atRiskCountByProperty.set(sig.propertyId, existing + 1);
    }
  }

  const entries: CapitalAllocationEntry[] = [];

  for (const property of snapshot.properties) {
    const propScore = scoreByPropertyId.get(property.id);
    const debtScore = debtByPropertyId.get(property.id);
    const balloonMonths = balloonMonthsByProperty.get(property.id) ?? null;

    const noi = property.noi;
    const sf = property.sf;
    const noiPerSf = sf > 0 && noi != null && noi !== 0 ? noi / sf : null;

    const healthScore = propScore?.health ?? null;
    const attentionBand = propScore?.attentionBand ?? null;
    const attentionScore = attentionBand === null ? 50 : attentionBandScore(attentionBand);
    const capitalAction = propScore?.capitalAction ?? 'hold';

    const nearTermExpiryRent = nearTermExpiryRentByProperty.get(property.id) ?? 0;
    const atRiskLikelihoodCount = atRiskCountByProperty.get(property.id) ?? 0;

    const hasDebt = debtScore !== undefined && debtScore.signal !== 'no-debt';
    const debtScoreValue = hasDebt ? debtScore!.score : null;
    const dscr = hasDebt ? debtScore!.dscr : null;
    const effectiveBalloonMonths = hasDebt ? balloonMonths : null;

    const healthVal = healthScore ?? 50;

    const leasingRisk =
      noi > 0
        ? Math.min(100, (nearTermExpiryRent / noi) * 100 + atRiskLikelihoodCount * 10)
        : Math.min(50, atRiskLikelihoodCount * 10);

    const debtUrgency = !hasDebt
      ? 0
      : clamp(
          (effectiveBalloonMonths === null ? 0 : Math.max(0, 100 - (effectiveBalloonMonths / 12) * 10)) +
            (dscr !== null && dscr < dscrFloor ? 30 : 0),
          0,
          100,
        );

    const raw = (100 - healthVal) * 0.35 + attentionScore * 0.30 + leasingRisk * 0.20 + debtUrgency * 0.15;
    const priorityScore = Math.max(0, Math.min(100, raw));

    // ── Rationale builder — debt reasons via single-attribution helper (C1+I1) ──
    // _buildDebtReasonImpacts is the SOLE source of balloon and DSCR reasons.
    // It receives dscrFloor from loadGovernors() so reason text interpolates the
    // live governor value rather than a hardcoded 1.25 literal (C1).
    // The old inline balloon/DSCR blocks that lived here have been removed (I1) —
    // they duplicated what _buildDebtReasonImpacts already emits.
    const reasons: Array<{ text: string; impact: number }> = [
      ..._buildDebtReasonImpacts({ hasDebt, effectiveBalloonMonths, dscr, dscrFloor }),
    ];

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

    let impliedCapRate: number | null = null;
    let capRateGap: number | null = null;
    let capRatePercentile: CapitalAllocationEntry['capRatePercentile'] = null;
    const propValue = property.oxfordValue;
    if (Number.isFinite(propValue) && propValue > 0 && Number.isFinite(noi)) {
      const implied = noi / propValue;
      impliedCapRate = implied;
      const bench = benchmarkByKey.get(benchmarkKey(property.market, property.type));
      if (bench && implied > 0) {
        capRateGap = implied - bench.capRateP50;
        capRatePercentile = classifyCapRateBand(implied, bench);
      }
    }

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
      leasingRisk,
      impliedCapRate,
      capRateGap,
      capRatePercentile,
    });
  }

  entries.sort((a, b) => b.priorityScore - a.priorityScore || a.propertyId.localeCompare(b.propertyId));

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
    marketBenchmarks: {
      available: benchmarkSet.available,
      source: benchmarkSet.source,
      asOf: benchmarkSet.asOf,
    },
    regionalMacro,
  };
}
