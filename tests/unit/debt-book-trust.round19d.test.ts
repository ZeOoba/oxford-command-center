// @vitest-environment node
//
// tests/unit/debt-book-trust.round19d.test.ts
//
// Round 19d — regression pins for the SECOND adversarial round, run against round 19b/19c. Three
// independent lenses reproduced nine HIGH-severity defects; every `it` below pins one of them.
//
//   C1  REFUSAL BLINDNESS (HIGH, reproduced by two lenses independently). vanishedRows excluded
//       ids already in trustedIds. A shrinkage REFUSAL latches trustedIds = the WHOLE book, so the
//       next write's vanish detector saw nothing at all, and the 'refused' clear branch then
//       deleted the marker. refuse → fix → re-run is the procedure the guard's own message
//       instructs, so this was the normal operating path. $8M @ 0.62 off-book, marker NULL.
//
//   C2  markerValue's DEFAULTED absentIds (HIGH). 19b added `absentIds = null` and missed the
//       refusal call site, which still passed five arguments — so a refusal silently wiped a
//       standing vanish obligation. A refusal touches ZERO rows and cannot resolve a vanish.
//
//   C3  LEGACY MARKER (HIGH). The obligation ran only when `standing === null ||
//       standing.trustedIds !== null`, so any legacy marker disabled vanish detection for the
//       whole write — and a legacy 'refused' marker then cleared itself.
//
//   C4  UNKNOWN-DEBT URGENCY REPLACED rather than floored (HIGH). balloonTerm exceeds the
//       constant for any balloon inside ~84 months, so the fix written to stop a property dropping
//       in the ranking made it drop, and flattened the whole debt dimension to a constant.
//
//   C5  A 'refused' marker made capital allocation LESS conservative than NO marker (HIGH).
//
//   C6  /scores had no envelope bookTrust, so total destruction rendered as a reassuring empty
//       state (HIGH).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import { writeDebtSnapshot, readLastSnapshotRefusal } from '../../server/warehouse/debt-snapshot';
import { computePortfolioAggregateLtv } from '../../server/warehouse/debt-maturity';
import { deriveDebtBookTrust, isDistrusted } from '../../server/warehouse/debt-trust';
import type { Loan } from '../../src/contracts/index';

function freshDb(): WarehouseDb {
  const dir = mkdtempSync(join(tmpdir(), 'debt-trust-r19d-'));
  return openWarehouse(join(dir, 'test.sqlite'));
}

function seedProperty(db: WarehouseDb, id: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO property_master
       (id, name, market, financial_mode, rentable_sf, acquisition_date, ownership_pct, ownership_status)
     VALUES (?, ?, 'Test Market', 'pnl', 10000, '2020-01-01', 1, 'active')`,
  ).run(id, id);
}

function loan(overrides: Partial<Loan> & { id: string }): Loan {
  return {
    name: `Loan ${overrides.id}`,
    counterparty: 'Bank',
    direction: 'borrower',
    originalPrincipal: 1_000_000,
    currentBalance: 1_000_000,
    absBalance: 1_000_000,
    rate: 0.065,
    monthlyPmt: 5_700,
    annualInterest: 55_250,
    annualPrincipal: 13_150,
    loanType: 'Amortizing',
    status: 'Amortizing',
    isDemand: false,
    maturity: '2030-06-01',
    monthsToMaturity: 48,
    ltv: 0.35,
    lender: 'Bank',
    balloon: false,
    flags: [],
    collateralProperty: null,
    ...overrides,
  };
}

/** Six sole-loan properties: five small @0.35 plus one $6M @0.90 — a genuine aggregate breach. */
function seedBreachingBook(db: WarehouseDb): { loans: Loan[]; map: Map<string, string> } {
  const map = new Map<string, string>();
  const loans: Loan[] = [];
  for (let i = 1; i <= 5; i++) {
    const id = `l${i}`;
    seedProperty(db, `p${i}`);
    map.set(id, `p${i}`);
    loans.push(loan({ id, absBalance: 1_000_000, ltv: 0.35 }));
  }
  seedProperty(db, 'p6');
  map.set('l6', 'p6');
  loans.push(loan({ id: 'l6', absBalance: 6_000_000, ltv: 0.9 }));
  return { loans, map };
}

describe('C1/C2 — a REFUSAL must never discharge or blind the vanish obligation', () => {
  it('a refusal between the vanish and the recovery must not clear the marker', () => {
    const db = freshDb();
    const { loans, map } = seedBreachingBook(db);
    writeDebtSnapshot(db, loans, '2026-07-01', map);
    expect(computePortfolioAggregateLtv(db).clearedConservatively).toBe(false); // real breach

    // l6 vanishes → latches.
    writeDebtSnapshot(db, loans.slice(0, 5), '2026-07-02', map);
    expect(readLastSnapshotRefusal(db)!.absentIds).toEqual(['l6']);

    // A shrinkage refusal intervenes (3 of 5 lost = 60%). It touches ZERO rows.
    const refused = writeDebtSnapshot(db, loans.slice(0, 2), '2026-07-03', map);
    expect(refused.refusedEmptySupersede).toBe(true);
    // C2: the obligation must survive the refusal verbatim.
    expect(readLastSnapshotRefusal(db)!.absentIds).toEqual(['l6']);

    // A clean write of the five survivors must NOT clear — l6 is still gone.
    writeDebtSnapshot(db, loans.slice(0, 5), '2026-07-04', map);
    expect(readLastSnapshotRefusal(db)).not.toBeNull();
    expect(computePortfolioAggregateLtv(db).clearedConservatively).not.toBe(true);
  });

  it('a refusal must not blind the NEXT write to a fresh vanish (refuse -> fix -> re-run)', () => {
    const db = freshDb();
    const { loans, map } = seedBreachingBook(db);
    writeDebtSnapshot(db, loans, '2026-07-01', map);

    // Ordinary refusal — the guard doing exactly its job. Rows untouched, all six still active.
    const refused = writeDebtSnapshot(db, loans.slice(0, 2), '2026-07-02', map);
    expect(refused.refusedEmptySupersede).toBe(true);

    // The parser recovers, but l6's row never comes back. netLoss = 1, under the 2-row floor, so
    // the shrinkage guard is silent — the vanish detector is the ONLY thing that can catch this.
    const after = writeDebtSnapshot(db, loans.slice(0, 5), '2026-07-03', map);
    expect(after.vanishedIds).toEqual(['l6']);
    expect(readLastSnapshotRefusal(db)).not.toBeNull();
    expect(computePortfolioAggregateLtv(db).clearedConservatively).not.toBe(true);
  });
});

describe('C3 — a LEGACY marker must not disable vanish detection', () => {
  it('detects a vanish while a legacy marker (no trustedIds) stands, and does not self-clear', () => {
    const db = freshDb();
    const { loans, map } = seedBreachingBook(db);
    writeDebtSnapshot(db, loans, '2026-07-01', map);

    // A round-11/12-era marker: structured JSON, kind 'refused', no trustedIds/absentIds fields.
    db.prepare(
      `INSERT INTO warehouse_meta (key, value, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(
      'debt_snapshot.last_write_refused',
      JSON.stringify({ kind: 'refused', reason: 'legacy', baselineCount: 6 }),
    );
    expect(readLastSnapshotRefusal(db)!.trustedIds).toBeNull();

    const res = writeDebtSnapshot(db, loans.slice(0, 5), '2026-07-02', map);
    expect(res.vanishedIds).toEqual(['l6']);
    expect(readLastSnapshotRefusal(db)).not.toBeNull();
    expect(computePortfolioAggregateLtv(db).clearedConservatively).not.toBe(true);
  });
});

