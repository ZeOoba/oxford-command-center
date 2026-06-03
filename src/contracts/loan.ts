import { z } from 'zod';
import { DataQualityFlag, IsoDateNullable } from './common';

/** Borrower = Oxford pays; Lender = Oxford receives; Internal = intercompany accrual. */
export const LoanDirection = z.enum(['borrower', 'lender', 'internal']);
export type LoanDirection = z.infer<typeof LoanDirection>;

/**
 * A debt position. Source of truth: master workbook `Loan Index`,
 * `External Loans Summary`, `Portfolio Summary — Internal`.
 */
export const Loan = z.object({
  id: z.string(),
  name: z.string(),
  counterparty: z.string().nullable(),
  direction: LoanDirection,
  originalPrincipal: z.number().nullable(),
  currentBalance: z.number(), // signed: negative for lender (capital deployed)
  absBalance: z.number().nonnegative(), // magnitude, for ladders/exposure
  rate: z.number().nullable(),
  monthlyPmt: z.number().nullable(),
  annualInterest: z.number().nullable(),
  annualPrincipal: z.number().nullable(),
  loanType: z.string().nullable(), // "Int Only", "Amortizing", "Balloon", ...
  status: z.string().nullable(),
  isDemand: z.boolean(),
  maturity: IsoDateNullable, // null when demand or garbage
  monthsToMaturity: z.number().nullable(),
  ltv: z.number().nullable(),
  lender: z.string().nullable(),
  balloon: z.boolean(), // true when a balloon payment is due at maturity
  flags: z.array(DataQualityFlag).default([]),
});
export type Loan = z.infer<typeof Loan>;
