// @vitest-environment node
//
// tests/unit/debt-book-trust.round19c.test.ts
//
// Round 19c — regression pins for the remaining refuter findings against round 19a that were
// fixed without a test of their own. Each `it` below corresponds to a defect an independent
// adversarial lens REPRODUCED:
//
//   B1  scoreBand was set UNCONDITIONALLY to 'watch' under a degraded book, so a property scoring
//       12 / 'critical' (a real DSCR + LTV double breach) was UPGRADED. ScorecardView computes its
//       red "N critical" badge from that field, so the badge for a known-breaching property
//       disappeared exactly when the system went blind. Cap, never raise.
//
//   B2  Under 'refused', the staleness note was attached to the DEMOTION rather than the trust
//       state, so a property already at 'hold' kept asserting "Governors clear; DSCR 1.60x, LTV
//       35.0%" verbatim off a book the warehouse had just declined to update. signalReason is the
//       human-facing scorecard string and is persisted into debt_scores.signal_reason.
//
//   B3  persistDebtScores gated on `!== 'trusted'`, sweeping in 'refused'. But under a refusal
//       zero rows changed and a measured breach is real, so refusing to append for the whole
//       refusal window stopped recording a STANDING Hard-Invariant-4 breach in the permanent
//       trend history — a later reader sees a gap where a breach actually persisted.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import { applyBookTrust } from '../../server/warehouse/debt-scoring';
import { persistDebtScores } from '../../server/warehouse/debt-scores-persistence';
import type { DebtScore } from '../../src/contracts/debt';
import type { PeriodMetrics } from '../../src/contracts/warehouse';

function freshDb(): WarehouseDb {
  const dir = mkdtempSync(join(tmpdir(), 'debt-trust-r19c-'));
  return openWarehouse(join(dir, 'test.sqlite'));
}

function score(overrides: Partial<DebtScore> = {}): DebtScore {
  return {
    propertyId: 'prop-a',
    propertyName: 'Property A',
    noiBasis: 'spine-b/warehouse-ledger',
    dscr: 1.6,
    dscrHeadroom: 0.35,
    ltv: 0.35,
    ltvHeadroom: 0.05,
    debtYield: 0.11,
    signal: 'hold',
    signalReason: 'Governors clear; DSCR 1.60x, LTV 35.0%',
    score: 72,
    scoreBand: 'adequate',
    capitalConfigVersion: 1,
    refiCashSavingsPct: null,
    bookTrust: 'trusted',
    ...overrides,
  };
}

function metricsFor(propertyId: string): PeriodMetrics[] {
  return [
    {
      propertyId,
      propertyName: null,
      period: '2025',
      grainHint: 'year',
      basis: 'cash',
      rentableSf: 10_000,
      ownershipPct: 1,
      revenue: 200_000,
      opex: 0,
      noi: 200_000,
      noiMargin: null,
      expenseRatio: null,
      capex: 0,
      ti: 0,
      leasing: 0,
      categories: {},
      revenueCategories: {},
      revenuePerSf: null,
      noiPerSf: null,
      expensePerSf: null,
      taxesPerSf: null,
      insurancePerSf: null,
      repairsPerSf: null,
      oxfordNoi: 200_000,
    },
  ];
}

describe('B1 — withholding must CAP a score band, never raise it', () => {
  it('a critical property stays critical under a degraded book', () => {
    const critical = score({ scoreBand: 'critical', score: 12, signal: 'governor-block' });
    const [out] = applyBookTrust([critical], 'degraded');
    expect(out!.scoreBand).toBe('critical');
    expect(out!.score).toBeLessThanOrEqual(12); // capped, never raised
  });

  it('a healthier band is still capped down to watch', () => {
    const [out] = applyBookTrust([score({ scoreBand: 'strong', score: 90 })], 'degraded');
    expect(out!.scoreBand).toBe('watch');
    expect(out!.score).toBeLessThanOrEqual(50);
  });
});

