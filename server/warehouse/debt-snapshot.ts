import type { Database } from 'better-sqlite3';
import type { Loan } from '../../src/contracts/index';

export interface DebtSnapshotResult {
  written: number;
  errors: string[];
}

/**
 * Writes a snapshot of ORA borrower-side debt positions to the warehouse.
 * Filters to direction === 'borrower' and active loans only (status null or 'Active').
 * On conflict (same id): updates the existing row (upsert).
 * Prior rows for the same loan id with a different snapshot_date are marked 'superseded'.
 *
 * NOTE: The Loan contract has no propertyId field — ownership is via Counterparty.links.loans.
 * Pass loanPropertyMap to associate loans with properties at snapshot time (keyed by loan.id).
 *
 * LENDER COLUMN NOTE: lender is stored in the DB for internal PM use but is intentionally
 * excluded from the DebtPosition Zod type so it never reaches client-facing surfaces.
 */
export function writeDebtSnapshot(
  db: Database,
  loans: Loan[],
  snapshotDate: string,
  loanPropertyMap?: ReadonlyMap<string, string>,
): DebtSnapshotResult {
  const errors: string[] = [];
  let written = 0;

  // Filter: borrower-side only, active (null status or explicit 'Active')
  const borrowerLoans = loans.filter(
    (l) => l.direction === 'borrower' && (l.status === null || l.status === 'Active'),
  );

  const supersede = db.prepare(
    `UPDATE debt_positions
     SET status = 'superseded'
     WHERE id = ? AND snapshot_date != ? AND status = 'active'`,
  );

  const upsert = db.prepare(
    `INSERT INTO debt_positions
       (id, snapshot_date, property_id, loan_name, lender, original_principal, current_balance, rate,
        loan_type, monthly_pmt, annual_interest, annual_principal, is_demand,
        maturity_date, months_to_maturity, ltv, balloon, status)
     VALUES
       (@id, @snapshot_date, @property_id, @loan_name, @lender, @original_principal, @current_balance, @rate,
        @loan_type, @monthly_pmt, @annual_interest, @annual_principal, @is_demand,
        @maturity_date, @months_to_maturity, @ltv, @balloon, 'active')
     ON CONFLICT(id, snapshot_date) DO UPDATE SET
       property_id        = excluded.property_id,
       loan_name          = excluded.loan_name,
       lender             = excluded.lender,
       original_principal = excluded.original_principal,
       current_balance    = excluded.current_balance,
       rate               = excluded.rate,
       loan_type          = excluded.loan_type,
       monthly_pmt        = excluded.monthly_pmt,
       annual_interest    = excluded.annual_interest,
       annual_principal   = excluded.annual_principal,
       is_demand          = excluded.is_demand,
       maturity_date      = excluded.maturity_date,
       months_to_maturity = excluded.months_to_maturity,
       ltv                = excluded.ltv,
       balloon            = excluded.balloon,
       status             = 'active'`,
  );

  const runAll = db.transaction(() => {
    for (const loan of borrowerLoans) {
      try {
        supersede.run(loan.id, snapshotDate);
        upsert.run({
          id: loan.id,
          property_id: loanPropertyMap?.get(loan.id) ?? null,
          loan_name: loan.name,
          lender: loan.lender ?? null,
          original_principal: loan.originalPrincipal ?? null,
          current_balance: loan.currentBalance,
          rate: loan.rate ?? null,
          loan_type: loan.loanType ?? null,
          monthly_pmt: loan.monthlyPmt ?? null,
          annual_interest: loan.annualInterest ?? null,
          annual_principal: loan.annualPrincipal ?? null,
          is_demand: loan.isDemand ? 1 : 0,
          maturity_date: loan.maturity ?? null,
          months_to_maturity: loan.monthsToMaturity ?? null,
          ltv: loan.ltv ?? null,
          balloon: loan.balloon ? 1 : 0,
          snapshot_date: snapshotDate,
        });
        written++;
      } catch (e) {
        errors.push(`loan ${loan.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  });

  runAll();
  return { written, errors };
}
