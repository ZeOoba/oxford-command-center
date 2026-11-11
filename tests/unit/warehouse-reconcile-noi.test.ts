// tests/unit/warehouse-reconcile-noi.test.ts
//
// PFI Phase 1c — A↔B NOI reconciliation. Pure-classifier tests of the
// Spine-A (workbook Property.noi, Oxford-share) ↔ Spine-B (warehouse oxfordNoi at latest
// full-year period, also Oxford-share) tie-out. The classifier produces ONE reconciliation
// row per property and never touches the DB; the DB wrapper is tested separately.
import ExcelJS from 'exceljs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PortfolioSnapshot } from '../../src/contracts/index';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import { ingestFile } from '../../server/warehouse/ingest';
import { seedMappings } from '../../server/warehouse/mapping';
import { propertyPeriodMetrics } from '../../server/warehouse/metrics';
import { seedPropertyMaster } from '../../server/warehouse/property-master';
import {
  buildNoiReconcileInputs,
  classifyNoiReconciliation,
  reconcileNoiAB,
  reconcileNoiABFromDb,
  type NoiReconcileInput,
  type Tolerance,
} from '../../server/warehouse/reconcile-noi';

const TOL: Tolerance = { pctBand: 0.05, absBandUsd: 10000, largeDriftPct: 0.20 };

const input = (over: Partial<NoiReconcileInput>): NoiReconcileInput => ({
  propertyId: '1100-rarig-ave-columbus-oh',
  propertyName: '1100 Rarig Ave, Columbus OH',
  workbookOxfordNoi: 100000,
  warehouseOxfordNoi: 100000,
  warehousePeriod: '2025',
  warehouseBasis: 'cash',
  isLeaseRun: false,
  isResidence: false,
  acqDate: null,
  recentTenancyAnnualRent: null,
  ...over,
});

