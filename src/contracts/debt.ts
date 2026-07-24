import { z } from 'zod';

export const DebtSignal = z.enum(['refi', 'cash-out', 'hold', 'governor-block', 'no-debt']);
export type DebtSignal = z.infer<typeof DebtSignal>;

export const DebtScoreBand = z.enum(['strong', 'adequate', 'watch', 'critical']);
export type DebtScoreBand = z.infer<typeof DebtScoreBand>;

export const DebtPosition = z.object({
  id: z.string(),
  propertyId: z.string().nullable(),
  loanName: z.string(),
  // lender: intentionally omitted — stored in DB but never emitted on client-facing surfaces
  originalPrincipal: z.number().nullable(),
  currentBalance: z.number(),
  rate: z.number().nullable(),
  loanType: z.string().nullable(),
  monthlyPmt: z.number().nullable(),
  annualInterest: z.number().nullable(),
  annualPrincipal: z.number().nullable(),
  isDemand: z.boolean(),
  maturityDate: z.string().nullable(),
  monthsToMaturity: z.number().nullable(),
  ltv: z.number().nullable(),
  balloon: z.boolean(),
  snapshotDate: z.string(),
  status: z.enum(['active', 'retired', 'superseded']),
});
export type DebtPosition = z.infer<typeof DebtPosition>;

export const DebtScore = z.object({
  propertyId: z.string(),
  propertyName: z.string(),
  noiBasis: z.string(),
  dscr: z.number().nullable(),
  dscrHeadroom: z.number().nullable(),
  ltv: z.number().nullable(),
  ltvHeadroom: z.number().nullable(),
  debtYield: z.number().nullable(),
  signal: DebtSignal,
  signalReason: z.string().nullable(),
  score: z.number().min(0).max(100),
  scoreBand: DebtScoreBand,
  capitalConfigVersion: z.number().int(),
  // Post-refi annualized cash savings as a % of equity: (currentAnnualInterest -
  // refiAnnualInterest) / equity. Null when rate, LTV, or balance is undrivable, or when
  // the property has more than one active loan (single-loan LTV cannot be blended against
  // a multi-loan total balance) — never a guessed/zero value. See capital-allocation.ts
  // C-2 refinance gate.
  refiCashSavingsPct: z.number().nullable(),
});
export type DebtScore = z.infer<typeof DebtScore>;

export const MaturityLadderEntry = z.object({
  propertyId: z.string(),
  propertyName: z.string(),
  loanId: z.string(),
  loanName: z.string(),
  currentBalance: z.number(),
  maturityDate: z.string().nullable(),
  monthsToMaturity: z.number().nullable(),
  bucket: z.enum(['0-12', '13-24', '25-36', '37+']),
  balloon: z.boolean(),
  isDemand: z.boolean(),
  signal: DebtSignal,
});
export type MaturityLadderEntry = z.infer<typeof MaturityLadderEntry>;

export const DebtScoreResponse = z.object({ scores: z.array(DebtScore) });
export type DebtScoreResponse = z.infer<typeof DebtScoreResponse>;

export const MaturityLadderResponse = z.object({ ladder: z.array(MaturityLadderEntry) });
export type MaturityLadderResponse = z.infer<typeof MaturityLadderResponse>;

// ── Debt & Maturity module v1 (server/warehouse/debt-maturity.ts) ─────────────────────────
// CONFIDENTIALITY: these surfaces are tighter than MaturityLadderEntry — no balances, no
// rate VALUES, no lender names. rateType is loan STRUCTURE ("Fixed"/"Floating"), not a term.

/** One event on the chronological maturity/rate-reset timeline. */
export const MaturityTimelineEvent = z.object({
  /** demand-callable = a demand note, callable immediately (always sorted first). */
  eventType: z.enum(['maturity', 'rate-reset', 'demand-callable']),
  /** ISO date; null for demand notes and for loans with no determinable maturity date. */
  eventDate: z.string().nullable(),
  /** Months from the reference date, recomputed FRESH (never the stored workbook cell
   *  when a real date exists); null for demand notes / undeterminable. */
  monthsOut: z.number().nullable(),
  loanId: z.string(),
  loanName: z.string(),
  propertyId: z.string().nullable(),
  propertyName: z.string().nullable(),
  balloon: z.boolean(),
  rateType: z.string().nullable(),
});
export type MaturityTimelineEvent = z.infer<typeof MaturityTimelineEvent>;

