// @vitest-environment node
//
// tests/unit/debt-snapshot.test.ts
//
// Phase 2 Steps 1–3 + binding fixes — debt_positions snapshot writer.
// Verifies writeDebtSnapshot() write path, upsert semantics, supersede path,
// demand-note handling, and lender-column suppression in the DebtPosition Zod type.
//
// Uses in-memory SQLite (tmpdir) — never touches data/warehouse/finance.sqlite.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import { writeDebtSnapshot } from '../../server/warehouse/debt-snapshot';
import { DebtPosition } from '../../src/contracts/debt';
import type { Loan } from '../../src/contracts/index';

function freshDb(): WarehouseDb {
  const dir = mkdtempSync(join(tmpdir(), 'debt-snapshot-test-'));
  return openWarehouse(join(dir, 'test.sqlite'));
}

/** Minimal borrower loan fixture. */
function makeBorrowerLoan(overrides: Partial<Loan> = {}): Loan {
  return {
    id: 'loan-001',
    name: 'First Mortgage — 123 Main St',
    counterparty: 'First National Bank',
    direction: 'borrower',
    originalPrincipal: 1_000_000,
    currentBalance: 850_000,
    absBalance: 850_000,
    rate: 0.065,
    monthlyPmt: 5_700,
    annualInterest: 55_250,
    annualPrincipal: 13_150,
    loanType: 'Amortizing',
    status: 'Active',
    isDemand: false,
    maturity: '2030-06-01',
    monthsToMaturity: 48,
    ltv: 0.62,
    lender: 'First National Bank',
    balloon: false,
    flags: [],
    collateralProperty: null,
    ...overrides,
  };
}