describe('classifyNoiReconciliation — pure A↔B classifier', () => {
  it('returns match when workbook and warehouse Oxford-share NOI agree exactly', () => {
    const r = classifyNoiReconciliation(input({}), TOL);
    expect(r.status).toBe('match');
    expect(r.severity).toBe('info');
    expect(r.delta).toBe(0);
    expect(r.deltaPct).toBe(0);
    expect(r.period).toBe('2025');
  });

  it('returns in-tolerance when the delta is within the relative band (5%)', () => {
    // 4% drift on $100k = $4k delta — under both pct band (5%) and abs band ($10k).
    const r = classifyNoiReconciliation(input({ workbookOxfordNoi: 104000 }), TOL);
    expect(r.status).toBe('in-tolerance');
    expect(r.severity).toBe('info');
    expect(r.delta).toBe(4000);
    expect(r.deltaPct).toBeCloseTo(0.0385, 4); // 4000/104000 = 3.85% on max abs
  });

  it('absolute floor does NOT suppress large relative drift: wb=14k/wh=5k (64% > 20% largeDriftPct) → large-drift (M2 fix)', () => {
    // Before M2 fix: absDelta=$9k ≤ $10k abs-band granted in-tolerance despite 64% relative drift.
    // After fix: abs-band requires deltaPct < largeDriftPct; 64% fails → large-drift/error.
    const r = classifyNoiReconciliation(
      input({ workbookOxfordNoi: 14000, warehouseOxfordNoi: 5000 }),
      TOL,
    );
    expect(r.status).toBe('large-drift');
    expect(r.severity).toBe('error');
    expect(r.delta).toBe(9000);
  });

  it('absolute floor still grants in-tolerance for small drift on a small-NOI property (abs band + pct < largeDriftPct, small max NOI)', () => {
    // wb=11k, wh=9k: delta=2k, deltaPct=2/11=18.2% (between pctBand 5% and largeDriftPct 20%).
    // max(|wb|,|wh|) = 11k — a genuinely small-NOI property — the $10k floor was designed for this.
    // → absDelta=2k ≤ 10k AND deltaPct=18.2% < 20% AND max ≤ absBandUsd*3 → in-tolerance via abs band.
    const r = classifyNoiReconciliation(
      input({ workbookOxfordNoi: 11000, warehouseOxfordNoi: 9000 }),
      TOL,
    );
    expect(r.status).toBe('in-tolerance');
    expect(r.severity).toBe('info');
  });

  it('~15% NOI gap on a mid-NOI property ($9k delta, wb=50k/wh=59k) is drift/warn — absolute floor must not swallow it', () => {
    // Bug: absDelta=9k ≤ absBandUsd=10k AND deltaPct=15.25% < largeDriftPct=20% → in-tolerance/info.
    // The $10k absolute floor was designed for SMALL-NOI properties (e.g. $10k NOI with $800 noise).
    // On a mid-NOI property ($50k+), a 15% disagreement is material and must not be silently reconciled.
    // Fix: the absolute floor also requires max(|wb|,|wh|) ≤ absBandUsd*3 (i.e. ≤ $30k); at $59k max
    // the floor does not apply, and the 15.25% gap correctly falls into drift/warn.
    const r = classifyNoiReconciliation(
      input({ workbookOxfordNoi: 50000, warehouseOxfordNoi: 59000 }),
      TOL,
    );
    expect(r.status).toBe('drift');
    expect(r.severity).toBe('warn');
    expect(r.deltaPct).toBeCloseTo(9000 / 59000, 4);
  });

  it('warehouse-zero vs non-zero workbook is missing-from-warehouse, not in-tolerance (L5 fix)', () => {
    // L5 defect: wb=$9,000 / wh=$0. |delta|=$9k ≤ $10k abs band → was in-tolerance despite 100%
    // relative delta. A warehouse-zero with a non-zero workbook NOI means the warehouse has no
    // committed P&L for this period — not a genuine near-match. Must be missing-from-warehouse.
    const r = classifyNoiReconciliation(
      input({ workbookOxfordNoi: 9000, warehouseOxfordNoi: 0, warehouseBasis: 'cash' }),
      TOL,
    );
    expect(r.status).toBe('missing-from-warehouse');
    expect(r.severity).toBe('warn');
  });

  it('legitimately small symmetric delta (wb=$9,200 / wh=$9,000, ~2% drift) still passes in-tolerance', () => {
    // Guard: the warehouse-zero fix must not fire when the warehouse genuinely has a non-zero NOI.
    const r = classifyNoiReconciliation(
      input({ workbookOxfordNoi: 9200, warehouseOxfordNoi: 9000, warehouseBasis: 'cash' }),
      TOL,
    );
    expect(r.status).toBe('in-tolerance');
  });

  it('returns drift when the delta is past tolerance but under the large-drift threshold', () => {
    // 10% drift on $200k = $20k delta — past both bands, under 20% large-drift.
    const r = classifyNoiReconciliation(
      input({ workbookOxfordNoi: 220000, warehouseOxfordNoi: 200000 }),
      TOL,
    );
    expect(r.status).toBe('drift');
    expect(r.severity).toBe('warn');
    expect(r.delta).toBe(20000);
  });

  it('returns large-drift at or beyond the large-drift threshold (20%)', () => {
    // 25% drift — material disagreement, error severity.
    const r = classifyNoiReconciliation(
      input({ workbookOxfordNoi: 250000, warehouseOxfordNoi: 200000 }),
      TOL,
    );
    expect(r.status).toBe('large-drift');
    expect(r.severity).toBe('error');
    expect(r.deltaPct).toBeCloseTo(0.2, 4); // 50k/250k
  });

  it('treats large-drift symmetrically (warehouse > workbook, same magnitude)', () => {
    const r = classifyNoiReconciliation(
      input({ workbookOxfordNoi: 200000, warehouseOxfordNoi: 250000 }),
      TOL,
    );
    expect(r.status).toBe('large-drift');
    expect(r.delta).toBe(-50000); // sign preserved (workbook − warehouse)
    expect(r.deltaPct).toBeCloseTo(0.2, 4); // |delta|/max
  });

  it('returns missing-from-warehouse when only the workbook reports a value', () => {
    const r = classifyNoiReconciliation(
      input({ warehouseOxfordNoi: null, warehousePeriod: null, warehouseBasis: null }),
      TOL,
    );
    expect(r.status).toBe('missing-from-warehouse');
    expect(r.severity).toBe('warn');
    expect(r.delta).toBeNull();
    expect(r.deltaPct).toBeNull();
  });

  it('returns missing-from-workbook when only the warehouse reports a value', () => {
    const r = classifyNoiReconciliation(input({ workbookOxfordNoi: null }), TOL);
    expect(r.status).toBe('missing-from-workbook');
    expect(r.severity).toBe('warn');
  });

  it('skips lease-run properties (master-lease estimated capex — no real P&L expected)', () => {
    const r = classifyNoiReconciliation(
      input({
        propertyId: '7658-fishel-dr-n-dublin-oh',
        propertyName: '7658 Fishel Dr N, Dublin OH',
        isLeaseRun: true,
        warehouseOxfordNoi: null,
        warehousePeriod: null,
        warehouseBasis: null,
      }),
      TOL,
    );
    expect(r.status).toBe('lease-run-skipped');
    expect(r.severity).toBe('info'); // expected, not a defect
  });

  it('flags a basis-unknown reconciliation as warn even if values agree (the comparison is low-confidence)', () => {
    // The values match, but the warehouse couldn't parse the basis — the model can't be sure
    // the two NOIs are like-for-like. Downgrade match→warn so the data-quality dashboard surfaces it.
    const r = classifyNoiReconciliation(input({ warehouseBasis: 'unknown' }), TOL);
    expect(r.severity).toBe('warn');
    expect(r.reason).toMatch(/basis unknown/i);
  });

  it('reports no-fy-period when the warehouse has only a YTD partial (cannot tie out an annual NOI to a partial period)', () => {
    const r = classifyNoiReconciliation(
      input({ warehousePeriod: null, warehouseOxfordNoi: null, warehouseBasis: 'cash' }),
      TOL,
    );
    expect(r.status).toBe('missing-from-warehouse');
  });
});

