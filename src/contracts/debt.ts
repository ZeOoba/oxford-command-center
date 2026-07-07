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
