import type { Database } from 'better-sqlite3';
import type { Loan } from '../../src/contracts/index';

export interface DebtSnapshotResult {
  written: number;
  errors: string[];
}

// Loan.status (src/contracts/loan.ts) is free-form workbook text, not a fixed enum — the real
// Loan Index tab uses descriptive values like "Amortizing", "Interest Only", "Balloon Due Feb-27",
// never the literal string "Active". An allowlist requiring status === 'Active' therefore matches
// nothing real and silently excludes every genuine active loan (confirmed empirically 2026-07-10:
// 0 of 5 real borrower loans matched, leaving debt_positions permanently empty).
//
// TWO rounds of mandatory adversarial review (2026-07-10, refute-financial-change workflow) each
// independently broke a plain denylist-of-terminal-terms approach on this free-form field:
//   Round 1: bare "closed" false-positive-matched "Closed-End" (a loan-STRUCTURE term, not a
//     payoff signal); "paid off" (two words) missed the single-word "Payoff".
//   Round 2: the round-1 fix was ITSELF broken from both directions — "payoff" (added in round 1)
//     collides with THIS repo's OWN active-loan vocabulary (src/analytics/conditions.ts:218
//     "Prepare refinance or payoff" describes a LIVE balloon, not a completed payoff) and with
//     in-process states ("Payoff Pending/Scheduled/Requested" — still outstanding debt); the
//     closed(?![\s-]?end) lookahead only tolerated a single ASCII hyphen/space, so ORA's own
//     em-dash house style ("Closed—End") still slipped through; "terminated" collided with hedge
//     notes ("Swap Terminated" on a live loan); "closed" collided with "Closed to Prepayment"
//     (a live lockout period) and "Undisclosed"; and the denylist was missing standard
//     commercial-mortgage terminal vocabulary (Satisfied, Paid in Full/PIF, Released, Refinanced,
//     Repaid, Defeased, Extinguished, Cancelled, Assumed) — a real "Refinanced" old-loan row would
//     have DOUBLE-COUNTED debt against its own replacement loan.
//
// A substring denylist on genuinely free text has an unbounded tail of collisions in BOTH
// directions and cannot converge by adding more terms — every fix in round 1 became a new bug in
// round 2. Final design: three buckets, never a binary guess —
//   1. KNOWN_ACTIVE_PREFIXES — loan-TYPE language checked FIRST (so a terminal-sounding word
//      appended as a trailing note, e.g. "Amortizing; swap terminated 2025" or "Interest Only;
//      payoff at balloon Feb-27", can never override a genuinely active loan's own type prefix).
//   2. KNOWN_TERMINAL_TOKENS — the loan obligation itself has ended; word-boundaried (so it can't
//      match mid-word, e.g. "Undisclosed") and restricted to terms with no known active-vocabulary
//      collision (bare "closed"/"payoff"/"terminated" were each demonstrated to collide and are
//      deliberately NOT included — "closed end" is instead a KNOWN_ACTIVE_PREFIX).
//   3. Anything matching NEITHER is UNRECOGNIZED — kept active (the safer default for a
//      balloon/maturity/LTV alerting system: a visible-but-flagged loan can be checked by a human;
//      a silently-dropped one cannot) but surfaced in the returned errors[] so it is never silent.
// All matching is done on text with dash variants (-, em/en dash) and repeated whitespace
// normalized to a single space FIRST, so "Closed-End" / "Closed—End" / "Closed  End" all resolve
// identically regardless of which separator glyph the workbook cell happens to use.
function normalizeLoanStatusText(status: string): string {
  return status.trim().toLowerCase().replace(/[-–—]/g, ' ').replace(/\s+/g, ' ');
}

const KNOWN_ACTIVE_PREFIXES = [
  'active', 'amortizing', 'interest only', 'io', 'balloon', 'closed end', 'construction', 'bridge', 'demand',
];

