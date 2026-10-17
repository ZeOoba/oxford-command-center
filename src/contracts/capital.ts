import { z } from 'zod';
import { Confidence, DataQualityFlag } from './common';
import { AttentionBand, HealthBand } from './warehouse';
import { ClusterTier, Ratification, Verdict } from './acquisition';
import { DebtBookTrust } from './debt';

export const AllocationAction = z.enum(['buy', 'hold', 'sell', 'refinance', 'improve']);
export type AllocationAction = z.infer<typeof AllocationAction>;

export const RiskBand = z.enum(['low', 'moderate', 'elevated', 'high']);
export type RiskBand = z.infer<typeof RiskBand>;

export const HurdleRateConfig = z.object({
  hurdleRatePct: z.number().min(0).max(1),
  ratification: Ratification,
  ratifiedBy: z.string().nullable().default(null),
  ratifiedDate: z.string().nullable().default(null),
  capitalConfigVersion: z.number().int(),
}).superRefine((val, ctx) => {
  if (val.ratification === 'ratified') {
    if (val.ratifiedBy === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ratifiedBy'], message: 'ratifiedBy is required when ratification is "ratified"' });
    }
    if (val.ratifiedDate === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ratifiedDate'], message: 'ratifiedDate is required when ratification is "ratified"' });
    }
  } else if (val.ratification === 'proposed') {
    if (val.ratifiedBy !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ratifiedBy'], message: 'ratifiedBy must be null when ratification is "proposed"' });
    }
    if (val.ratifiedDate !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ratifiedDate'], message: 'ratifiedDate must be null when ratification is "proposed"' });
    }
  }
});
export type HurdleRateConfig = z.infer<typeof HurdleRateConfig>;

export const AllocationVerdict = z.object({
  propertyId: z.string(),
  propertyName: z.string().nullable(),
  period: z.string(),
  action: AllocationAction,
  expectedReturnPct: z.number().nullable(),
  returnAboveHurdle: z.boolean().nullable(),
  riskBand: RiskBand,
  timelineMonths: z.number().int().nonnegative(),
  horizonPeriods: z.number().int().nonnegative(),
  confidence01: z.number().min(0).max(1),
  confidenceTier: Confidence,
  advisoryOnly: z.boolean(),
  reasons: z.array(z.string()),
  inputs: z.object({
    healthBand: HealthBand,
    attentionBand: AttentionBand,
    capitalAction: z.enum(['invest', 'hold', 'monitor', 'disposition-candidate']),
    debtSignal: z.enum(['refi', 'cash-out', 'hold', 'governor-block', 'no-debt']),
    debtScoreBand: z.enum(['strong', 'adequate', 'watch', 'critical']),
    dscr: z.number().nullable(),
    dscrHeadroom: z.number().nullable(),
    ltv: z.number().nullable(),
    noiPerSf: z.number().nullable(),
    forecastPresent: z.boolean(),
    /**
     * Round 19d (adversarial refute, MEDIUM-HIGH): the IC memo — the artifact that becomes a
     * printed PDF and drives capital decisions — carried ZERO indication that the debt book was
     * untrusted. A verdict read debtSignal 'hold' / debtScoreBand 'watch' / dscr null / ltv null,
     * visually identical to a property that merely lacks NOI data. That is the exact failure mode
     * this work fixed for the scorecard and left unfixed on the higher-stakes surface.
     */
    bookTrust: DebtBookTrust,
  }),
  dataQuality: z.array(DataQualityFlag).default([]),
});
export type AllocationVerdict = z.infer<typeof AllocationVerdict>;

