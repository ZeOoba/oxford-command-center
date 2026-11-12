import { describe, it, expect } from 'vitest';
import type { PortfolioSnapshot } from '../../src/contracts/index';
import { checkSnapshot } from '../../server/reconcile-runtime';
import { evaluateFlags } from '../../scripts/reconcile-snapshot';

/**
 * scripts/reconcile-snapshot.ts is the gate:ci-safe counterpart to scripts/reconcile.ts (the
 * $0-tolerance CLI that re-reads the local OneDrive workbook and therefore CANNOT run on
 * GitHub-hosted CI -- see .github/workflows/ci.yml's comment). This one runs `checkSnapshot`
 * (already unit-tested in reconcile-runtime.test.ts) against the COMMITTED
 * data/snapshots/portfolio.json only -- zero workbook I/O, so it runs anywhere.
 *
 * checkSnapshot itself is not re-tested here; `evaluateFlags` (the pass/fail decision on top of
 * its output) is the only new logic, so that is what these tests cover.
 */

const base = (over: Partial<Record<string, unknown>> = {}): PortfolioSnapshot =>
  ({
    properties: [{ id: 'p1', noi: 0, oxfordValue: 0 }],
    leases: [{ id: 'l1', annualRent: 1200, monthlyRent: 100 }],
    loans: [],
    deals: [],
    insurance: [],
    cash: { totalCash: 500, entities: [{ id: 'e1', currentBalance: 500 }] },
    counterparties: [],
    dataQuality: [],
    ...over,
  }) as unknown as PortfolioSnapshot;

describe('evaluateFlags', () => {
  it('is ok with zero flags', () => {
    const r = evaluateFlags([]);
    expect(r).toEqual({ ok: true, errorCount: 0, warnCount: 0 });
  });

  it('is ok when only warn-severity flags are present -- a warn is informational, not a gate failure', () => {
    const r = evaluateFlags([{ entity: 'reconciliation', field: 'x', issue: 'y', severity: 'warn' }]);
    expect(r).toEqual({ ok: true, errorCount: 0, warnCount: 1 });
  });

  it('is NOT ok when any error-severity flag is present', () => {
    const r = evaluateFlags([{ entity: 'reconciliation', field: 'x', issue: 'y', severity: 'error' }]);
    expect(r.ok).toBe(false);
    expect(r.errorCount).toBe(1);
  });

  it('counts errors and warns independently in a mixed set', () => {
    const r = evaluateFlags([
      { entity: 'reconciliation', field: 'a', issue: '1', severity: 'error' },
      { entity: 'reconciliation', field: 'b', issue: '2', severity: 'warn' },
      { entity: 'reconciliation', field: 'c', issue: '3', severity: 'error' },
    ]);
    expect(r).toEqual({ ok: false, errorCount: 2, warnCount: 1 });
  });
});

describe('reconcile-snapshot — regression: the 2026-08-03 phantom-vacancy-lease incident', () => {
  // Replays the incident shape (memory/reference_parseleases_vacancy_block_phantom_leases_2026-08-03.md,
  // PR #250): parseLeases ingested 10 rows of a derived "VACANCY & UPCOMING AVAILABILITY" block as
  // real leases. Annualized rent came out high by a six-figure amount (148 leases) against the
  // workbook's own declared total. The fixture amounts below are illustrative, not the real amounts. This shipped under "Data-quality flags: 0"
  // because nothing on the write path called checkSnapshot -- this is the fixture that proves
  // wiring checkSnapshot into a CI-safe gate would have caught it.
  it('would have failed the gate: Σ annual rent vs workbookTotals.rent mismatch surfaces as an error flag', () => {
    const goodLeases = Array.from({ length: 138 }, (_, i) => ({
      id: `l${i}`,
      annualRent: 4218907.36 / 138,
      monthlyRent: 4218907.36 / 138 / 12,
    }));
    const phantomLeases = Array.from({ length: 10 }, (_, i) => ({
      id: `phantom${i}`,
      annualRent: 241880 / 10,
      monthlyRent: 241880 / 10 / 12,
    }));

    const corrupted = base({
      leases: [...goodLeases, ...phantomLeases],
      workbookTotals: { noi: null, value: null, rent: 4218907.36 },
    });

    const flags = checkSnapshot(corrupted);
    const result = evaluateFlags(flags);

    expect(flags.some((f) => f.field === 'leases.annualRent' && f.severity === 'error')).toBe(true);
    expect(result.ok).toBe(false);
  });

  it('the corresponding clean snapshot (138 leases, rent matching the workbook total) passes', () => {
    const goodLeases = Array.from({ length: 138 }, (_, i) => ({
      id: `l${i}`,
      annualRent: 4218907.36 / 138,
      monthlyRent: 4218907.36 / 138 / 12,
    }));
    const clean = base({
      leases: goodLeases,
      workbookTotals: { noi: null, value: null, rent: 4218907.36 },
    });

    const result = evaluateFlags(checkSnapshot(clean));
    expect(result.ok).toBe(true);
  });
});