describe('sign-inversion guard (CORRECTNESS — adversarial fix, the absolute floor must not swallow profit-vs-loss disagreement)', () => {
  it('a sign-inverted NOI (workbook + $3k vs warehouse −$3k, basis known) is NEVER in-tolerance, even though |delta| ≤ $10k', () => {
    // Adversarial finding (CORRECTNESS/HIGH): the in-tolerance OR-clause (deltaPct ≤ band ||
    // absDelta ≤ absBand) fired regardless of sign, classifying a property where the two spines
    // disagree on profit vs loss as 'reconciled.' The absolute floor was designed to protect
    // small-NOI properties from spurious large-drift — but only with SAME-SIGN drift in mind.
    const r = classifyNoiReconciliation(
      input({ workbookOxfordNoi: 3000, warehouseOxfordNoi: -3000, warehouseBasis: 'cash' }),
      TOL,
    );
    expect(r.status).not.toBe('in-tolerance');
    expect(r.status).not.toBe('match');
    expect(r.severity).not.toBe('info'); // must rise to at least warn
    expect(r.reason).toMatch(/sign|profit.*loss|inversion/i);
  });

  it('zero is NEUTRAL for sign-parity (guard does not fire), but 100% relative drift → large-drift (M2)', () => {
    // Math.sign(0)===0 so signsConflict guard (which requires both sides non-zero) never fires.
    // However: deltaPct = 3000/max(0,3000) = 100% ≥ largeDriftPct(20%), so the abs band cannot
    // grant in-tolerance under the M2 fix. A workbook reporting $0 vs a warehouse showing $3k IS
    // a material discrepancy (100% relative drift) and should surface as large-drift.
    const r = classifyNoiReconciliation(
      input({ workbookOxfordNoi: 0, warehouseOxfordNoi: 3000, warehouseBasis: 'cash' }),
      TOL,
    );
    expect(r.status).not.toBe('in-tolerance');
    expect(r.status).toBe('large-drift');
  });

  it('symmetric sign-inverted case (wb=−$3k, wh=+$3k) is also not in-tolerance', () => {
    const r = classifyNoiReconciliation(
      input({ workbookOxfordNoi: -3000, warehouseOxfordNoi: 3000, warehouseBasis: 'cash' }),
      TOL,
    );
    expect(r.status).not.toBe('in-tolerance');
    expect(r.status).not.toBe('match');
  });

  it('sign-inverted pair is always large-drift (deltaPct > 1.0 > 20% for any opposing signs) and carries the signNote (M9)', () => {
    // Mathematical invariant: if wb>0 and wh<0, absDelta=wb+|wh|>max(wb,|wh|), so deltaPct>1.0.
    // That always exceeds largeDriftPct (0.20), so the large-drift branch fires with the signNote.
    const r = classifyNoiReconciliation(
      input({ workbookOxfordNoi: 3000, warehouseOxfordNoi: -3000, warehouseBasis: 'cash' }),
      TOL,
    );
    expect(r.status).toBe('large-drift');
    expect(r.severity).toBe('error');
    expect(r.reason).toMatch(/sign|inversion/i);
  });
});

