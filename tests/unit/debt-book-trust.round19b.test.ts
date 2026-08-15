// @vitest-environment node
//
// tests/unit/debt-book-trust.round19b.test.ts
//
// Round 19b — remediation of the three independent adversarial refuter passes run against the
// round-19 change itself. Every test here pins a defect the refuters REPRODUCED against round 19a:
//
//   R1  SUBSTITUTION BLEED (HIGH). The latch decided whether a marker exists using a COUNT
//       comparison (supersededNonTrusted.length > netNewNonTrusted.length). One unrelated net-new
//       loan therefore laundered one real disappearance, per write, indefinitely. Reproduced as a
//       single-write Hard-Invariant-4 false clearance: aggregate 0.62 (breach) -> 0.05 (CLEARED),
//       marker NULL. Round 13 already learned this lesson for CLEARING a marker — identity beats
//       count — but round 19a used arithmetic to decide whether to CREATE one.
//
//   R2  OVER-FIRE + UNRECOVERABLE (HIGH). A payoff whose workbook ROW IS DELETED (rather than
//       restatused terminal), and a 2-into-1 consolidation refinance, both latched at n=1 —
//       contradicting MIN_SUPERSEDED_ROWS_FOR_SHRINKAGE_GUARD's ratified docstring. Worse, the
//       latch unioned survivingOrWrittenIds into trustedIds, so renamed-away ids joined a
//       permanent obligation they can never discharge (a renamed id can never be "freshly
//       written" again). The only exit was blanket allowEmptySupersede, which also waives any
//       genuinely-unresolved damage — training the reflex that waives R1's real losses.
//
//   R3  SILENT LATCH (HIGH). The latching write pushed nothing to errors[] and set no typed flag,
//       so the unattended reload path logged NOTHING on damage day. This is the round-13 defect
//       verbatim, re-introduced at the one moment that matters most.
//
// The fix separates the two obligations. trustedIds (insert-failure damage) must be freshly
// RE-WRITTEN. absentIds (unexplained vanish) must RETURN or be individually confirmed via
// confirmAbsent. A replacement is credited only at property identity + economic grain, never by
// count.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import { writeDebtSnapshot, readLastSnapshotRefusal } from '../../server/warehouse/debt-snapshot';
import { computePortfolioAggregateLtv } from '../../server/warehouse/debt-maturity';
import type { Loan } from '../../src/contracts/index';

function freshDb(): WarehouseDb {
  const dir = mkdtempSync(join(tmpdir(), 'debt-trust-r19b-'));
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
    ltv: 0.5,
    lender: 'Bank',
    balloon: false,
    flags: [],
    collateralProperty: null,
    ...overrides,
  };
}