describe('writeDebtSnapshot — direction filter', () => {
  it('writes borrower loans and excludes lender and internal loans', () => {
    const db = freshDb();
    const loans: Loan[] = [
      makeBorrowerLoan({ id: 'loan-b', direction: 'borrower' }),
      makeBorrowerLoan({ id: 'loan-l', direction: 'lender' }),
      makeBorrowerLoan({ id: 'loan-i', direction: 'internal' }),
    ];
    const result = writeDebtSnapshot(db, loans, '2026-06-21');
    expect(result.written).toBe(1);
    expect(result.errors).toHaveLength(0);

    const rows = db.prepare("SELECT id FROM debt_positions WHERE status = 'active'").all() as Array<{ id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('loan-b');
  });

  it('excludes loans with non-Active status when status is set', () => {
    const db = freshDb();
    const loans: Loan[] = [
      makeBorrowerLoan({ id: 'loan-active', status: 'Active' }),
      makeBorrowerLoan({ id: 'loan-null', status: null }),
      makeBorrowerLoan({ id: 'loan-paid', status: 'Paid Off' }),
      makeBorrowerLoan({ id: 'loan-retired', status: 'Retired' }),
    ];
    const result = writeDebtSnapshot(db, loans, '2026-06-21');
    expect(result.written).toBe(2); // Active + null
    const ids = (db.prepare("SELECT id FROM debt_positions WHERE status = 'active' ORDER BY id").all() as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toContain('loan-active');
    expect(ids).toContain('loan-null');
  });

  // Loan.status is free-form workbook text (src/contracts/loan.ts), not a fixed enum. The real
  // Loan Index tab never uses the literal word "Active" for a live loan — it uses descriptive
  // loan-type/maturity text instead. Confirmed empirically 2026-07-10 against the live workbook:
  // all 5 real borrower loans carried statuses like these and were silently excluded by a prior
  // allowlist-based filter, leaving debt_positions permanently empty.
  it('includes real-world descriptive active statuses (Amortizing, Interest Only, Balloon Due <date>)', () => {
    const db = freshDb();
    const loans: Loan[] = [
      makeBorrowerLoan({ id: 'loan-amortizing', status: 'Amortizing' }),
      makeBorrowerLoan({ id: 'loan-io', status: 'Interest Only' }),
      makeBorrowerLoan({ id: 'loan-balloon-due', status: 'Balloon Due Feb-27' }),
    ];
    const result = writeDebtSnapshot(db, loans, '2026-07-10');
    expect(result.written).toBe(3);
    const ids = (db.prepare("SELECT id FROM debt_positions WHERE status = 'active' ORDER BY id").all() as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toEqual(['loan-amortizing', 'loan-balloon-due', 'loan-io']);
    expect(result.errors).toHaveLength(0);
  });

  it('excludes known-terminal status text confirmed safe (no active-vocabulary collision): Inactive, Retired, Discharged', () => {
    const db = freshDb();
    const loans: Loan[] = [
      makeBorrowerLoan({ id: 'loan-inactive', status: 'Inactive' }),
      makeBorrowerLoan({ id: 'loan-retired', status: 'Retired' }),
      makeBorrowerLoan({ id: 'loan-discharged', status: 'Discharged' }),
    ];
    const result = writeDebtSnapshot(db, loans, '2026-07-10');
    expect(result.written).toBe(0);
    const rows = db.prepare("SELECT id FROM debt_positions WHERE status = 'active'").all() as Array<{ id: string }>;
    expect(rows).toHaveLength(0);
  });

  // Adversarial review round 1 (2026-07-10) caught: a bare "closed" denylist term collides with
  // "Closed-End" / "Closed End" — a standard commercial-mortgage STRUCTURE term (vs.
  // open-end/revolving), not a payoff signal. Round 2 then caught that the round-1 fix
  // (a negative lookahead tolerating only one ASCII hyphen/space) still missed ORA's own
  // em-dash/en-dash/spaced-dash house style and double-spaced variants — all now handled by
  // normalizing dash variants + whitespace to a single space BEFORE classification, and treating
  // "closed end" as its own KNOWN_ACTIVE_PREFIX (checked before any terminal check ever runs).
  it('does NOT exclude "Closed-End" loan-structure text in ANY separator form (hyphen, em-dash, en-dash, spaced, double-spaced)', () => {
    const db = freshDb();
    const loans: Loan[] = [
      makeBorrowerLoan({ id: 'loan-hyphen', status: 'Closed-End' }),
      makeBorrowerLoan({ id: 'loan-space-note', status: 'Closed End Note' }),
      makeBorrowerLoan({ id: 'loan-emdash', status: 'Closed—End' }),
      makeBorrowerLoan({ id: 'loan-endash-spaced', status: 'Closed – End' }),
      makeBorrowerLoan({ id: 'loan-hyphen-spaced', status: 'Closed - End' }),
      makeBorrowerLoan({ id: 'loan-double-space', status: 'Closed  End' }),
    ];
    const result = writeDebtSnapshot(db, loans, '2026-07-10');
    expect(result.written).toBe(6);
    expect(result.errors).toHaveLength(0);
  });

  // Round 2 also caught a bare "closed" substring colliding with "Undisclosed" (mid-word) and
  // "Closed to Prepayment" (a live prepayment-lockout period, not a payoff). Bare "closed" is
  // deliberately NOT a terminal token at all now (only "closed end" is recognized, as an ACTIVE
  // prefix) — an unqualified "Closed" falls to the unrecognized bucket (kept active + flagged)
  // rather than being guessed either way.
  it('does NOT exclude "Undisclosed" or "Closed to Prepayment" (both real active-loan collisions found on review)', () => {
    const db = freshDb();
    const loans: Loan[] = [
      makeBorrowerLoan({ id: 'loan-undisclosed', status: 'Undisclosed' }),
      makeBorrowerLoan({ id: 'loan-prepay-lockout', status: 'Closed to Prepayment' }),
    ];
    const result = writeDebtSnapshot(db, loans, '2026-07-10');
    expect(result.written).toBe(2);
    // Both are genuinely ambiguous/unrecognized text -- kept active, but flagged for a human to verify.
    expect(result.errors.some((e) => e.includes('loan-undisclosed'))).toBe(true);
    expect(result.errors.some((e) => e.includes('loan-prepay-lockout'))).toBe(true);
  });

  // Round 1 added a bare "payoff" alternative reasoning from this codebase's OWN vocabulary
  // (src/analytics/conditions.ts). Round 2 proved that reasoning backwards: conditions.ts:218
  // uses "payoff" as a FORWARD-LOOKING action on a LIVE balloon ("Prepare refinance or payoff"),
  // not a completed state, and "Payoff Pending/Scheduled/Requested" describe loans still
  // outstanding. Bare "payoff" is deliberately DROPPED from the terminal vocabulary; only the
  // unambiguous completed-state phrasings ("paid off", "paid in full", "pif") signal terminal.
  it('does NOT exclude "Payoff" or in-process payoff notes (Payoff Pending/Scheduled) — these describe a STILL-OUTSTANDING loan', () => {
    const db = freshDb();
    const loans: Loan[] = [
      makeBorrowerLoan({ id: 'loan-payoff-bare', status: 'Payoff' }),
      makeBorrowerLoan({ id: 'loan-payoff-pending', status: 'Payoff Pending' }),
      makeBorrowerLoan({ id: 'loan-payoff-scheduled', status: 'Payoff Scheduled 8/1' }),
      makeBorrowerLoan({ id: 'loan-io-payoff-note', status: 'Interest Only; payoff at balloon Feb-27' }),
    ];
    const result = writeDebtSnapshot(db, loans, '2026-07-10');
    expect(result.written).toBe(4);
  });

  it('excludes unambiguous completed-payoff phrasings: "Paid Off", "Paid-Off", "Paid in Full", "PIF"', () => {
    const db = freshDb();
    const loans: Loan[] = [
      makeBorrowerLoan({ id: 'loan-paid-off-space', status: 'Paid Off' }),
      makeBorrowerLoan({ id: 'loan-paid-off-hyphen', status: 'Paid-Off' }),
      makeBorrowerLoan({ id: 'loan-paid-in-full', status: 'Paid in Full' }),
      makeBorrowerLoan({ id: 'loan-pif', status: 'PIF' }),
    ];
    const result = writeDebtSnapshot(db, loans, '2026-07-10');
    expect(result.written).toBe(0);
  });

  // Round 2's HIGH-severity finding: the round-1 denylist was missing standard commercial-mortgage
  // terminal vocabulary entirely, so a real "Refinanced" old-loan row would stay active and
  // DOUBLE-COUNT debt against its own replacement loan (both rows on the same property summed by
  // debt-scoring.ts). Added the full confirmed-safe set (no known active-vocabulary collision).
  it('excludes the expanded standard commercial-mortgage terminal vocabulary (Satisfied, Released, Refinanced, Repaid, Defeased, Extinguished, Cancelled/Canceled, Assumed)', () => {
    const db = freshDb();
    const loans: Loan[] = [
      makeBorrowerLoan({ id: 'loan-satisfied', status: 'Satisfied' }),
      makeBorrowerLoan({ id: 'loan-released', status: 'Released' }),
      makeBorrowerLoan({ id: 'loan-refinanced', status: 'Refinanced' }),
      makeBorrowerLoan({ id: 'loan-repaid', status: 'Repaid' }),
      makeBorrowerLoan({ id: 'loan-defeased', status: 'Defeased' }),
      makeBorrowerLoan({ id: 'loan-extinguished', status: 'Extinguished' }),
      makeBorrowerLoan({ id: 'loan-cancelled', status: 'Cancelled' }),
      makeBorrowerLoan({ id: 'loan-canceled', status: 'Canceled' }),
      makeBorrowerLoan({ id: 'loan-assumed', status: 'Assumed' }),
    ];
    const result = writeDebtSnapshot(db, loans, '2026-07-10');
    expect(result.written).toBe(0);
  });

  // Round 2 found "Swap Terminated"/"Rate Cap Terminated"/"Hedge Terminated" describe a hedge
  // instrument ending on a still-fully-active loan, not the loan itself ending — bare "terminated"
  // is deliberately NOT a terminal token (dropped from round 1); this text now falls to the
  // unrecognized bucket (kept active + flagged), never silently excluded.
  it('does NOT exclude hedge-related "Terminated" notes on an otherwise-active loan (Swap/Rate Cap/Hedge Terminated)', () => {
    const db = freshDb();
    const loans: Loan[] = [
      makeBorrowerLoan({ id: 'loan-swap-term', status: 'Swap Terminated' }),
      makeBorrowerLoan({ id: 'loan-cap-term', status: 'Rate Cap Terminated' }),
      makeBorrowerLoan({ id: 'loan-hedge-term', status: 'Hedge Terminated' }),
    ];
    const result = writeDebtSnapshot(db, loans, '2026-07-10');
    expect(result.written).toBe(3);
    expect(result.errors.some((e) => e.includes('loan-swap-term'))).toBe(true);
  });

  // Any status matching neither bucket must be kept active AND surfaced — never a silent guess
  // in either direction (the root design fix both rounds converged on recommending).
  it('a genuinely unrecognized status is kept active and surfaced in errors[]', () => {
    const db = freshDb();
    const result = writeDebtSnapshot(db, [makeBorrowerLoan({ id: 'loan-novel', status: 'Some Brand New Note Text' })], '2026-07-10');
    expect(result.written).toBe(1);
    expect(result.errors.some((e) => e.includes('loan-novel') && e.includes('unrecognized status'))).toBe(true);
  });
});

describe('writeDebtSnapshot — F-collision: colliding loan ids', () => {
  // Adversarial review (2026-07-10, determinism lens): parseLoans has no id-disambiguation for
  // loans (unlike properties). Two distinct loans whose names normalize to the same slug share an
  // id; the upsert's ON CONFLICT(id, snapshot_date) is last-write-wins, so without this guard one
  // real loan silently vanishes and the surviving row's balance/LTV/maturity depend on array order
  // — empirically demonstrated to flip between two permutations of the identical input set.
  it('a colliding loan id is excluded from the write entirely (neither loan written), and surfaced in errors[]', () => {
    const db = freshDb();
    const loanA = makeBorrowerLoan({ id: 'dup-id', name: '1100 Rarig Ave', currentBalance: 4_000_000, absBalance: 4_000_000, ltv: 0.40 });
    const loanB = makeBorrowerLoan({ id: 'dup-id', name: '1100 Rarig Ave.', currentBalance: 1_200_000, absBalance: 1_200_000, ltv: 0.62 });

    const resultOrderAB = writeDebtSnapshot(db, [loanA, loanB], '2026-07-10');
    expect(resultOrderAB.written).toBe(0);
    expect(resultOrderAB.errors.some((e) => e.includes('dup-id') && e.includes('collides'))).toBe(true);
    const rows = db.prepare("SELECT id FROM debt_positions WHERE id = 'dup-id'").all();
    expect(rows).toHaveLength(0);

    // Permuting order must not change the outcome -- neither permutation writes a row for the
    // colliding id (this is the property the original bug violated: order determined the winner).
    const db2 = freshDb();
    const resultOrderBA = writeDebtSnapshot(db2, [loanB, loanA], '2026-07-10');
    expect(resultOrderBA.written).toBe(0);
  });

  it('a colliding id does not clobber a PRIOR real snapshot row for that id (preserved, not superseded)', () => {
    const db = freshDb();
    // First snapshot: a single, unambiguous loan writes cleanly.
    const original = makeBorrowerLoan({ id: 'was-fine', name: 'Original Loan', currentBalance: 500_000, absBalance: 500_000 });
    writeDebtSnapshot(db, [original], '2026-06-01');
    const before = db.prepare("SELECT current_balance FROM debt_positions WHERE id = 'was-fine' AND status = 'active'").get() as { current_balance: number } | undefined;
    expect(before?.current_balance).toBe(500_000);

    // Second snapshot: a NEW loan happens to collide on the same id -- must not supersede the
    // prior good row, since we can't safely tell which (if either) new loan corresponds to it.
    const collideA = makeBorrowerLoan({ id: 'was-fine', name: 'Collider A', currentBalance: 900_000, absBalance: 900_000 });
    const collideB = makeBorrowerLoan({ id: 'was-fine', name: 'Collider B', currentBalance: 100_000, absBalance: 100_000 });
    writeDebtSnapshot(db, [collideA, collideB], '2026-07-10');

    const after = db.prepare("SELECT current_balance, status FROM debt_positions WHERE id = 'was-fine' AND snapshot_date = '2026-06-01'").get() as { current_balance: number; status: string } | undefined;
    expect(after?.status).toBe('active'); // NOT superseded
    expect(after?.current_balance).toBe(500_000); // untouched
  });
});

describe('writeDebtSnapshot — upsert semantics', () => {
  it('running twice with same snapshotDate updates the row; row count stays 1', () => {
    const db = freshDb();
    const loan = makeBorrowerLoan({ currentBalance: 850_000, absBalance: 850_000 });

    writeDebtSnapshot(db, [loan], '2026-06-21');
    // absBalance must match so the stored positive magnitude reflects the updated balance
    const loanV2 = { ...loan, currentBalance: 840_000, absBalance: 840_000 };
    writeDebtSnapshot(db, [loanV2], '2026-06-21');

    const rows = db.prepare("SELECT current_balance FROM debt_positions WHERE id = ? AND status = 'active'").all('loan-001') as Array<{ current_balance: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.current_balance).toBe(840_000);
  });
});

describe('writeDebtSnapshot — supersede on new snapshotDate', () => {
  it('old row is marked superseded and a new active row is inserted on a new snapshotDate', () => {
    const db = freshDb();
    const loan = makeBorrowerLoan({ currentBalance: 850_000, absBalance: 850_000 });

    writeDebtSnapshot(db, [loan], '2026-05-01');
    writeDebtSnapshot(db, [{ ...loan, currentBalance: 840_000, absBalance: 840_000 }], '2026-06-01');

    const superseded = db.prepare("SELECT id FROM debt_positions WHERE id = ? AND status = 'superseded'").all('loan-001') as Array<{ id: string }>;
    const active = db.prepare("SELECT current_balance, snapshot_date FROM debt_positions WHERE id = ? AND status = 'active'").all('loan-001') as Array<{ current_balance: number; snapshot_date: string }>;

    expect(superseded).toHaveLength(1);
    expect(active).toHaveLength(1);
    expect(active[0]?.current_balance).toBe(840_000);
    expect(active[0]?.snapshot_date).toBe('2026-06-01');
  });
});

describe('writeDebtSnapshot — demand notes', () => {
  it('handles demand notes (isDemand=true, null maturity) without error', () => {
    const db = freshDb();
    const demandNote = makeBorrowerLoan({
      id: 'loan-demand',
      isDemand: true,
      maturity: null,
      monthsToMaturity: null,
    });
    const result = writeDebtSnapshot(db, [demandNote], '2026-06-21');
    expect(result.written).toBe(1);
    expect(result.errors).toHaveLength(0);

    const row = db.prepare("SELECT is_demand, maturity_date FROM debt_positions WHERE id = ?").get('loan-demand') as { is_demand: number; maturity_date: string | null };
    expect(row.is_demand).toBe(1);
    expect(row.maturity_date).toBeNull();
  });
});

// ── F-stale: stale-row reconcile ─────────────────────────────────────────────────────────

describe('writeDebtSnapshot — F-stale: stale-row reconcile (paid-off loan removed)', () => {
  it('snapshot [A,B] then [A] → only A remains active; B is superseded', () => {
    const db = freshDb();

    const loanA = makeBorrowerLoan({ id: 'loan-A', name: 'Loan A' });
    const loanB = makeBorrowerLoan({ id: 'loan-B', name: 'Loan B' });

    // First snapshot: both A and B are active
    writeDebtSnapshot(db, [loanA, loanB], '2026-05-01');

    const afterFirst = db
      .prepare("SELECT id, status FROM debt_positions WHERE status = 'active' ORDER BY id")
      .all() as Array<{ id: string; status: string }>;
    expect(afterFirst.map((r) => r.id)).toEqual(['loan-A', 'loan-B']);

    // Second snapshot: B is removed (paid off) — only A is in the incoming set
    writeDebtSnapshot(db, [loanA], '2026-06-01');

    const activeAfter = db
      .prepare("SELECT id FROM debt_positions WHERE status = 'active' ORDER BY id")
      .all() as Array<{ id: string }>;
    expect(activeAfter.map((r) => r.id)).toEqual(['loan-A']);

    // B must be superseded, not dropped
    const bRow = db
      .prepare("SELECT id, status FROM debt_positions WHERE id = 'loan-B'")
      .get() as { id: string; status: string } | undefined;
    expect(bRow).toBeDefined();
    expect(bRow?.status).toBe('superseded');
  });
});

// ── H2a: empty-snapshot book wipe ────────────────────────────────────────────────────────
//
// 2026-07-24 financial-code integrity sweep (edges lens). The F-stale clause above supersedes
// every active row whose id is absent from the incoming set. With an EMPTY incoming set that
// retires the entire book in one statement — and computePortfolioAggregateLtv then read the
// resulting zero-row cohort as "no debt" and reported a Hard-Invariant-4 CLEARANCE. An empty
// borrower set is far more likely to mean an upstream parse regression (direction column moved,
// Loan Index tab renamed) than a genuinely debt-free portfolio, so it must never silently wipe.

describe('writeDebtSnapshot — H2a: an empty borrower set must not wipe the book', () => {
  it('refuses the whole-book supersede, keeps rows active, and surfaces a loud error', () => {
    const db = freshDb();
    const loanA = makeBorrowerLoan({ id: 'loan-A', name: 'Loan A' });
    const loanB = makeBorrowerLoan({ id: 'loan-B', name: 'Loan B' });
    writeDebtSnapshot(db, [loanA, loanB], '2026-05-01');

    const result = writeDebtSnapshot(db, [], '2026-06-01');

    const stillActive = db
      .prepare("SELECT id FROM debt_positions WHERE status = 'active' ORDER BY id")
      .all() as Array<{ id: string }>;
    expect(stillActive.map((r) => r.id)).toEqual(['loan-A', 'loan-B']);
    expect(result.written).toBe(0);
    expect(result.errors.join(' ')).toMatch(/empty borrower set/i);
    // Typed signal (2026-07-24, round-2 refute-review) — callers (POST /snapshot, the backfill
    // CLI) key off this field, not the prose message, so a wording edit can't silently break them.
    expect(result.refusedEmptySupersede).toBe(true);
  });

  it('an explicit allowEmptySupersede opt-in still performs the wipe (verified zero-debt state)', () => {
    const db = freshDb();
    writeDebtSnapshot(db, [makeBorrowerLoan({ id: 'loan-A' })], '2026-05-01');

    const result = writeDebtSnapshot(db, [], '2026-06-01', undefined, { allowEmptySupersede: true });

    const active = db
      .prepare("SELECT id FROM debt_positions WHERE status = 'active'")
      .all() as Array<{ id: string }>;
    expect(active).toHaveLength(0);
    expect(result.errors.join(' ')).not.toMatch(/empty borrower set/i);
    expect(result.refusedEmptySupersede).toBe(false);
  });

  it('an empty snapshot against an already-empty book is a silent no-op, not an error', () => {
    const db = freshDb();
    const result = writeDebtSnapshot(db, [], '2026-06-01');
    expect(result.written).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.refusedEmptySupersede).toBe(false);
  });

  // Known, documented tradeoff (see the KNOWN TRADEOFF comment above the guard): a genuine
  // full payoff of a borrower's LAST loan is indistinguishable, from this function's inputs
  // alone, from an upstream parse bug that emptied the loans array. Both require the explicit
  // opt-in — pinned here so the behavior is a considered choice, not an untested surprise.
  it('a legitimate full payoff of the LAST loan also requires the explicit opt-in (documented tradeoff)', () => {
    const db = freshDb();
    const loanA = makeBorrowerLoan({ id: 'loan-A', name: 'Loan A' });
    writeDebtSnapshot(db, [loanA], '2026-05-01');

    // The payload is NOT empty — it carries the paid-off loan with a terminal status — but it
    // classifies to zero SURVIVING borrower loans, the same signal an empty payload produces.
    const paidOff = makeBorrowerLoan({ id: 'loan-A', name: 'Loan A', status: 'Paid Off' });
    const result = writeDebtSnapshot(db, [paidOff], '2026-06-01');

    const stillActive = db
      .prepare("SELECT id FROM debt_positions WHERE status = 'active'")
      .all() as Array<{ id: string }>;
    // Refused, same as the bug case: the loan stays visibly active rather than silently vanish.
    expect(stillActive.map((r) => r.id)).toEqual(['loan-A']);
    expect(result.errors.join(' ')).toMatch(/empty borrower set/i);

    // The opt-in resolves it, exactly as it does for the bug case.
    const optedIn = writeDebtSnapshot(db, [paidOff], '2026-06-02', undefined, { allowEmptySupersede: true });
    const afterOptIn = db
      .prepare("SELECT id FROM debt_positions WHERE status = 'active'")
      .all() as Array<{ id: string }>;
    expect(afterOptIn).toHaveLength(0);
    expect(optedIn.errors.join(' ')).not.toMatch(/empty borrower set/i);
  });

  it('a non-empty snapshot still supersedes stale rows normally (guard is scoped to empty)', () => {
    const db = freshDb();
    const loanA = makeBorrowerLoan({ id: 'loan-A', name: 'Loan A' });
    const loanB = makeBorrowerLoan({ id: 'loan-B', name: 'Loan B' });
    writeDebtSnapshot(db, [loanA, loanB], '2026-05-01');

    writeDebtSnapshot(db, [loanA], '2026-06-01');

    const active = db
      .prepare("SELECT id FROM debt_positions WHERE status = 'active' ORDER BY id")
      .all() as Array<{ id: string }>;
    expect(active.map((r) => r.id)).toEqual(['loan-A']);
  });
});

// ── Partial-wipe shrinkage guard (follow-up to H2a, flagged by Gabriel post-sweep) ────────
//
// H2a as originally built refuses ONLY a fully-empty incoming set. A subtler parse regression
// — a status classifier newly misreading one column, a workbook tab partially truncated —
// could leave a NON-empty but drastically SHRUNKEN incoming set (e.g. 1 of 12 loans surviving),
// which still silently supersedes the other 11 real active rows through the exact same F-stale
// path, still reachable via the exact same route (POST /snapshot, the automated reload, the
// backfill CLI). The rule below generalizes H2a from "0 incoming" to "an unexplained MAJORITY of
// the book about to disappear":
//
//   REFUSE when (net rows that would be lost) >= MIN_SUPERSEDED_ROWS_FOR_SHRINKAGE_GUARD (2)
//           AND (net rows lost) / (current active rows) >= MAX_SUPERSEDE_SHARE (0.5)
//   net rows lost = max(activeRowCount - borrowerLoansAll.length, 0)
//
// CONTRACT CORRECTION (round 4, adversarial-review finding, HIGH): the first version of this
// guard measured id-set overlap (how many PREVIOUSLY-active ids are missing from the incoming
// set), not NET shrinkage. That version could not tell a genuine parse regression apart from an
// ORDINARY portfolio refinance or a loan renamed for the codebase's own documented
// slug-collision remedy — both retire old loan ids and replace them with new ones at the SAME
// total count, and both tripped the old id-overlap rule exactly as hard as a real regression
// did. Demonstrated (adversarial review, reproduced against the real function): a 12-loan book
// refinances 7 loans under new ids (12 in, 12 out, net shrinkage ZERO) — the old rule refused
// the entire write, so the refi's own new loans never landed, and the STALE pre-refi aggregate
// (a lower, now-wrong LTV) kept reporting `clearedConservatively: true` indefinitely on every
// subsequent automated reload, since nothing downstream distinguishes "refused" from "healthy".
// Measuring NET shrinkage instead (current count vs. incoming count, not id membership) means a
// refi or a rename that keeps the total count intact trips NOTHING, regardless of how many ids
// changed — while a genuine collapse in row count (whether via id churn or a bare drop) still
// does. `>=` (not `>`, corrected from round 3 alongside this fix): once legitimate churn no
// longer touches this predicate at all, an EXACT 50% net collapse has no remaining legitimate
// interpretation and should also require confirmation, not just anything strictly above it.
//
// The absolute floor of 2 is unchanged and still deliberate: a single loan disappearing with NO
// replacement (paid off, and the book is genuinely one loan smaller) is ordinary business and
// must never become guard noise — the ORIGINAL "total wipe, any size" rule (H2a, unchanged
// above) already covers the single-loan-book special case where that one loan IS the whole book.
describe('writeDebtSnapshot — partial-wipe shrinkage guard', () => {
  it('refuses when the active book NET-shrinks by a clear majority with no replacement', () => {
    const db = freshDb();
    const loans = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'].map((s) =>
      makeBorrowerLoan({ id: `loan-${s}`, name: `Loan ${s}` }),
    );
    writeDebtSnapshot(db, loans, '2026-05-01');

    // Only 1 of 12 survives, nothing replaces the other 11 — net shrinkage 11/12 (92%).
    const result = writeDebtSnapshot(db, [loans[0]!], '2026-06-01');

    const active = db
      .prepare("SELECT id FROM debt_positions WHERE status = 'active' ORDER BY id")
      .all() as Array<{ id: string }>;
    expect(active).toHaveLength(12);
    expect(result.written).toBe(0);
    expect(result.refusedEmptySupersede).toBe(true);
    expect(result.errors.join(' ')).toMatch(/11.*12|majority|shrink/i);
  });

  // Regression pin for the round-4 fix — the exact scenario the adversarial review demonstrated.
  it('does NOT refuse a refinance that retires old loan ids and replaces them with new ones at the same count', () => {
    const db = freshDb();
    const loans = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'].map((s) =>
      makeBorrowerLoan({ id: `loan-${s}`, name: `Loan ${s}` }),
    );
    writeDebtSnapshot(db, loans, '2026-05-01');

    // 5 unchanged + 7 NEW loan ids replacing the retired ones — 12 in, 12 out. Net shrinkage 0,
    // even though 7 of 12 previously-active ids are individually absent from the incoming set.
    const refinanced = [
      ...loans.slice(0, 5),
      ...['M', 'N', 'O', 'P', 'Q', 'R', 'S'].map((s) => makeBorrowerLoan({ id: `loan-${s}-refi`, name: `Loan ${s} (refi)` })),
    ];
    const result = writeDebtSnapshot(db, refinanced, '2026-06-01');

    expect(result.refusedEmptySupersede).toBe(false);
    expect(result.written).toBe(12);
    const active = db
      .prepare("SELECT id FROM debt_positions WHERE status = 'active' ORDER BY id")
      .all() as Array<{ id: string }>;
    expect(active).toHaveLength(12);
    // The 7 retired old ids (F-L) must be superseded, not silently left active forever — the
    // exact reason the F-stale clause exists. (The 5 unchanged ids also pick up a superseded
    // row for their prior 2026-05-01 snapshot_date, per this function's normal multi-date upsert
    // semantics — unrelated to this guard, so this checks the specific retired ids, not a raw
    // superseded-row count.)
    const supersededIds = new Set(
      (
        db.prepare("SELECT id FROM debt_positions WHERE status = 'superseded'").all() as Array<{ id: string }>
      ).map((r) => r.id),
    );
    for (const s of ['F', 'G', 'H', 'I', 'J', 'K', 'L']) {
      expect(supersededIds.has(`loan-${s}`)).toBe(true);
    }
  });

  // CONTRACT CORRECTION (round 5, SECOND adversarial-review pass, HIGH severity): the round-4
  // netLoss formula used borrowerLoansAll.length (the RAW incoming count, before the F-collision
  // filter runs) as the "how many loans are incoming" side of the comparison. Duplicate/colliding
  // ids inflate that raw count without producing any actual written or preserved-as-new rows —
  // the F-collision filter (above) excludes EVERY colliding id from the write. A name-column
  // drift that makes many loans slug to the same id therefore inflated borrowerLoansAll.length
  // enough to compute netLoss=0 while the real book silently collapsed underneath — demonstrated
  // by the reviewer up to a TOTAL SILENT WIPE (12-loan book, all 12 collide to one slug, guard
  // never fires, book goes to 0 active rows). netLoss must be computed against the DISTINCT,
  // actually-writable id set (borrowerLoans, post-collision-filter), not the raw incoming count.
  it('refuses when duplicate/colliding ids mask a real collapse (a single name-column drift)', () => {
    const db = freshDb();
    const loans = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'].map((s) =>
      makeBorrowerLoan({ id: `loan-${s}`, name: `Loan ${s}` }),
    );
    writeDebtSnapshot(db, loans, '2026-05-01');

    // A parse regression makes ALL 12 incoming loans slug to the SAME id. Raw incoming count is
    // 12 (matching activeRowCount, which is what let the old formula compute netLoss=0), but the
    // F-collision filter excludes every one of them from the actual write.
    const collided = loans.map((l) => ({ ...l, id: 'loan-drifted' }));
    const result = writeDebtSnapshot(db, collided, '2026-06-01');

    expect(result.refusedEmptySupersede).toBe(true);
    expect(result.written).toBe(0);
    const active = db
      .prepare("SELECT id FROM debt_positions WHERE status = 'active'")
      .all() as Array<{ id: string }>;
    expect(active).toHaveLength(12); // untouched — the whole book was refused, not silently wiped
  });

  it('refuses when a partial collision cluster masks a majority collapse (5 survivors + 7 duplicates)', () => {
    const db = freshDb();
    const loans = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'].map((s) =>
      makeBorrowerLoan({ id: `loan-${s}`, name: `Loan ${s}` }),
    );
    writeDebtSnapshot(db, loans, '2026-05-01');

    // 5 loans keep their real, distinct ids; the other 7 all drift onto ONE shared id. Raw
    // incoming count is still 12 (masking netLoss under the old formula), but only 5 loans are
    // actually writable — the 7 colliding ones are excluded, and the 7 ORIGINAL active rows they
    // were supposed to replace have no surviving replacement at all.
    const mixed = [
      ...loans.slice(0, 5),
      ...loans.slice(5).map((l) => ({ ...l, id: 'loan-drifted' })),
    ];
    const result = writeDebtSnapshot(db, mixed, '2026-06-01');

    expect(result.refusedEmptySupersede).toBe(true);
    expect(result.written).toBe(0);
    const active = db
      .prepare("SELECT id FROM debt_positions WHERE status = 'active'")
      .all() as Array<{ id: string }>;
    expect(active).toHaveLength(12); // untouched
  });

  it('a SMALL, incidental collision (not a majority) does not itself trip the shrinkage guard', () => {
    const db = freshDb();
    const loans = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'].map((s) =>
      makeBorrowerLoan({ id: `loan-${s}`, name: `Loan ${s}` }),
    );
    writeDebtSnapshot(db, loans, '2026-05-01');

    // 8 loans keep distinct ids; 2 (a genuine, unrelated accidental name clash) collide onto one
    // shared id. 2 of 10 lost to the collision (20%) is under the majority threshold — the
    // F-collision mechanism's own narrower handling (preserve their prior rows untouched) is the
    // right response here, not a whole-book refusal.
    const mostlyFine = [
      ...loans.slice(0, 8),
      ...loans.slice(8).map((l) => ({ ...l, id: 'loan-accidental-clash' })),
    ];
    const result = writeDebtSnapshot(db, mostlyFine, '2026-06-01');

    expect(result.refusedEmptySupersede).toBe(false);
    const active = db
      .prepare("SELECT id FROM debt_positions WHERE status = 'active'")
      .all() as Array<{ id: string }>;
    expect(active).toHaveLength(8); // the 8 clean loans wrote; the 2 colliding ids' prior rows preserved untouched
  });

  // CONTRACT CORRECTION (round 6, THIRD independent adversarial-review pass, MEDIUM severity):
  // the round-5 fix computed distinctWritableIds from `borrowerLoans` alone — the F-collision
  // filter, correctly, excludes a colliding id from being FRESHLY WRITTEN, but the F-stale clause
  // separately PRESERVES that id's PRIOR row (it's still present in borrowerLoansAll's incoming
  // set, so it's never superseded — see the F-collision comment above: "a previously-written row
  // for it is preserved rather than superseded"). Counting only borrowerLoans therefore treated
  // every preserved-but-colliding id as a LOSS, over-triggering the guard whenever a collision
  // cluster happens to reuse an id that was ALREADY active — reproduced by the reviewer at 12
  // loans / 3 collision clusters onto previously-active ids: the guard refused at a claimed "6 of
  // 12 lost" when the real post-write book would have been 9 of 12 (a genuine loss of only 3,
  // from 3 OTHER loans genuinely absent from the payload — nothing to do with the collisions).
  // netLoss must count the union of (ids freshly written) and (previously-active ids preserved
  // by the F-stale exclusion), not `borrowerLoans` alone.
  it('a collision cluster reusing a PREVIOUSLY-ACTIVE id is preserved, not double-counted as a loss', () => {
    const db = freshDb();
    const loans = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'].map((s) =>
      makeBorrowerLoan({ id: `loan-${s}`, name: `Loan ${s}` }),
    );
    writeDebtSnapshot(db, loans, '2026-05-01');

    // 6 clean survivors (A-F). Three previously-active ids (G, I, K) each get TWO colliding
    // incoming loan objects reusing that exact id — a name-column drift that happens to collide
    // onto an id that was already on the books, not a brand-new one. H, J, L are genuinely
    // absent from this payload entirely (a real, unrelated loss of exactly 3 loans).
    const mixed = [
      ...loans.slice(0, 6), // A-F, unchanged
      makeBorrowerLoan({ id: 'loan-G', name: 'Loan G (drift 1)' }),
      makeBorrowerLoan({ id: 'loan-G', name: 'Loan G (drift 2)' }),
      makeBorrowerLoan({ id: 'loan-I', name: 'Loan I (drift 1)' }),
      makeBorrowerLoan({ id: 'loan-I', name: 'Loan I (drift 2)' }),
      makeBorrowerLoan({ id: 'loan-K', name: 'Loan K (drift 1)' }),
      makeBorrowerLoan({ id: 'loan-K', name: 'Loan K (drift 2)' }),
    ];
    const result = writeDebtSnapshot(db, mixed, '2026-06-01');

    // The TRUE net loss is 3 (H, J, L — genuinely absent), which is 25%: under the 50% guard.
    expect(result.refusedEmptySupersede).toBe(false);

    const active = db
      .prepare("SELECT id FROM debt_positions WHERE status = 'active' ORDER BY id")
      .all() as Array<{ id: string }>;
    // A-F freshly written (6) + G, I, K preserved at their PRIOR values, untouched (3) = 9.
    expect(active.map((r) => r.id)).toEqual([
      'loan-A', 'loan-B', 'loan-C', 'loan-D', 'loan-E', 'loan-F', 'loan-G', 'loan-I', 'loan-K',
    ]);
    // H, J, L (genuinely absent from the payload) must be superseded — the real, unrelated loss.
    // (A-F's PRIOR 2026-05-01 rows are ALSO superseded here, per this function's normal
    // multi-date upsert semantics — unrelated to this guard, see the refi test above.)
    const supersededIds = new Set(
      (
        db.prepare("SELECT id FROM debt_positions WHERE status = 'superseded'").all() as Array<{ id: string }>
      ).map((r) => r.id),
    );
    for (const s of ['H', 'J', 'L']) {
      expect(supersededIds.has(`loan-${s}`)).toBe(true);
    }
    // G, I, K must NOT be superseded — their prior rows are preserved, not lost.
    for (const s of ['G', 'I', 'K']) {
      expect(supersededIds.has(`loan-${s}`)).toBe(false);
    }
  });

  // Regression pin: the codebase's own documented remedy for a loan-id slug collision is
  // "rename in the workbook to disambiguate" (debt-snapshot.ts's F-collision comment). Renaming
  // a majority of loans must not itself trip this guard.
  it('does NOT refuse renaming a majority of loans for slug disambiguation (same count, new ids)', () => {
    const db = freshDb();
    const loans = ['A', 'B', 'C', 'D', 'E'].map((s) => makeBorrowerLoan({ id: `loan-${s}`, name: `Loan ${s}` }));
    writeDebtSnapshot(db, loans, '2026-05-01');

    // 3 of 5 renamed, 2 unchanged — 5 in, 5 out, net shrinkage 0.
    const renamed = [
      ...loans.slice(0, 2),
      ...['C', 'D', 'E'].map((s) => makeBorrowerLoan({ id: `loan-${s}-renamed`, name: `Loan ${s} Renamed` })),
    ];
    const result = writeDebtSnapshot(db, renamed, '2026-06-01');

    expect(result.refusedEmptySupersede).toBe(false);
    expect(result.written).toBe(5);
  });

  it('allows a minority NET reduction to churn normally (one loan paid off out of many, no replacement)', () => {
    const db = freshDb();
    const loans = ['A', 'B', 'C', 'D', 'E'].map((s) => makeBorrowerLoan({ id: `loan-${s}`, name: `Loan ${s}` }));
    writeDebtSnapshot(db, loans, '2026-05-01');

    // 4 of 5 survive, nothing replaces the missing one — net shrinkage 1/5 (20%), under the guard.
    const result = writeDebtSnapshot(db, loans.slice(0, 4), '2026-06-01');

    const active = db
      .prepare("SELECT id FROM debt_positions WHERE status = 'active' ORDER BY id")
      .all() as Array<{ id: string }>;
    expect(active).toHaveLength(4);
    expect(result.refusedEmptySupersede).toBe(false);
  });

  it('refuses an exact 50% NET collapse with no replacement (inclusive threshold, corrected from round 3)', () => {
    const db = freshDb();
    const loans = ['A', 'B', 'C', 'D'].map((s) => makeBorrowerLoan({ id: `loan-${s}`, name: `Loan ${s}` }));
    writeDebtSnapshot(db, loans, '2026-05-01');

    // Exactly half (2 of 4) survive, nothing replaces the other 2 — net shrinkage exactly 50%.
    const result = writeDebtSnapshot(db, loans.slice(0, 2), '2026-06-01');

    expect(result.refusedEmptySupersede).toBe(true);
    const active = db
      .prepare("SELECT id FROM debt_positions WHERE status = 'active'")
      .all() as Array<{ id: string }>;
    expect(active).toHaveLength(4); // refused — nothing written, prior book untouched
  });

  it('never trips on a single loan disappearing with no replacement, regardless of how small the book is', () => {
    const db = freshDb();
    const loans = ['A', 'B'].map((s) => makeBorrowerLoan({ id: `loan-${s}`, name: `Loan ${s}` }));
    writeDebtSnapshot(db, loans, '2026-05-01');

    // 1 of 2 survives — net shrinkage 1, which fails the absolute floor of 2 regardless of %.
    const result = writeDebtSnapshot(db, [loans[0]!], '2026-06-01');

    expect(result.refusedEmptySupersede).toBe(false);
    const active = db
      .prepare("SELECT id FROM debt_positions WHERE status = 'active'")
      .all() as Array<{ id: string }>;
    expect(active).toHaveLength(1);
  });

  it('the explicit opt-in still performs a majority supersede when verified', () => {
    const db = freshDb();
    const loans = ['A', 'B', 'C', 'D', 'E'].map((s) => makeBorrowerLoan({ id: `loan-${s}`, name: `Loan ${s}` }));
    writeDebtSnapshot(db, loans, '2026-05-01');

    const result = writeDebtSnapshot(db, [loans[0]!], '2026-06-01', undefined, { allowEmptySupersede: true });

    const active = db
      .prepare("SELECT id FROM debt_positions WHERE status = 'active'")
      .all() as Array<{ id: string }>;
    expect(active).toHaveLength(1);
    expect(result.refusedEmptySupersede).toBe(false);
  });

  it('a majority-shrinkage refusal leaves ALL previously-active rows untouched, not just the missing ones', () => {
    const db = freshDb();
    const loans = ['A', 'B', 'C'].map((s) => makeBorrowerLoan({ id: `loan-${s}`, name: `Loan ${s}` }));
    writeDebtSnapshot(db, loans, '2026-05-01');

    // 1 of 3 survives, no replacement — net shrinkage 2 (67%, and 2 >= the absolute floor).
    writeDebtSnapshot(db, [loans[0]!], '2026-06-01');

    const active = db
      .prepare("SELECT id FROM debt_positions WHERE status = 'active' ORDER BY id")
      .all() as Array<{ id: string }>;
    expect(active.map((r) => r.id)).toEqual(['loan-A', 'loan-B', 'loan-C']);
  });
});