export const MaturityTimelineResponse = z.object({
  asOf: z.string(),
  events: z.array(MaturityTimelineEvent),
});
export type MaturityTimelineResponse = z.infer<typeof MaturityTimelineResponse>;

/** Per-property refi-window flags. Boolean-or-null breach flags: null = the input is
 *  unknown — unknown is never clearance, and never a fabricated breach (F1/F2 precedent). */
export const RefiWindowEntry = z.object({
  propertyId: z.string(),
  propertyName: z.string(),
  loanCount: z.number().int().positive(),
  soonestMaturityDate: z.string().nullable(),
  monthsToSoonestMaturity: z.number().nullable(),
  /** A demand note is callable immediately — forces both windows true. */
  hasDemandNote: z.boolean(),
  /** Some loan's maturity could not be determined (flagged, not guessed). */
  hasUnknownMaturity: z.boolean(),
  maturityWithin12mo: z.boolean(),
  maturityWithin24mo: z.boolean(),
  /** Passthrough from the ratified scoring engine (Spine-B NOI basis; D1 LTV convention). */
  dscr: z.number().nullable(),
  dscrFloorBreach: z.boolean().nullable(),
  ltv: z.number().nullable(),
  /** vs the ratified LTV governor (capital_config ltv_ceiling). */
  govLtvCeilingBreach: z.boolean().nullable(),
  /** vs the per-property refi ceiling (ALERT_THRESHOLDS.ltvCeiling). */
  refiLtvHeadroom: z.number().nullable(),
  refiCeilingBreach: z.boolean().nullable(),
});
export type RefiWindowEntry = z.infer<typeof RefiWindowEntry>;

/** Conservative portfolio-aggregate LTV vs the ratified aggregate governor.
 *  Basis: implied collateral value (balance ÷ per-loan LTV) for single-active-loan
 *  properties with a NON-NEGATIVE balance (a zero balance, e.g. an undrawn revolver,
 *  contributes nothing to either sum and cannot deflate the aggregate — only a strictly
 *  negative balance is excluded); unlevered-property value is NOT in the denominator, so
 *  the basis OVERSTATES true aggregate LTV. Therefore complete coverage AND ≤ ceiling is a
 *  TRUE clearance; anything else is false/null — never a fabricated verdict. */
export const PortfolioAggregateLtv = z.object({
  aggregateLtv: z.number().nullable(),
  basis: z.literal('levered-properties-implied-value'),
  coveredLoanCount: z.number().int().nonnegative(),
  totalLoanCount: z.number().int().nonnegative(),
  coveredBalancePct: z.number().nullable(),
  complete: z.boolean(),
  /** No active debt rows at all. Distinguishes "no debt" from "no data": the warehouse
   *  cannot tell a genuinely unlevered portfolio from one whose rows were wiped by a bad
   *  snapshot, so an empty cohort yields clearedConservatively=null, never a clearance.
   *  Consumers must branch on this before reading the verdict. */
  emptyCohort: z.boolean(),
  clearedConservatively: z.boolean().nullable(),
  note: z.string(),
});
export type PortfolioAggregateLtv = z.infer<typeof PortfolioAggregateLtv>;

export const RefiWindowsResponse = z.object({
  asOf: z.string(),
  windows: z.array(RefiWindowEntry),
  aggregate: PortfolioAggregateLtv,
  /** The governor values the flags were computed against — echoed for auditability. */
  governors: z.object({
    dscrFloor: z.number(),
    ltvCeilingAggregate: z.number(),
    refiLtvCeilingPerProperty: z.number(),
  }),
});
export type RefiWindowsResponse = z.infer<typeof RefiWindowsResponse>;