describe('structural-mismatch downgrade (OI-137 — ownership/tenancy changed since the comparison period, not an integrity break)', () => {
  // 2026-08-17 root cause (open-items-tracker.md OI-137): a large drift can be fully explained by
  // Spine A (workbook, current rent roll) and Spine B (warehouse, the LATEST FULL-YEAR period's
  // historical actuals) measuring different things when ownership or tenancy changed since that
  // period. Neither spine is wrong. This downgrade must be conservative: it only ever applies to
  // what would otherwise be large-drift (never escalates or touches in-tolerance/drift), it never
  // fires without positive evidence (absence of acqDate/lease data is not evidence), and it must
  // NEVER fire on a sign-inverted disagreement (profit vs loss is always a genuine break regardless
  // of tenancy/ownership history).
  const LARGE_DRIFT = { workbookOxfordNoi: 100000, warehouseOxfordNoi: 10000 }; // synthetic Livingston-shaped drift, absDelta=$90,000, deltaPct=90.00%

  it('ownership signal: acquired on/after the comparison period start, WITH some rent-roll corroboration → structural-mismatch/warn', () => {
    // Corroboration deliberately below the standalone tenancy bar (50% of $90,000 = $45,000) — the
    // point of this test is that a SMALL amount of post-acquisition leasing, combined with the
    // acquisition date, is enough; ownership is not required to explain the full dollar gap alone.
    const r = classifyNoiReconciliation(input({ ...LARGE_DRIFT, acqDate: '2025-06-01', recentTenancyAnnualRent: 5000 }), TOL);
    expect(r.status).toBe('structural-mismatch');
    expect(r.severity).toBe('warn');
    expect(r.reason).toMatch(/OI-137/);
    expect(r.reason).toMatch(/acquired/i);
  });

  it('boundary: acqDate exactly equal to the period start date still counts as on/after (inclusive)', () => {
    const r = classifyNoiReconciliation(input({ ...LARGE_DRIFT, acqDate: '2025-01-01', recentTenancyAnnualRent: 5000 }), TOL);
    expect(r.status).toBe('structural-mismatch');
  });

  it('no ownership signal: acqDate well before the comparison period → stays large-drift/error', () => {
    const r = classifyNoiReconciliation(input({ ...LARGE_DRIFT, acqDate: '2018-03-14', recentTenancyAnnualRent: 5000 }), TOL);
    expect(r.status).toBe('large-drift');
    expect(r.severity).toBe('error');
  });

  it('ADVERSARIAL FIX: acqDate alone, with ZERO rent-roll corroboration, does NOT downgrade — a bare acquisition date is not evidence for THIS drift', () => {
    // Closes a gap an adversarial review found: without this guard, any same-sign large-drift at a
    // newly-acquired property would be waved through indefinitely regardless of cause — masking a
    // genuine ingestion bug (duplicate rows, misattributed import, decimal error) at exactly the
    // properties where such a bug is most likely to go unnoticed.
    const r = classifyNoiReconciliation(input({ ...LARGE_DRIFT, acqDate: '2025-06-01', recentTenancyAnnualRent: null }), TOL);
    expect(r.status).toBe('large-drift');
    expect(r.severity).toBe('error');
  });

  it('ADVERSARIAL FIX: acqDate present but recentTenancyAnnualRent computed to exactly 0 also does NOT downgrade', () => {
    const r = classifyNoiReconciliation(input({ ...LARGE_DRIFT, acqDate: '2025-06-01', recentTenancyAnnualRent: 0 }), TOL);
    expect(r.status).toBe('large-drift');
  });

  it('tenancy signal: recent-tenancy rent covers at least half the delta → structural-mismatch/warn', () => {
    // absDelta=$90,000; $100,000 (100% of current rent) is well over half.
    const r = classifyNoiReconciliation(input({ ...LARGE_DRIFT, recentTenancyAnnualRent: 100000 }), TOL);
    expect(r.status).toBe('structural-mismatch');
    expect(r.severity).toBe('warn');
    expect(r.reason).toMatch(/OI-137/);
    expect(r.reason).toMatch(/\$100,000/);
  });

  it('boundary: recent-tenancy rent exactly half the delta still counts (inclusive)', () => {
    const r = classifyNoiReconciliation(input({ ...LARGE_DRIFT, recentTenancyAnnualRent: 90000 * 0.5 }), TOL);
    expect(r.status).toBe('structural-mismatch');
  });

  it('insufficient tenancy evidence: recent-tenancy rent under half the delta → stays large-drift/error', () => {
    const r = classifyNoiReconciliation(input({ ...LARGE_DRIFT, recentTenancyAnnualRent: 10000 }), TOL);
    expect(r.status).toBe('large-drift');
    expect(r.severity).toBe('error');
  });

  it('zero recent-tenancy rent is treated as no signal, not a false match', () => {
    const r = classifyNoiReconciliation(input({ ...LARGE_DRIFT, recentTenancyAnnualRent: 0 }), TOL);
    expect(r.status).toBe('large-drift');
  });

  it('DIRECTION FIX (2026-08-17): tenancy-alone evidence does NOT downgrade when the WAREHOUSE exceeds the workbook — that direction is the signature of a warehouse-side over-count, not a timing gap the evidence explains', () => {
    // Same magnitude/shape as the tenancy-signal case above, but the drift runs the OPPOSITE
    // direction: warehouse (200000) exceeds workbook (80000). Recent-lease rent explains why the
    // CURRENT rent roll might exceed stale historical actuals — it says nothing about why the
    // HISTORICAL actuals would exceed the current rent roll, which points at a double-counted or
    // misattributed warehouse import instead.
    const r = classifyNoiReconciliation(
      input({ workbookOxfordNoi: 80000, warehouseOxfordNoi: 200000, recentTenancyAnnualRent: 120000 }),
      TOL,
    );
    expect(r.status).toBe('large-drift');
    expect(r.severity).toBe('error');
  });

  it('DIRECTION FIX: the same tenancy evidence DOES still downgrade in the workbook-exceeds-warehouse direction (unchanged behavior)', () => {
    const r = classifyNoiReconciliation(
      input({ workbookOxfordNoi: 200000, warehouseOxfordNoi: 80000, recentTenancyAnnualRent: 120000 }),
      TOL,
    );
    expect(r.status).toBe('structural-mismatch');
    expect(r.severity).toBe('warn');
  });

  it('DIRECTION FIX: ownership+tenancy corroboration (the OTHER rung) stays bidirectional — still downgrades when the warehouse exceeds the workbook', () => {
    const r = classifyNoiReconciliation(
      input({ workbookOxfordNoi: 80000, warehouseOxfordNoi: 200000, acqDate: '2025-06-01', recentTenancyAnnualRent: 5000 }),
      TOL,
    );
    expect(r.status).toBe('structural-mismatch');
  });

  it('no evidence at all (both null) → stays large-drift/error — absence of evidence is not evidence of a structural cause', () => {
    const r = classifyNoiReconciliation(input({ ...LARGE_DRIFT, acqDate: null, recentTenancyAnnualRent: null }), TOL);
    expect(r.status).toBe('large-drift');
    expect(r.severity).toBe('error');
  });

  it('ADVERSARIAL: a sign-inverted large drift is NEVER downgraded, even with strong ownership AND tenancy evidence', () => {
    // Profit-vs-loss disagreement must always surface as a genuine break — a tenancy/ownership
    // explanation for the MAGNITUDE of a gap says nothing about a SIGN flip, which points at a
    // parsing or classification defect, not a timing difference.
    const r = classifyNoiReconciliation(
      input({
        workbookOxfordNoi: 50000,
        warehouseOxfordNoi: -50000,
        warehouseBasis: 'cash',
        acqDate: '2026-01-01',
        recentTenancyAnnualRent: 999999,
      }),
      TOL,
    );
    expect(r.status).not.toBe('structural-mismatch');
    expect(r.status).toBe('large-drift');
    expect(r.severity).toBe('error');
    expect(r.reason).toMatch(/sign|inversion/i);
  });

  it('never crashes and never false-positives when there is no comparison period to evaluate (warehousePeriod null)', () => {
    // Defensive: large-drift with both NOIs present but no period string should still classify
    // deterministically rather than throwing on a null period.slice().
    const r = classifyNoiReconciliation(
      input({ ...LARGE_DRIFT, warehousePeriod: null, acqDate: '2025-06-01', recentTenancyAnnualRent: 100000 }),
      TOL,
    );
    expect(r.status).toBe('large-drift'); // no period to compare against ⇒ no structural evidence possible
  });

  it('scope containment: strong ownership/tenancy evidence does NOT touch a row that is already in-tolerance or drift', () => {
    const inTolerance = classifyNoiReconciliation(
      input({ workbookOxfordNoi: 104000, warehouseOxfordNoi: 100000, acqDate: '2026-01-01', recentTenancyAnnualRent: 999999 }),
      TOL,
    );
    expect(inTolerance.status).toBe('in-tolerance'); // unchanged — the downgrade only ever applies FROM large-drift

    const drift = classifyNoiReconciliation(
      input({ workbookOxfordNoi: 220000, warehouseOxfordNoi: 200000, acqDate: '2026-01-01', recentTenancyAnnualRent: 999999 }),
      TOL,
    );
    expect(drift.status).toBe('drift'); // unchanged — still warn, but not relabeled 'structural-mismatch'
  });
});