// ── F-FK-safe: property_id validated before insert ───────────────────────────────────────

describe('writeDebtSnapshot — F-FK-safe: invalid property_id → null + surfaced', () => {
  it('map value not in property_master → row written with property_id=null, error surfaced, not dropped', () => {
    const db = freshDb();

    const loan = makeBorrowerLoan({ id: 'loan-bad-prop' });
    // Map points to a property id that is NOT in property_master
    const badMap = new Map([['loan-bad-prop', 'nonexistent-property-id']]);

    const result = writeDebtSnapshot(db, [loan], '2026-06-01', badMap);

    // Row must be written (not dropped)
    expect(result.written).toBe(1);
    // Error must be surfaced
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('loan-bad-prop');

    // property_id must be null in the DB (not the invalid id)
    const row = db
      .prepare('SELECT property_id FROM debt_positions WHERE id = ?')
      .get('loan-bad-prop') as { property_id: string | null } | undefined;
    expect(row).toBeDefined();
    expect(row?.property_id).toBeNull();
  });

  it('valid property_id in property_master → written with correct property_id', () => {
    const db = freshDb();

    // Seed a property_master row
    db.prepare(
      `INSERT INTO property_master (id, name, market, rentable_sf, acquisition_date)
       VALUES ('prop-valid', 'Valid Property', 'Columbus', 20000, '2020-01-01')`,
    ).run();

    const loan = makeBorrowerLoan({ id: 'loan-good-prop' });
    const goodMap = new Map([['loan-good-prop', 'prop-valid']]);

    const result = writeDebtSnapshot(db, [loan], '2026-06-01', goodMap);

    expect(result.written).toBe(1);
    expect(result.errors).toHaveLength(0);

    const row = db
      .prepare('SELECT property_id FROM debt_positions WHERE id = ?')
      .get('loan-good-prop') as { property_id: string | null } | undefined;
    expect(row?.property_id).toBe('prop-valid');
  });
});