export const PortfolioAllocation = z.object({
  asOf: z.string(),
  hurdleRatePct: z.number(),
  advisoryOnly: z.boolean(),
  verdicts: z.array(AllocationVerdict),
  actionCounts: z.record(AllocationAction, z.number().int().nonnegative()),
  pipeline: z.array(z.object({
    candidateId: z.string(),
    address: z.string().nullable(),
    market: ClusterTier.nullable(),
    composite: z.number().nullable(),
    tier: z.enum(['T1', 'T2', 'PASS', 'KILLED']).nullable(),
    leveredIrr: z.number().nullable(),
    basisDiscountPct: z.number().nullable(),
    /** Refute H3: the PERSISTED verdict (tier alone can read T1 next to a governor-demoted PASS on
     *  pre-fix rows) and whether this candidate passed every BUY-gate condition. Optional so older
     *  producers still parse; consumers treat absent buyEligible as NOT eligible. */
    verdict: Verdict.nullable().optional(),
    buyEligible: z.boolean().optional(),
    /** Refute round 2 T2: the engine's downgrade-only cap reasons for this score (unconfirmed
     *  Stage-0 gate input, unresolved DD-critical items, Q3 guard …). Ratified rule (Gabriel,
     *  2026-10-17, #483): items that are unknown-by-data only (clear height, stories) leave the
     *  candidate BUY-eligible with the open items visible, never silent; any unresolved DD-critical
     *  item (flood, zoning, roof, deferred-maintenance capex) or another unconfirmed Stage-0 gate
     *  input holds it at WATCH
     *  (see buyBlockedBy). */
    openItems: z.array(z.string()).optional(),
    /** #483: why this candidate is held out of BUY by the DD-critical / gate-indeterminate rule
     *  (empty or absent when the rule does not apply). Any entry ⇒ buyEligible is false. */
    buyBlockedBy: z.array(z.string()).optional(),
  })),
  /** BUY-gate transparency (refute H2 / round 2 T3): how many active candidates whose latest score
   *  would otherwise be T1/T2 PURSUE/WATCH — or, per #463, a governor-demoted PASS (legacy T1/T2 shape,
   *  or tier PASS with the engine's "Governor demotion:" reason) — were excluded as stale/unparseable under the live scoring regime, and
   *  an explicit note when > 0 (or when the live regime could not be loaded). The note does not claim
   *  BUY was suppressed — a BUY may still come from current rows. Optional.
   *  staleScores counts BOTH stale kinds (scoring-regime freshness AND an older/missing
   *  governorRegime stamp, #463). Every candidate named by the dataQuality governorRegime flag (a
   *  narrower predicate: composite ≥ floor, eligible on its face or demoted PASS, basis floor passed)
   *  is also counted here. */
  buyGate: z.object({
    staleScores: z.number().int().nonnegative(),
    unparseableScores: z.number().int().nonnegative(),
    regimeUnavailable: z.boolean(),
    suppressedNote: z.string().nullable(),
  }).optional(),
  /** Portfolio-level data-quality disclosures not tied to one verdict (e.g. BUY candidates withheld
   *  because their score predates the current governor regime). Additive; defaults to []. */
  dataQuality: z.array(DataQualityFlag).default([]),
});
export type PortfolioAllocation = z.infer<typeof PortfolioAllocation>;

export const MarketAction = z.enum(['enter', 'expand', 'maintain', 'exit']);
export type MarketAction = z.infer<typeof MarketAction>;

export const MarketSourceTag = z.enum(['fred', 'census-acs', 'comps-ai', 'composite']);
export type MarketSourceTag = z.infer<typeof MarketSourceTag>;

export const MarketSignal = z.object({
  cluster: z.string(),
  asOf: z.string(),
  marketScore: z.number().min(0).max(100).nullable(),
  action: MarketAction,
  confidence01: z.number().min(0).max(1),
  confidenceTier: Confidence,
  advisoryOnly: z.literal(true),
  oraPropertyCount: z.number().int().nonnegative(),
  sources: z.array(z.object({
    source: MarketSourceTag,
    metric: z.string(),
    value: z.number().nullable(),
    confidence01: z.number().min(0).max(1),
    asOf: z.string(),
    stale: z.boolean(),
  })),
  reasons: z.array(z.string()),
  dataQuality: z.array(DataQualityFlag).default([]),
});
export type MarketSignal = z.infer<typeof MarketSignal>;

export const CapitalAllocationResponse = z.object({
  asOf: z.string(),
  hurdleRate: HurdleRateConfig,
  advisoryOnly: z.boolean(),
  portfolio: PortfolioAllocation,
});
export type CapitalAllocationResponse = z.infer<typeof CapitalAllocationResponse>;

export const MarketIntelResponse = z.object({
  asOf: z.string(),
  signals: z.array(MarketSignal),
});
export type MarketIntelResponse = z.infer<typeof MarketIntelResponse>;