describe('both-null no-data status (COMPLETENESS — neither spine reports a value)', () => {
  it('a property tracked in both spines that newly has no NOI on either side is "no-data" (info), not missing-from-workbook (warn)', () => {
    // Adversarial finding (COMPLETENESS/MEDIUM): the prior both-null branch labeled the case
    // 'missing-from-workbook' with warn severity, which mislabels a recently-acquired
    // property (no warehouse ingest yet AND workbook NOI not yet populated) as if the workbook
    // were at fault. Reroute these cases to 'no-data' / info so dashboards triage correctly.
    const r = classifyNoiReconciliation(
      input({ workbookOxfordNoi: null, warehouseOxfordNoi: null, warehousePeriod: null, warehouseBasis: null }),
      TOL,
    );
    expect(r.status).toBe('no-data');
    expect(r.severity).toBe('info');
    expect(r.reason).toMatch(/no.*nai|neither spine|untracked|not yet/i);
  });
});

describe('drift reason names the higher spine (COMPLETENESS — UX/triage attribution)', () => {
  it('large-drift reason explicitly names workbook OR warehouse as the higher side, not just a signed delta', () => {
    // Adversarial finding (COMPLETENESS/MEDIUM): the reason field showed '-$200,000' or '+$200,000'
    // but the user reading a dashboard cannot tell at a glance which spine is higher without
    // re-reading the doc comment. Surface plain-English direction.
    const whHigher = classifyNoiReconciliation(
      input({ workbookOxfordNoi: 200000, warehouseOxfordNoi: 250000 }),
      TOL,
    );
    expect(whHigher.reason).toMatch(/warehouse.*exceeds.*workbook|warehouse oxfordNoi.*exceeds/i);

    const wbHigher = classifyNoiReconciliation(
      input({ workbookOxfordNoi: 250000, warehouseOxfordNoi: 200000 }),
      TOL,
    );
    expect(wbHigher.reason).toMatch(/workbook.*exceeds.*warehouse|workbook NOI.*exceeds/i);
  });
});

describe('reconcileNoiAB — assembler', () => {
  it('filters out residences and routes every other input through classify', () => {
    const rows = reconcileNoiAB(
      [
        input({}),
        input({ propertyId: 'persimmon', propertyName: 'Persimmon', isResidence: true }),
        input({ propertyId: 'red-branch', workbookOxfordNoi: 300000, warehouseOxfordNoi: 500000 }),
      ],
      TOL,
    );
    // Persimmon excluded; the other two classified.
    expect(rows.map((r) => r.propertyId).sort()).toEqual(['1100-rarig-ave-columbus-oh', 'red-branch']);
    // Red Branch: 40% drift (|delta|/max = 200k/500k) → large-drift / error.
    const rb = rows.find((r) => r.propertyId === 'red-branch')!;
    expect(rb.status).toBe('large-drift');
  });

  it('is deterministic — same inputs ⇒ same output order', () => {
    const a = reconcileNoiAB([input({}), input({ propertyId: 'b' }), input({ propertyId: 'a' })], TOL);
    const b = reconcileNoiAB([input({ propertyId: 'a' }), input({ propertyId: 'b' }), input({})], TOL);
    expect(a.map((r) => r.propertyId)).toEqual(b.map((r) => r.propertyId));
  });
});

// ── DB-join layer: reconcileNoiABFromDb / buildNoiReconcileInputs against a live temp warehouse ──
//
// The classifier above is well covered, but the join that bridges Spine A (workbook snapshot) to
// Spine B (warehouse periodMetrics at the latest full-year period) had ZERO tests. These seed a
// real migrated+ingested sqlite in a tmpdir (never the shared finance.sqlite), then drive the
// production join end-to-end and assert against the live propertyPeriodMetrics→latestFullYearPeriod
// path — no mocks. Local fixture writer + mapping seed (tests never import across test files).

