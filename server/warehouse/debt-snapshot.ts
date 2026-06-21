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
 * F-stale fix: after upserting the current borrower set, any debt_positions row with
 * direction-borrower status='active' whose loan id is NOT in the incoming set is
 * superseded (so paid-off / removed loans leave the active set cleanly).
 *
 * F-FK-safe fix: property_id is validated against property_master before insert.
 * An id not in property_master is written as NULL + recorded in errors. This prevents
 * an FK constraint from silently swallowing a row.
 *
 * NOTE: The Loan contract has no propertyId field — ownership is via collateralProperty.
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

  // F-FK-safe: load the valid property_master id set ONCE before the transaction.
  // Any loanPropertyMap value not in this set is coerced to null + surfaced as an error.
  const validPropertyIds = new Set(
    (db.prepare('SELECT id FROM property_master').all() as Array<{ id: string }>).map((r) => r.id),
  );

  const supersede = db.prepare(
    `UPDATE debt_positions
     SET status = 'superseded'
     WHERE id = ? AND snapshot_date != ? AND status = 'active'`,
  );

  // F-stale: supersede any previously-active borrower loan NOT in the current incoming set.
  const supersedeStale = db.prepare(
    `UPDATE debt_positions
     SET status = 'superseded'
     WHERE status = 'active'
       AND id NOT IN (SELECT value FROM json_each(?))`,
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
    // F-stale: supersede all previously-active rows whose id is not in the incoming set
    const incomingIds = JSON.stringify(borrowerLoans.map((l) => l.id));
    supersedeStale.run(incomingIds);

    for (const loan of borrowerLoans) {
      try {
        // Supersede any prior rows for this loan id with a different snapshotDate
        supersede.run(loan.id, snapshotDate);

        // F-FK-safe: validate the mapped property_id before insert
        const mappedPropertyId = loanPropertyMap?.get(loan.id) ?? null;
        let propertyId: string | null = null;
        if (mappedPropertyId !== null) {
          if (validPropertyIds.has(mappedPropertyId)) {
            propertyId = mappedPropertyId;
          } else {
            // Not in property_master — write null + surface the error
            errors.push(
              `loan ${loan.id}: property_id '${mappedPropertyId}' not in property_master — written as null`,
            );
            propertyId = null;
          }
        }

        upsert.run({
          id: loan.id,
          property_id: propertyId,
          loan_name: loan.name,
          lender: loan.lender ?? null,
          original_principal: loan.originalPrincipal ?? null,
          current_balance: loan.absBalance,  // Always positive magnitude; never signed currentBalance (see conditions.ts sign convention)
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