describe('R1 — a replacement must be credited by identity + economics, never by count', () => {
  it('an unrelated net-new loan must NOT launder a real disappearance (reproduced false clearance)', () => {
    const db = freshDb();
    seedProperty(db, 'prop-a');
    seedProperty(db, 'prop-b');
    const map = new Map([
      ['loan-a', 'prop-a'],
      ['loan-b', 'prop-b'],
    ]);

    // A real 0.62-LTV book: a genuine breach of the 0.40 aggregate ceiling.
    writeDebtSnapshot(db, [loan({ id: 'loan-a', ltv: 0.62, absBalance: 1_000_000 })], '2026-07-01', map);
    const before = computePortfolioAggregateLtv(db);
    expect(before.clearedConservatively).toBe(false);

    // loan-a's row is dropped from the workbook while an unrelated tiny new financing lands on a
    // DIFFERENT property. Counts match (1 vanished, 1 net-new) so the old rule saw a replacement.
    writeDebtSnapshot(db, [loan({ id: 'loan-b', ltv: 0.05, absBalance: 1_000 })], '2026-07-02', map);

    expect(readLastSnapshotRefusal(db)).not.toBeNull();
    expect(computePortfolioAggregateLtv(db).clearedConservatively).not.toBe(true);
  });

  it('the bleed must not generalise: repeated 1-for-1 swaps cannot empty the book quietly', () => {
    const db = freshDb();
    const ids = ['l0', 'l1', 'l2', 'l3', 'l4', 'l5'];
    ids.forEach((_id, i) => seedProperty(db, `p${i}`));
    const map = new Map(ids.map((id, i) => [id, `p${i}`]));
    writeDebtSnapshot(db, ids.map((id) => loan({ id, ltv: 0.55 })), '2026-07-01', map);

    // Swap one real loan for one unrelated new one, per write.
    let current = [...ids];
    for (let step = 0; step < 3; step++) {
      map.set(`new-${step}`, `p${step}`);
      current = [...current.slice(1), `new-${step}`];
      writeDebtSnapshot(
        db,
        current.map((id) => loan({ id, ltv: id.startsWith('new') ? 0.05 : 0.55, absBalance: id.startsWith('new') ? 1_000 : 1_000_000 })),
        `2026-07-0${step + 2}`,
        map,
      );
    }
    expect(readLastSnapshotRefusal(db)).not.toBeNull();
    expect(computePortfolioAggregateLtv(db).clearedConservatively).not.toBe(true);
  });

  // ── ROUND 19d CONTRACT CHANGE (Gabriel's ruling, 2026-07-27) ─────────────────────────────
  // These two tests previously asserted that a refinance and a consolidation are AUTOMATICALLY
  // explained. That was the replacement predicate, and three independent adversarial passes broke
  // every version of it — by count, then by property identity + balance share, then via the
  // unmapped bucket, then via a corrupted zero balance. The predicate is now DELETED: nothing
  // infers legitimacy from the shape of the data. A refi/rename latches like any other
  // disappearance and is discharged by one explicit confirmAbsent.
  //
  // The tests are kept, inverted, because the behaviour they cover is still the behaviour that
  // matters operationally — it just has a different, and deliberately louder, contract now.
  it('a same-property refinance under a NEW id LATCHES, and one confirmAbsent clears it', () => {
    const db = freshDb();
    seedProperty(db, 'prop-a');
    const map = new Map([
      ['old-a', 'prop-a'],
      ['new-a', 'prop-a'],
    ]);
    writeDebtSnapshot(db, [loan({ id: 'old-a', absBalance: 1_000_000 })], '2026-07-01', map);
    const res = writeDebtSnapshot(db, [loan({ id: 'new-a', absBalance: 1_020_000 })], '2026-07-02', map);

    // No replacement credit: the old id genuinely left the book, so it is an obligation.
    expect(res.vanishedIds).toEqual(['old-a']);
    expect(readLastSnapshotRefusal(db)!.absentIds).toEqual(['old-a']);

    // One narrow confirmation resolves it — no blanket amnesty needed.
    writeDebtSnapshot(db, [loan({ id: 'new-a', absBalance: 1_020_000 })], '2026-07-03', map, {
      confirmAbsent: ['old-a'],
    });
    expect(readLastSnapshotRefusal(db)).toBeNull();
  });

  it('a 2-into-1 consolidation LATCHES both retired ids, and one confirmAbsent call clears both', () => {
    const db = freshDb();
    seedProperty(db, 'prop-a');
    const map = new Map([
      ['a1', 'prop-a'],
      ['a2', 'prop-a'],
      ['consol', 'prop-a'],
    ]);
    writeDebtSnapshot(
      db,
      [loan({ id: 'a1', absBalance: 500_000 }), loan({ id: 'a2', absBalance: 500_000 })],
      '2026-07-01',
      map,
    );
    const res = writeDebtSnapshot(db, [loan({ id: 'consol', absBalance: 1_000_000 })], '2026-07-02', map);
    expect(res.vanishedIds).toEqual(['a1', 'a2']);

    writeDebtSnapshot(db, [loan({ id: 'consol', absBalance: 1_000_000 })], '2026-07-03', map, {
      confirmAbsent: ['a1', 'a2'],
    });
    expect(readLastSnapshotRefusal(db)).toBeNull();
  });

  it('a TERMINAL status in the payload still discharges automatically — the free path', () => {
    const db = freshDb();
    ['p1', 'p2'].forEach((p) => seedProperty(db, p));
    const map = new Map([
      ['l1', 'p1'],
      ['l2', 'p2'],
    ]);
    writeDebtSnapshot(db, [loan({ id: 'l1' }), loan({ id: 'l2' })], '2026-07-01', map);

    // l2 is paid off and the workbook SAYS SO. No human confirmation required.
    const res = writeDebtSnapshot(
      db,
      [loan({ id: 'l1' }), loan({ id: 'l2', status: 'Paid in Full' })],
      '2026-07-02',
      map,
    );
    expect(res.vanishedIds).toEqual([]);
    expect(readLastSnapshotRefusal(db)).toBeNull();
  });
});