// ── snapshot_date from generatedAt (not static asOf) ─────────────────────────────────────

describe('writeDebtSnapshot — snapshot_date is the caller-supplied date (generatedAt, not static)', () => {
  it('two refreshes on different dates → two rows (one active, one superseded)', () => {
    const db = freshDb();
    const loan = makeBorrowerLoan({ currentBalance: 800_000, absBalance: 800_000 });

    // Simulate refresh on 2026-06-10 (generatedAt)
    writeDebtSnapshot(db, [loan], '2026-06-10');
    // Simulate refresh on 2026-06-21 (generatedAt — different date)
    writeDebtSnapshot(db, [{ ...loan, currentBalance: 790_000, absBalance: 790_000 }], '2026-06-21');

    const all = db
      .prepare('SELECT snapshot_date, status, current_balance FROM debt_positions WHERE id = ? ORDER BY snapshot_date')
      .all('loan-001') as Array<{ snapshot_date: string; status: string; current_balance: number }>;

    expect(all).toHaveLength(2);
    expect(all[0]?.snapshot_date).toBe('2026-06-10');
    expect(all[0]?.status).toBe('superseded');
    expect(all[1]?.snapshot_date).toBe('2026-06-21');
    expect(all[1]?.status).toBe('active');
    expect(all[1]?.current_balance).toBe(790_000);
  });
});