const KNOWN_TERMINAL_TOKENS = [
  'paid off', 'paidoff', 'paid in full', 'pif',
  'satisfied', 'released', 'refinanced', 'repaid',
  'defeased', 'extinguished', 'cancelled', 'canceled',
  'assumed', 'retired', 'inactive', 'discharged',
];
const KNOWN_TERMINAL_PATTERN = new RegExp(
  `\\b(${KNOWN_TERMINAL_TOKENS.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
);

/** See the three-bucket design note above. */
function classifyLoanStatus(status: string): 'active' | 'terminal' | 'unrecognized' {
  const normalized = normalizeLoanStatusText(status);
  if (KNOWN_ACTIVE_PREFIXES.some((p) => normalized.startsWith(p))) return 'active';
  if (KNOWN_TERMINAL_PATTERN.test(normalized)) return 'terminal';
  return 'unrecognized';
}

/**
 * Writes a snapshot of ORA borrower-side debt positions to the warehouse.
 * Filters to direction === 'borrower' and active loans only (null status, or classifyLoanStatus()
 * resolving to 'active'/'unrecognized' — see the three-bucket design note above). A loan id that
 * collides with another loan's id in the same batch is excluded from the write entirely (see
 * F-collision below) rather than silently overwritten.
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

  // Filter: borrower-side only, active — null status, or classifyLoanStatus() resolves to
  // 'active' or 'unrecognized' (see the three-bucket design note above). An 'unrecognized' status
  // is deliberately KEPT active but flagged, never silently dropped.
  const borrowerLoansAll = loans.filter((l) => {
    if (l.direction !== 'borrower') return false;
    if (l.status === null) return true;
    const classification = classifyLoanStatus(l.status);
    if (classification === 'unrecognized') {
      errors.push(
        `loan ${l.id}: unrecognized status '${l.status}' — kept active but unverified; add to KNOWN_ACTIVE_PREFIXES or KNOWN_TERMINAL_TOKENS in debt-snapshot.ts once confirmed`,
      );
    }
    return classification !== 'terminal';
  });

  // F-collision: parseLoans (server/workbook/parse.ts) has no id-disambiguation for loans (unlike
  // properties, which go through disambiguatePropertyIds) — two distinct loans whose names
  // normalize to the same slug SHARE an id. Caught on adversarial review (2026-07-10, determinism
  // lens): this was LATENT before the status-filter fix above, because the old allowlist matched 0
  // real loans, so borrowerLoans was always empty and this collision path never ran. Rather than
  // let the upsert's ON CONFLICT(id, snapshot_date) last-write-wins silently pick one loan and
  // drop the other — with the surviving row's balance/LTV/maturity then depending on workbook/
  // iteration order — detect any id appearing more than once in the incoming batch and exclude
  // ALL of them from the write: a colliding pair's figures are untrustworthy until the id
  // collision itself is resolved (rename one loan in the workbook so its slug differs, or add id
  // disambiguation to parseLoans the way properties already have). The colliding id is still
  // included in the F-stale incoming-id set below, so a previously-written row for it is preserved
  // rather than superseded — we are not confident enough to touch it in either direction.
  const idCounts = new Map<string, number>();
  for (const loan of borrowerLoansAll) idCounts.set(loan.id, (idCounts.get(loan.id) ?? 0) + 1);
  const collidingIds = new Set([...idCounts.entries()].filter(([, n]) => n > 1).map(([id]) => id));
  for (const id of collidingIds) {
    const names = borrowerLoansAll.filter((l) => l.id === id).map((l) => l.name).join(' | ');
    errors.push(
      `loan id '${id}' collides across ${idCounts.get(id)} distinct loans (${names}) — none written this snapshot; rename in the workbook to disambiguate`,
    );
  }
  const borrowerLoans = borrowerLoansAll.filter((l) => !collidingIds.has(l.id));

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
    // F-stale: supersede all previously-active rows whose id is not in the incoming set. Uses
    // borrowerLoansAll (not the collision-filtered borrowerLoans) so a colliding id's PRIOR row is
    // preserved rather than superseded — we are not confident enough to touch it either direction.
    const incomingIds = JSON.stringify(borrowerLoansAll.map((l) => l.id));
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