describe('R2 — the vanish obligation must be dischargeable without a blanket amnesty', () => {
  it('a payoff-by-row-deletion latches, and confirmAbsent clears it per-id', () => {
    const db = freshDb();
    ['p1', 'p2', 'p3'].forEach((p) => seedProperty(db, p));
    const map = new Map([
      ['l1', 'p1'],
      ['l2', 'p2'],
      ['l3', 'p3'],
    ]);
    const all = [loan({ id: 'l1' }), loan({ id: 'l2' }), loan({ id: 'l3' })];
    writeDebtSnapshot(db, all, '2026-07-01', map);

    // l3 paid off; its workbook ROW is deleted rather than restatused.
    const res = writeDebtSnapshot(db, all.slice(0, 2), '2026-07-02', map);
    expect(readLastSnapshotRefusal(db)).not.toBeNull();
    expect(res.vanishedIds).toEqual(['l3']);

    // Confirming THAT loan clears it — without waiving anything else.
    const res2 = writeDebtSnapshot(db, all.slice(0, 2), '2026-07-03', map, { confirmAbsent: ['l3'] });
    expect(res2.staleMarkerHeld).toBe(false);
    expect(readLastSnapshotRefusal(db)).toBeNull();
  });

  it('confirmAbsent must NOT waive an unrelated standing insert-failure damage', () => {
    const db = freshDb();
    ['p1', 'p2'].forEach((p) => seedProperty(db, p));
    const map = new Map([
      ['l1', 'p1'],
      ['l2', 'p2'],
    ]);
    writeDebtSnapshot(db, [loan({ id: 'l1' }), loan({ id: 'l2' })], '2026-07-01', map);

    // Real damage: l2's insert fails after its prior row was superseded.
    const damaged = writeDebtSnapshot(
      db,
      [loan({ id: 'l1' }), loan({ id: 'l2', absBalance: NaN })],
      '2026-07-02',
      map,
    );
    expect(damaged.degradedRows).toBe(1);

    // Confirming an unrelated absence must not clear the standing damage.
    writeDebtSnapshot(db, [loan({ id: 'l1' })], '2026-07-03', map, { confirmAbsent: ['l2'] });
    const marker = readLastSnapshotRefusal(db);
    expect(marker).not.toBeNull();
    expect(marker!.kind).toBe('degraded');
  });

  it('a renamed-away id must never become a permanent unrecoverable obligation', () => {
    const db = freshDb();
    ['p1', 'p2', 'p3'].forEach((p) => seedProperty(db, p));
    const map = new Map([
      ['a', 'p1'],
      ['b', 'p2'],
      ['c', 'p3'],
      ['a2', 'p1'],
      ['b2', 'p2'],
    ]);
    writeDebtSnapshot(db, [loan({ id: 'a' }), loan({ id: 'b' }), loan({ id: 'c' })], '2026-07-01', map);

    // Two renames (same property, same balance) + one payoff-by-deletion.
    writeDebtSnapshot(db, [loan({ id: 'a2' }), loan({ id: 'b2' })], '2026-07-02', map);

    // ROUND 19d: with the replacement predicate deleted, the two renamed-away ids are obligations
    // too — nothing auto-explains a disappearance any more. The invariant this test exists for is
    // that they must never be PERMANENT: a renamed id can never be "freshly re-written", so if it
    // landed in trustedIds (as round 19a put it) the book could never recover. It lands in
    // absentIds, which confirmAbsent can discharge.
    const marker = readLastSnapshotRefusal(db);
    expect(marker).not.toBeNull();
    expect(marker!.absentIds).toEqual(['a', 'b', 'c']);
    expect(marker!.trustedIds).toEqual([]); // NOT trustedIds — that list would be unrecoverable

    // Recoverable in one narrow confirmation, with no blanket amnesty.
    writeDebtSnapshot(db, [loan({ id: 'a2' }), loan({ id: 'b2' })], '2026-07-03', map, {
      confirmAbsent: ['a', 'b', 'c'],
    });
    expect(readLastSnapshotRefusal(db)).toBeNull();
  });

  it('a vanished loan that RETURNS on its own clears the obligation with no human action', () => {
    const db = freshDb();
    ['p1', 'p2'].forEach((p) => seedProperty(db, p));
    const map = new Map([
      ['l1', 'p1'],
      ['l2', 'p2'],
    ]);
    const both = [loan({ id: 'l1' }), loan({ id: 'l2' })];
    writeDebtSnapshot(db, both, '2026-07-01', map);
    writeDebtSnapshot(db, [loan({ id: 'l1' })], '2026-07-02', map);
    expect(readLastSnapshotRefusal(db)).not.toBeNull();

    writeDebtSnapshot(db, both, '2026-07-03', map);
    expect(readLastSnapshotRefusal(db)).toBeNull();
  });
});

describe('R3 — the latching write must not be silent', () => {
  it('surfaces the vanish in errors[] and in a typed result field', () => {
    const db = freshDb();
    ['p1', 'p2'].forEach((p) => seedProperty(db, p));
    const map = new Map([
      ['l1', 'p1'],
      ['l2', 'p2'],
    ]);
    writeDebtSnapshot(db, [loan({ id: 'l1' }), loan({ id: 'l2' })], '2026-07-01', map);
    const res = writeDebtSnapshot(db, [loan({ id: 'l1' })], '2026-07-02', map);

    expect(res.vanishedIds).toEqual(['l2']);
    expect(res.errors.join(' ')).toMatch(/l2/);
    expect(res.errors.join(' ')).toMatch(/VANISHED|disappeared/i);
  });

  it('a clean write reports no vanish', () => {
    const db = freshDb();
    seedProperty(db, 'p1');
    const map = new Map([['l1', 'p1']]);
    const res = writeDebtSnapshot(db, [loan({ id: 'l1' })], '2026-07-01', map);
    expect(res.vanishedIds).toEqual([]);
    expect(res.errors).toHaveLength(0);
  });
});
