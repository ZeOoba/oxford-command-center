// server/warehouse/capital-allocation.ts
//
// Phase 5 — Capital Allocation Engine
//
// buildPortfolioAllocation(): pure async fn — loads PropertyScore + DebtScore for every
// active property, maps each to an AllocationVerdict (hold/sell/refi/improve→hold),
// loads acq pipeline candidates, and returns PortfolioAllocation.
//
// Verdict priority (first match wins):
//   sell       → capitalAction === 'disposition-candidate'
//   refinance  → debtSignal in ('refi' | 'cash-out') AND debtSignal !== 'governor-block'
//   improve→hold → capitalAction === 'invest'  (capexIrr estimate deferred to Phase 4 v2)
//   hold       → default (monitor, governor-block, no-debt)
//
// advisoryOnly = true until hurdle rate is ratified (Phase 5 default).
// forecastInputs absent → horizonPeriods=0, confidence01 capped at 0.65.

import { getMacro } from '../macro/getMacro';
import { propertyPeriodMetrics } from './metrics';
import { scoreProperties } from './scores';
import { scoreDebtPositions } from './debt-scoring';
import { loadCapitalConfig } from './capital-config';
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
  } else if (debtSignal === 'refi' || debtSignal === 'cash-out') {
    // 2. refinance (governor-block signal falls to hold per priority 4; it cannot match here)
    action = 'refinance';
    riskBand =
      debtScoreBand === 'strong' ? 'low' :
      debtScoreBand === 'adequate' ? 'moderate' :
      'elevated';
    expectedReturnPct = null;
    timelineMonths = 4; // see I-2 (spec TIMELINE)
    reasons.push(`Debt signal: ${debtSignal}`);
    // PHASE 5 v2 DEFERRAL (C-2): refi fires on debtSignal alone. refiCashSavingsPct()
    // savings-gating is deferred — no cash-savings threshold is applied in v1.
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

  return candidates.map((c) => {
    // Use acq_scores (Phase 4 table) — get latest score by scored_at DESC
    const scoreRow = db.prepare(
      `SELECT candidate_id, composite, tier, score_json
       FROM acq_scores WHERE candidate_id = ? ORDER BY scored_at DESC, id DESC LIMIT 1`,
    ).get(c.id) as AcqScoreRow | undefined;

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
      tier: (scoreRow?.tier as 'T1' | 'T2' | 'PASS' | 'KILLED' | null) ?? null,
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

  // Action counts — buy=0 always (pipeline candidates are NOT in verdicts[])
  // PHASE 5 v2 DEFERRAL (C-3): buy verdicts (§3.5) are NOT emitted in v1 — buy stays 0.
  // Pipeline candidates live in pipeline[], not verdicts[]; no buy AllocationVerdict is produced.
  const actionCounts: Record<AllocationAction, number> = {
    buy: 0, hold: 0, sell: 0, refinance: 0, improve: 0,
  };
  for (const v of verdicts) actionCounts[v.action]++;

  // Pipeline candidates (active status only)
  const pipeline = loadPipelineCandidates(db);

  return {
    asOf,
    hurdleRatePct,
    advisoryOnly,
    verdicts,
    actionCounts,
    pipeline,
  };
}