// Local copy of the ingest fixture writer (mirrors warehouse-metrics.test.ts). The filename carries
// the year/grain (detect.ts), and the period cell header confirms the basis; a mid-year end → ytd.
async function writeReconcileFixture(
  path: string,
  propertyLine: string,
  periodLine: string,
  rent = 100000,
  repair = 5000,
): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  const rows: Array<[string | null, string | null, string | null, number | null]> = [
    ['Profit & Loss', null, null, null],
    [propertyLine, null, null, null],
    [periodLine, null, null, null],
    [null, 'INCOME', null, null],
    [null, null, '     5002 RENTAL INCOME', null],
    [null, null, '          5064 Rent', rent],
    [null, 'EXPENSE', null, null],
    [null, null, '     6160 REPAIR', null],
    [null, null, '          6285 HVAC Repair', repair],
    [null, 'NON OPERATING EXPENSE', null, null],
    [null, null, '          7402 Distribution to Owner', 25000],
  ];
  for (const r of rows) ws.addRow(r);
  await wb.xlsx.writeFile(path);
}

const RECON_SEED = [
  { account: 'Rent', code: '5064', normalized_category: 'Rental Revenue', classification: 'revenue' },
  { account: 'HVAC Repair', code: '6285', normalized_category: 'Repairs & Maintenance', classification: 'opex' },
  { account: 'Distribution to Owner', code: '7402', normalized_category: 'Distributions', classification: 'excluded' },
];

// Property slugs (from seedPropertyMaster / metrics-test verified mappings).
const RARIG = '1100-rarig-ave-columbus-oh';        // pnl, 100% owned, rentable_sf 21000
const RED_BRANCH = '9050-red-branch-rd-columbia-md'; // pnl, 50% owned
const FISHEL = '7658-fishel-dr-n-dublin-oh';        // financial_mode = 'lease-run'
const PHANTOM = 'not-a-real-property-slug';          // present ONLY in the snapshot — slug mismatch

/** Minimal snapshot stub — buildNoiReconcileInputs/reconcileNoiABFromDb read only
 *  properties[].{id,name,noi,type,acqDate} and leases[].{propertyId,leaseStart,annualRent}.
 *  `leases` defaults to [] so every pre-existing call site (which predates OI-137) is unaffected. */
function snapshot(
  properties: Array<{ id: string; name: string; noi: number | null; type?: string; acqDate?: string | null }>,
  leases: Array<{ propertyId: string | null; leaseStart: string | null; annualRent: number; status?: string }> = [],
): PortfolioSnapshot {
  return { properties, leases } as unknown as PortfolioSnapshot;
}

