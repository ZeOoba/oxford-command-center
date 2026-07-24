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
  /**
   * UNBOUNDED here deliberately (round 5, second adversarial-review pass, HIGH severity —
   * corrects a round-4 regression). This shared Loan schema is validated by
   * server/workbook/parse.ts's PortfolioSnapshot.parse() call, which every writer goes through
   * (the automated reload, the backfill CLI, AND POST /snapshot's payload schema) — round 4's
   * "SCOPE CORRECTION #2" claiming only POST /snapshot validates was factually WRONG, confirmed
   * by reading parse.ts directly. Bounding `ltv` here therefore means a SINGLE bad LTV cell
   * anywhere in the portfolio makes PortfolioSnapshot.parse() throw and fails the ENTIRE
   * snapshot — properties, leases, insurance, cash, everything — not just that one loan. This
   * repo's established convention for a bad workbook cell is a DataQualityFlag (visible, non-
   * fatal), never a hard throw; a magnitude bound on a shared, whole-portfolio-validated field
   * broke that convention. The narrower sanity check that motivated this field (rejecting a
   * sign error or an order-of-magnitude entry error before it reaches
   * computePortfolioAggregateLtv's Hard-Invariant-4 governor calc) is applied ONLY at the POST
   * /snapshot boundary instead — see DebtApiSnapshotPayloadSchema in debt-api.ts, which extends
   * this same Loan schema with a bounded ltv override scoped to that one route.
   *
   * The directional gap remains OPEN regardless of scope: for a sole covered loan in
   * computePortfolioAggregateLtv, aggregateLtv reduces algebraically to exactly that loan's own
   * ltv, so a too-LOW value (a column-drift misreading a rate cell, typically 0.03-0.09) produces
   * a false clearance unguarded by any magnitude bound — a floor tight enough to catch it would
   * also reject this repo's own legitimate low-LTV data (0.01 recurs in debt-scoring.test.ts for
   * near-payoff loans). Closing it needs either a policy-level floor with an accepted false-
   * positive rate (a material assumption requiring sign-off) or computePortfolioAggregateLtv
   * treating an implausibly-low ltv as UNCOVERED (same treatment H1 gives a negative balance:
   * excluded → complete=false → null verdict, never a fabricated clearance) — neither attempted
   * here; flagged to Gabriel as an explicit decision rather than guessed at under time pressure.
   */
  ltv: z.number().nullable(),
  lender: z.string().nullable(),
  balloon: z.boolean(), // true when a balloon payment is due at maturity
  flags: z.array(DataQualityFlag).default([]),
  /** Raw Properties-tab display name from workbook Loan Index col 11 (borrower loans only).
   *  Null when the column is empty or the loan is not borrower-direction.
   *  Never misattributed: blank = unattributed, never guessed. */
  collateralProperty: z.string().nullable().default(null),
});
export type Loan = z.infer<typeof Loan>;
