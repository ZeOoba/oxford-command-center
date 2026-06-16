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

  it('absolute floor still grants in-tolerance for small drift within the pct band (abs band + pct < largeDriftPct)', () => {
    // wb=12k, wh=5k: absDelta=7k ≤ $10k AND deltaPct=7/12=58% ... still fails because 58% > 20%.
    // Use a case where abs guards a pct-miss AND pct is also below largeDriftPct:
    // wb=11k, wh=9k: delta=2k, deltaPct=2/11=18.2% (between pctBand 5% and largeDriftPct 20%).
    // → absDelta=2k ≤ 10k AND deltaPct=18.2% < 20% → in-tolerance via abs band.
    const r = classifyNoiReconciliation(
      input({ workbookOxfordNoi: 11000, warehouseOxfordNoi: 9000 }),
      TOL,
    );
    expect(r.status).toBe('in-tolerance');
    expect(r.severity).toBe('info');
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

/** Minimal snapshot stub — buildNoiReconcileInputs/reconcileNoiABFromDb read only properties[].{id,name,noi,type}. */
function snapshot(properties: Array<{ id: string; name: string; noi: number | null; type?: string }>): PortfolioSnapshot {
  return { properties } as unknown as PortfolioSnapshot;
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
});