describe('B2 — a refused book must annotate every score, not only demoted ones', () => {
  it('an already-hold score no longer asserts an unqualified "Governors clear"', () => {
    const [out] = applyBookTrust([score({ signal: 'hold' })], 'refused');
    expect(out!.bookTrust).toBe('refused');
    expect(out!.signalReason).toMatch(/REFUSED/i);
  });

  it('a clearance-direction signal is still demoted AND annotated', () => {
    const [out] = applyBookTrust([score({ signal: 'cash-out' })], 'refused');
    expect(out!.signal).toBe('hold');
    expect(out!.signalReason).toMatch(/withheld/i);
  });

  it('a measured breach survives a refusal — silence is not the safe direction here', () => {
    const [out] = applyBookTrust([score({ signal: 'governor-block', dscr: 1.1 })], 'refused');
    expect(out!.signal).toBe('governor-block');
    expect(out!.dscr).toBe(1.1);
  });
});

describe('B3 — the trend history must keep recording a standing breach through a refusal', () => {
  it("persists a 'refused'-era score, stamped with its provenance", () => {
    const db = freshDb();
    db.prepare(
      `INSERT OR IGNORE INTO property_master
         (id, name, market, financial_mode, rentable_sf, acquisition_date, ownership_pct, ownership_status)
       VALUES ('prop-a', 'Property A', 'Test', 'pnl', 10000, '2020-01-01', 1, 'active')`,
    ).run();

    const refused = score({ bookTrust: 'refused', signal: 'governor-block', dscr: 1.1 });
    const result = persistDebtScores(db, [refused], metricsFor('prop-a'), '2026-07-27', 150);

    expect(result.written).toBe(1);
    const row = db
      .prepare('SELECT book_trust, signal FROM debt_scores WHERE property_id = ?')
      .get('prop-a') as { book_trust: string; signal: string };
    expect(row.book_trust).toBe('refused'); // never mistakable for a clean-book observation
    expect(row.signal).toBe('governor-block'); // the standing breach is still on the record
  });

  it("still refuses a 'degraded'-era score outright", () => {
    const db = freshDb();
    db.prepare(
      `INSERT OR IGNORE INTO property_master
         (id, name, market, financial_mode, rentable_sf, acquisition_date, ownership_pct, ownership_status)
       VALUES ('prop-a', 'Property A', 'Test', 'pnl', 10000, '2020-01-01', 1, 'active')`,
    ).run();

    const degraded = score({ bookTrust: 'degraded', dscr: null });
    const result = persistDebtScores(db, [degraded], metricsFor('prop-a'), '2026-07-27', 150);

    expect(result.written).toBe(0);
    const n = db.prepare('SELECT COUNT(*) AS n FROM debt_scores').get() as { n: number };
    expect(n.n).toBe(0);
  });

  it('a pre-existing history row defaults to unknown provenance, never to trusted', () => {
    const db = freshDb();
    db.prepare(
      `INSERT OR IGNORE INTO property_master
         (id, name, market, financial_mode, rentable_sf, acquisition_date, ownership_pct, ownership_status)
       VALUES ('prop-old', 'Old Property', 'Test', 'pnl', 10000, '2020-01-01', 1, 'active')`,
    ).run();
    // A row written the way the pre-migration writer did — no book_trust supplied.
    db.prepare(
      `INSERT INTO debt_scores
         (property_id, scored_at, snapshot_date, noi_period, dscr, dscr_headroom, ltv, ltv_headroom,
          debt_yield, signal, signal_reason, refi_trigger_bps, capital_config_version, score, score_band)
       VALUES ('prop-old', '2026-07-01T00:00:00Z', '2026-07-01', '2025', 1.4, 0.15, 0.3, 0.1,
               0.1, 'hold', 'legacy row', 150, 1, 70, 'adequate')`,
    ).run();
    const row = db
      .prepare('SELECT book_trust FROM debt_scores WHERE property_id = ?')
      .get('prop-old') as { book_trust: string };
    expect(row.book_trust).toBe('unknown');
  });
});