// ── absBalance sign convention ────────────────────────────────────────────────────────────

describe('writeDebtSnapshot — absBalance sign convention (Fix LOW)', () => {
  it('a borrower loan with a negative currentBalance is stored with a POSITIVE current_balance (= absBalance)', () => {
    // conditions.ts documents: use absBalance, NEVER signed currentBalance, to avoid negative debt service.
    // For positive balances absBalance === currentBalance so existing tests are unaffected.
    // This test verifies the negative-balance edge case is normalised at write time.
    const db = freshDb();
    const loan = makeBorrowerLoan({
      id: 'loan-negative-balance',
      currentBalance: -750_000, // signed negative (e.g. data entry error or escrow direction)
      absBalance: 750_000,       // always positive magnitude
    });
    const result = writeDebtSnapshot(db, [loan], '2026-06-21');
    expect(result.written).toBe(1);
    expect(result.errors).toHaveLength(0);

    const row = db
      .prepare('SELECT current_balance FROM debt_positions WHERE id = ?')
      .get('loan-negative-balance') as { current_balance: number } | undefined;
    expect(row).toBeDefined();
    // Must be stored as the positive magnitude (absBalance), NOT the signed value
    expect(row?.current_balance).toBe(750_000);
    expect(row?.current_balance).toBeGreaterThan(0);
  });
});