describe('reconcileNoiABFromDb / buildNoiReconcileInputs — DB join (live periodMetrics, no mocks)', () => {
  let db: WarehouseDb;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'whrn-'));
    db = openWarehouse(join(dir, 'f.sqlite')); // OWN tmpdir sqlite — never the shared finance.sqlite
    seedPropertyMaster(db); // seeds Rarig (pnl), Red Branch (pnl), Fishel (lease-run), etc.
    seedMappings(db, RECON_SEED);

    // Normal property — Rarig, FULL-YEAR 2025: rent 100k / repair 5k → NOI 95k, 100% owned → oxfordNoi 95k.
    const rarig = join(dir, 'P&L 2025 -- 1100 Rarig.xlsx');
    await writeReconcileFixture(rarig, 'Property: 1100 Rarig Ave', '01/01/25 - 12/31/25  (cash basis)', 100000, 5000);
    expect((await ingestFile(db, rarig, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T00:00:00Z' })).status).toBe('committed');

    // YTD-only property — Red Branch, mid-year 2025 (filename + cell both YTD) → grainHint 'ytd',
    // so latestFullYearPeriod() returns null and the property has NO full-year warehouse NOI.
    const rb = join(dir, 'P&L 2025 YTD -- 9050 Red Branch.xlsx');
    await writeReconcileFixture(rb, 'Property: 9050 Red Branch Rd', '01/01/25 - 06/30/25  (cash basis)', 40000, 2000);
    expect((await ingestFile(db, rb, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T00:01:00Z' })).status).toBe('committed');
  });

  afterAll(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('(a) a lease-run property is skipped — isLeaseRun true, status lease-run-skipped', () => {
    const snap = snapshot([{ id: FISHEL, name: 'Fishel', noi: 50000 }]);
    const inputs = buildNoiReconcileInputs(snap, propertyPeriodMetrics(db), [{ id: FISHEL, financialMode: 'lease-run' }]);
    const fishel = inputs.find((i) => i.propertyId === FISHEL)!;
    expect(fishel.isLeaseRun).toBe(true);

    const rows = reconcileNoiABFromDb(db, snap, TOL);
    expect(rows.find((r) => r.propertyId === FISHEL)?.status).toBe('lease-run-skipped');
  });

  it('(b) a normal property joins on the latest full-year period and ties workbook NOI to warehouse oxfordNoi', () => {
    // Workbook NOI = 95000 matches warehouse oxfordNoi (95000, 100% owned) at period 2025 → exact match.
    const snap = snapshot([{ id: RARIG, name: 'Rarig', noi: 95000 }]);
    const inputs = buildNoiReconcileInputs(snap, propertyPeriodMetrics(db), [{ id: RARIG, financialMode: 'pnl' }]);
    const rarig = inputs.find((i) => i.propertyId === RARIG)!;
    expect(rarig.warehousePeriod).toBe('2025');           // latestFullYearPeriod join target
    expect(rarig.warehouseOxfordNoi).toBe(95000);         // live periodMetrics oxfordNoi
    expect(rarig.isLeaseRun).toBe(false);

    const row = reconcileNoiABFromDb(db, snap, TOL).find((r) => r.propertyId === RARIG)!;
    expect(row.period).toBe('2025');
    expect(row.status).toBe('match');
    expect(row.delta).toBe(0);
  });

  it('(c) a YTD-only property has no full-year period → warehouseOxfordNoi null, period null', () => {
    // Red Branch only has a YTD-2025 batch, so latestFullYearPeriod() → null and the join yields no FY row.
    const snap = snapshot([{ id: RED_BRANCH, name: 'Red Branch', noi: 120000 }]);
    const inputs = buildNoiReconcileInputs(snap, propertyPeriodMetrics(db), [{ id: RED_BRANCH, financialMode: 'pnl' }]);
    const rb = inputs.find((i) => i.propertyId === RED_BRANCH)!;
    expect(rb.warehouseOxfordNoi).toBeNull();
    expect(rb.warehousePeriod).toBeNull();
    expect(rb.warehouseBasis).toBeNull();

    const row = reconcileNoiABFromDb(db, snap, TOL).find((r) => r.propertyId === RED_BRANCH)!;
    expect(row.status).toBe('missing-from-warehouse'); // workbook present, warehouse FY absent
  });

  it('(d) a snapshot slug that does not exist in the warehouse produces no spurious match', () => {
    // PHANTOM is present only in the snapshot; the warehouse has no metrics or master row for it.
    const snap = snapshot([{ id: PHANTOM, name: 'Phantom', noi: 80000 }]);
    const inputs = buildNoiReconcileInputs(snap, propertyPeriodMetrics(db), [{ id: PHANTOM, financialMode: 'pnl' }]);
    const phantom = inputs.find((i) => i.propertyId === PHANTOM)!;
    expect(phantom.warehouseOxfordNoi).toBeNull(); // no slug join ⇒ no warehouse NOI
    expect(phantom.warehousePeriod).toBeNull();

    const row = reconcileNoiABFromDb(db, snap, TOL).find((r) => r.propertyId === PHANTOM)!;
    expect(row.status).toBe('missing-from-warehouse'); // never a false match against another property
    expect(row.delta).toBeNull();
  });

  it('(e) RECONCILE_SLUG_ALIASES resolves the FVC workbook slug to the canonical property_master.id (H4)', () => {
    // The FVC workbook name slugs to 'fvc-fairground-village-center-sepich-portfolio-8-props' but
    // property_master.id is 'sepich-portfolio-columbus-oh-8-props'. Without the alias, the warehouse
    // series lookup would return [] and the row silently shows missing-from-warehouse.
    const snap = snapshot([{
      id: 'fvc-fairground-village-center-sepich-portfolio-8-props',
      name: 'FVC — Fairground Village Center',
      noi: 50000,
    }]);
    const inputs = buildNoiReconcileInputs(snap, [], []);
    // Assert by identity, not array position — decoupled from buildNoiReconcileInputs ordering.
    const row = inputs.find((i) => i.propertyId === 'sepich-portfolio-columbus-oh-8-props');
    expect(row).toBeDefined();
    expect(row!.workbookOxfordNoi).toBe(50000);
  });

  it('(f) a warehouse-only property absent from the workbook spine emits a missing-from-workbook row (M3 escape fix)', async () => {
    // Rarig has committed full-year data but is NOT in the snapshot.
    // Before M3 fix: buildNoiReconcileInputs only iterated snapshot.properties → Rarig escaped.
    // After fix: the warehouse-only sweep appends it with workbookOxfordNoi=null.
    const snap = snapshot([]); // empty — Rarig is warehouse-only
    const inputs = buildNoiReconcileInputs(snap, propertyPeriodMetrics(db), [{ id: RARIG, financialMode: 'pnl' }]);
    const rarig = inputs.find((i) => i.propertyId === RARIG);
    expect(rarig).toBeDefined();
    expect(rarig!.workbookOxfordNoi).toBeNull();
    expect(rarig!.warehouseOxfordNoi).not.toBeNull(); // FY 2025 oxfordNoi present

    const rows = reconcileNoiABFromDb(db, snap, TOL);
    const row = rows.find((r) => r.propertyId === RARIG);
    expect(row).toBeDefined();
    expect(row!.status).toBe('missing-from-workbook');
  });

  it('(g) buildNoiReconcileInputs carries Property.acqDate through to NoiReconcileInput.acqDate (OI-137)', () => {
    const snap = snapshot([{ id: RARIG, name: 'Rarig', noi: 95000, acqDate: '2025-06-01' }]);
    const inputs = buildNoiReconcileInputs(snap, propertyPeriodMetrics(db), [{ id: RARIG, financialMode: 'pnl' }]);
    expect(inputs.find((i) => i.propertyId === RARIG)!.acqDate).toBe('2025-06-01');
  });

  it('(g2) a missing acqDate normalizes to null, not undefined — NoiReconcileInput.acqDate is always string | null', () => {
    const snap = snapshot([{ id: RARIG, name: 'Rarig', noi: 95000 }]); // acqDate omitted entirely
    const inputs = buildNoiReconcileInputs(snap, propertyPeriodMetrics(db), [{ id: RARIG, financialMode: 'pnl' }]);
    expect(inputs.find((i) => i.propertyId === RARIG)!.acqDate).toBeNull();
  });

  it('(h) buildNoiReconcileInputs sums recentTenancyAnnualRent from ONLY this property\'s leases starting on/after the FY period, ignoring others (OI-137)', () => {
    // Rarig's warehousePeriod resolves to '2025' (from the shared beforeAll fixture) ⇒ periodStart 2025-01-01.
    const snap = snapshot(
      [{ id: RARIG, name: 'Rarig', noi: 95000 }],
      [
        { propertyId: RARIG, leaseStart: '2026-01-15', annualRent: 30000, status: 'Active' },  // counts: after period start
        { propertyId: RARIG, leaseStart: '2025-01-01', annualRent: 20000, status: 'Active' },  // counts: boundary, inclusive
        { propertyId: RARIG, leaseStart: '2019-05-01', annualRent: 50000, status: 'Active' },  // excluded: long before the period
        { propertyId: RARIG, leaseStart: null, annualRent: 15000, status: 'Active' },          // excluded: no start date to evaluate
        { propertyId: RED_BRANCH, leaseStart: '2026-01-15', annualRent: 99999, status: 'Active' }, // excluded: different property
      ],
    );
    const inputs = buildNoiReconcileInputs(snap, propertyPeriodMetrics(db), [{ id: RARIG, financialMode: 'pnl' }]);
    expect(inputs.find((i) => i.propertyId === RARIG)!.recentTenancyAnnualRent).toBe(50000); // 30000 + 20000
  });

  it('(h1) ADVERSARIAL FIX: recentTenancyAnnualRent excludes leases that are no longer currently in force (Expired/Vacant), even if leaseStart qualifies', () => {
    // Closes a gap an adversarial review found: an Expired lease that started and already churned
    // out within the comparison window is not part of the CURRENT rent roll this signal is meant
    // to represent, and must not count as evidence for a drift it can no longer be causing.
    const snap = snapshot(
      [{ id: RARIG, name: 'Rarig', noi: 95000 }],
      [
        { propertyId: RARIG, leaseStart: '2026-01-15', annualRent: 30000, status: 'Active' },        // counts
        { propertyId: RARIG, leaseStart: '2026-02-01', annualRent: 40000, status: 'Expiring Soon' },  // counts — still currently in force
        { propertyId: RARIG, leaseStart: '2025-03-01', annualRent: 25000, status: 'Expired' },        // excluded — no longer current
        { propertyId: RARIG, leaseStart: '2025-04-01', annualRent: 18000, status: 'Vacant' },         // excluded — no longer current
      ],
    );
    const inputs = buildNoiReconcileInputs(snap, propertyPeriodMetrics(db), [{ id: RARIG, financialMode: 'pnl' }]);
    expect(inputs.find((i) => i.propertyId === RARIG)!.recentTenancyAnnualRent).toBe(70000); // 30000 + 40000 only
  });

  it('(h2) recentTenancyAnnualRent is null (not 0) when there is no FY period to compare leaseStart against', () => {
    // mystery-prop has no warehouse data at all ⇒ no fyPeriod ⇒ the tenancy signal cannot be computed.
    const snap = snapshot(
      [{ id: 'mystery-prop-not-in-warehouse', name: 'Mystery', noi: 50000 }],
      [{ propertyId: 'mystery-prop-not-in-warehouse', leaseStart: '2026-01-15', annualRent: 30000 }],
    );
    const inputs = buildNoiReconcileInputs(snap, propertyPeriodMetrics(db), []);
    expect(inputs.find((i) => i.propertyId === 'mystery-prop-not-in-warehouse')!.recentTenancyAnnualRent).toBeNull();
  });

  it('(h3) buildNoiReconcileInputs never crashes when snapshot.leases is absent (pre-OI-137 minimal snapshot stubs)', () => {
    const bareSnap = { properties: [{ id: RARIG, name: 'Rarig', noi: 95000 }] } as unknown as PortfolioSnapshot;
    expect(() => buildNoiReconcileInputs(bareSnap, propertyPeriodMetrics(db), [{ id: RARIG, financialMode: 'pnl' }])).not.toThrow();
    const inputs = buildNoiReconcileInputs(bareSnap, propertyPeriodMetrics(db), [{ id: RARIG, financialMode: 'pnl' }]);
    expect(inputs.find((i) => i.propertyId === RARIG)!.recentTenancyAnnualRent).toBe(0);
  });

  it('(h4) a lease with propertyId: null — the shape server/workbook/parse.ts\'s resolvePropertyId ' +
     'returns for a rent-roll key it could not resolve — is silently excluded from every property\'s ' +
     'recentTenancyAnnualRent (2026-08-21, closes the untested resolvePropertyId->reconcile-noi ' +
     'integration path an adversarial review flagged: this pins the current, accepted drop-silently ' +
     'behavior so a future change to the propertyId===null branch can\'t regress it unnoticed)', () => {
    const snap = snapshot(
      [{ id: RARIG, name: 'Rarig', noi: 95000 }],
      [
        { propertyId: RARIG, leaseStart: '2026-01-15', annualRent: 30000, status: 'Active' }, // counts
        // Unresolved rent-roll key: must not leak into ANY property's total, including Rarig's.
        { propertyId: null, leaseStart: '2026-01-15', annualRent: 999999, status: 'Active' },
      ],
    );
    expect(() => buildNoiReconcileInputs(snap, propertyPeriodMetrics(db), [{ id: RARIG, financialMode: 'pnl' }])).not.toThrow();
    const inputs = buildNoiReconcileInputs(snap, propertyPeriodMetrics(db), [{ id: RARIG, financialMode: 'pnl' }]);
    expect(inputs.find((i) => i.propertyId === RARIG)!.recentTenancyAnnualRent).toBe(30000);
  });
});