describe('C4/C5 — trust derivation and its consumers', () => {
  it("an empty book with no marker is 'unknown' — not 'trusted', not 'degraded'", () => {
    expect(deriveDebtBookTrust(null, 0)).toBe('unknown');
    expect(deriveDebtBookTrust(null, 3)).toBe('trusted');
    expect(deriveDebtBookTrust({ kind: 'refused' }, 0)).toBe('refused');
    expect(deriveDebtBookTrust({ kind: 'degraded' }, 5)).toBe('degraded');
  });

  it('every non-trusted state forbids clearance-direction inference', () => {
    expect(isDistrusted('trusted')).toBe(false);
    expect(isDistrusted('unknown')).toBe(true);
    expect(isDistrusted('refused')).toBe(true);
    expect(isDistrusted('degraded')).toBe(true);
  });
});

describe('the deleted predicate stays deleted', () => {
  it('no replacement, however well-shaped, explains a disappearance', () => {
    const db = freshDb();
    seedProperty(db, 'prop-a');
    const map = new Map([
      ['old', 'prop-a'],
      ['new', 'prop-a'],
    ]);
    writeDebtSnapshot(db, [loan({ id: 'old', absBalance: 1_000_000 })], '2026-07-01', map);
    // Same property, LARGER balance — the most convincing "replacement" possible under any of the
    // three predicates that were tried and broken. It still does not explain anything.
    const res = writeDebtSnapshot(db, [loan({ id: 'new', absBalance: 5_000_000 })], '2026-07-02', map);
    expect(res.vanishedIds).toEqual(['old']);
  });

  it('a corrupted zero balance is not evidence that nothing was lost', () => {
    const db = freshDb();
    seedProperty(db, 'prop-a');
    seedProperty(db, 'prop-b');
    const map = new Map([
      ['l1', 'prop-a'],
      ['l2', 'prop-b'],
    ]);
    writeDebtSnapshot(
      db,
      [loan({ id: 'l1', absBalance: 2_000_000, ltv: 0.62 }), loan({ id: 'l2' })],
      '2026-07-01',
      map,
    );
    // A blank workbook cell coerces l1's balance to 0 (parse.ts raises no flag for this).
    writeDebtSnapshot(
      db,
      [loan({ id: 'l1', absBalance: 0, ltv: 0.62 }), loan({ id: 'l2' })],
      '2026-07-02',
      map,
    );
    // Then l1's row disappears entirely. `lost <= 0` used to mark this EXPLAINED.
    const res = writeDebtSnapshot(db, [loan({ id: 'l2' })], '2026-07-03', map);
    expect(res.vanishedIds).toEqual(['l1']);
    expect(readLastSnapshotRefusal(db)).not.toBeNull();
  });

  it('the source file carries no NUL byte (the UNMAPPED sentinel is gone)', async () => {
    const { readFileSync } = await import('node:fs');
    const buf = readFileSync(
      join(process.cwd(), 'server', 'warehouse', 'debt-snapshot.ts'),
    );
    // A NUL renders the most safety-critical file in this module opaque to ripgrep, and the
    // documented `git diff "Bin"` tell does NOT fire for it.
    expect(buf.includes(0)).toBe(false);
  });
});