describe('DebtPosition Zod type — lender suppression invariant', () => {
  it('lender is stored in the DB but DebtPosition.parse() does not include lender in the output', () => {
    const db = freshDb();
    const loan = makeBorrowerLoan({ lender: 'Confidential Bank LLC' });
    writeDebtSnapshot(db, [loan], '2026-06-21');

    // Read the raw DB row — lender SHOULD be stored
    const raw = db.prepare('SELECT * FROM debt_positions WHERE id = ?').get('loan-001') as Record<string, unknown>;
    expect(raw['lender']).toBe('Confidential Bank LLC');

    // Construct the client-facing shape (without lender) and parse through DebtPosition
    const clientShape = {
      id: raw['id'],
      propertyId: raw['property_id'] ?? null,
      loanName: raw['loan_name'],
      lender: raw['lender'],
      originalPrincipal: raw['original_principal'] ?? null,
      currentBalance: raw['current_balance'],
      rate: raw['rate'] ?? null,
      loanType: raw['loan_type'] ?? null,
      monthlyPmt: raw['monthly_pmt'] ?? null,
      annualInterest: raw['annual_interest'] ?? null,
      annualPrincipal: raw['annual_principal'] ?? null,
      isDemand: raw['is_demand'] === 1,
      maturityDate: raw['maturity_date'] ?? null,
      monthsToMaturity: raw['months_to_maturity'] ?? null,
      ltv: raw['ltv'] ?? null,
      balloon: raw['balloon'] === 1,
      snapshotDate: raw['snapshot_date'],
      status: raw['status'],
    };

    const parsed = DebtPosition.parse(clientShape);
    // lender must NOT appear on the parsed result
    expect(Object.prototype.hasOwnProperty.call(parsed, 'lender')).toBe(false);
    // Core fields are correctly mapped
    expect(parsed.loanName).toBe('First Mortgage — 123 Main St');
    expect(parsed.currentBalance).toBe(850_000);
    expect(parsed.isDemand).toBe(false);
  });
});
