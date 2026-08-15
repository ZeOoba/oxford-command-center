// @vitest-environment node
//
// tests/unit/debt-scores-snapshot-cli.round19.test.ts
//
// Round-19 review finding (fable review, 2026-08-15): the CLI gate this test covers regressed
// TWICE (19b's unreachable persistence branch, 19g's marker-only gate) and had ZERO test
// coverage at the CLI layer -- only the engine-level behavior (readDebtBookTrust/
// deriveDebtBookTrust) was pinned. This test exercises scripts/debt-scores-snapshot.ts's actual
// main() against a real file-backed DB seeded with a single unattributed active loan (no marker
// at all -- the round-19e discovery path), and asserts the CLI refuses (exit 1) and writes
// nothing to debt_scores, rather than falling through to "no active debt positions to score"
// (exit 0) -- the affirmative-unlevered-claim defect this guard exists to prevent.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../server/macro/fred', () => ({
  fetchFredMacro: vi.fn().mockRejectedValue(new Error('no network in test')),
}));

import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import { writeDebtSnapshot } from '../../server/warehouse/debt-snapshot';
import { main } from '../../scripts/debt-scores-snapshot';
import type { Loan } from '../../src/contracts/index';

function freshDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'debt-scores-cli-r19-'));
  return join(dir, 'test.sqlite');
}

function loan(overrides: Partial<Loan> & { id: string }): Loan {
  return {
    name: `Loan ${overrides.id}`,
    counterparty: 'Bank',
    direction: 'borrower',
    originalPrincipal: 9_000_000,
    currentBalance: 9_000_000,
    absBalance: 9_000_000,
    rate: 0.065,
    monthlyPmt: 51_000,
    annualInterest: 585_000,
    annualPrincipal: 118_000,
    loanType: 'Amortizing',
    status: 'Amortizing',
    isDemand: false,
    maturity: '2027-03-01',
    monthsToMaturity: 8,
    ltv: 0.45,
    lender: 'Bank',
    balloon: true,
    flags: [],
    collateralProperty: null,
    ...overrides,
  };
}

describe('debt-scores-snapshot CLI — book-trust gate', () => {
  it('refuses (exit 1) and writes nothing when the only active loan is unattributed, even with no standing marker', async () => {
    const dbPath = freshDbPath();
    const db: WarehouseDb = openWarehouse(dbPath);
    // Empty crosswalk -> property_id = NULL, exactly the round-19e "documented, warn-only"
    // production state: a typo'd/unresolved collateralProperty name.
    writeDebtSnapshot(db, [loan({ id: 'l1' })], '2026-07-01', new Map());
    const rows = db
      .prepare("SELECT property_id FROM debt_positions WHERE status = 'active'")
      .all() as { property_id: string | null }[];
    expect(rows).toEqual([{ property_id: null }]);
    db.close();

    const exitCode = await main(['--db', dbPath, '--snapshot-date', '2026-08-15']);
    expect(exitCode).toBe(1);

    const verify = openWarehouse(dbPath);
    const written = verify.prepare('SELECT COUNT(*) AS n FROM debt_scores').get() as { n: number };
    expect(written.n).toBe(0);
    verify.close();
  });
});
