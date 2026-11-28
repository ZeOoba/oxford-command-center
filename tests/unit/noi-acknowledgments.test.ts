// tests/unit/noi-acknowledgments.test.ts
//
// R34-3 (2026-11-23): ratified, dated per-property acknowledgments of a KNOWN Spine A / Spine B NOI
// drift. Replaces an attempted inference rung (five REFUTE rounds each found a medium edge in
// estimating lost rent from a roster that zeroes it). An acknowledgment downgrades a large-drift
// ERROR to a WARN only for the listed property, comparison period, direction and ceiling, before its
// expiry date, and never on a sign conflict or a $0 workbook NOI.
import ExcelJS from 'exceljs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PortfolioSnapshot } from '../../src/contracts/index';
import { openWarehouse } from '../../server/warehouse/db';
import { ingestFile } from '../../server/warehouse/ingest';
import { seedMappings } from '../../server/warehouse/mapping';
import { seedPropertyMaster } from '../../server/warehouse/property-master';
import {
  classifyNoiReconciliation,
  reconcileNoiABFromDb,
  type NoiReconcileInput,
  type Tolerance,
} from '../../server/warehouse/reconcile-noi';
import {
  loadNoiAcknowledgments,
  NOI_ACKNOWLEDGMENTS_PATH,
  type NoiDriftAcknowledgment,
} from '../../server/warehouse/noi-acknowledgments';

const TOL: Tolerance = { pctBand: 0.05, absBandUsd: 10000, largeDriftPct: 0.20 };
const RARIG = '1100-rarig-ave-columbus-oh';

const ACK: NoiDriftAcknowledgment = {
  propertyId: RARIG,
  comparisonPeriod: '2025',
  direction: 'warehouse-exceeds-workbook',
  maxDeltaPct: 0.6,
  expires: '2027-06-30',
  ratifiedBy: 'Gabriel',
  ratifiedOn: '2026-11-23',
  reason: 'Suite lease expired after the comparison year; its rent left the current rent roll.',
};

const input = (over: Partial<NoiReconcileInput>): NoiReconcileInput => ({
  propertyId: RARIG,
  propertyName: '1100 Rarig Ave, Columbus OH',
  workbookOxfordNoi: 130000,
  warehouseOxfordNoi: 165000, // delta -35,000, 21.2% -> large-drift
  warehousePeriod: '2025',
  warehouseBasis: 'cash',
  isLeaseRun: false,
  isResidence: false,
  acqDate: null,
  recentTenancyAnnualRent: null,
  acknowledgment: ACK,
  asOfDate: '2026-11-23',
  ...over,
});

describe('acknowledged drift — classifier', () => {
  it('matching acknowledgment downgrades large-drift to structural-mismatch/warn and says so', () => {
    const r = classifyNoiReconciliation(input({}), TOL);
    expect(r.status).toBe('structural-mismatch');
    expect(r.severity).toBe('warn');
    expect(r.reason).toMatch(/Acknowledged/);
    expect(r.reason).toMatch(/2027-06-30/);
    expect(r.reason).toMatch(/R34-3/);
  });

  it('a gap above the ratified ceiling still errors (a new break on top is not masked)', () => {
    const r = classifyNoiReconciliation(input({ workbookOxfordNoi: 60000 }), TOL); // 63.6% > 60%
    expect(r.status).toBe('large-drift');
    expect(r.severity).toBe('error');
  });

  it('exactly at the ceiling is covered', () => {
    const r = classifyNoiReconciliation(input({ workbookOxfordNoi: 66000 }), TOL); // 60.0%
    expect(r.status).toBe('structural-mismatch');
  });

  it('a different comparison period (new full-year ingest) is not covered', () => {
    expect(classifyNoiReconciliation(input({ warehousePeriod: '2026' }), TOL).status).toBe('large-drift');
    expect(classifyNoiReconciliation(input({ warehousePeriod: null }), TOL).status).not.toBe('structural-mismatch');
  });

  it('on or after the expiry date it no longer applies; an unknown as-of date never applies', () => {
    expect(classifyNoiReconciliation(input({ asOfDate: '2027-06-29' }), TOL).status).toBe('structural-mismatch');
    expect(classifyNoiReconciliation(input({ asOfDate: '2027-06-30' }), TOL).status).toBe('large-drift');
    expect(classifyNoiReconciliation(input({ asOfDate: null }), TOL).status).toBe('large-drift');
    expect(classifyNoiReconciliation(input({ asOfDate: 'not-a-date' }), TOL).status).toBe('large-drift');
  });

  it('the opposite direction (workbook exceeds warehouse) is not covered', () => {
    const r = classifyNoiReconciliation(input({ workbookOxfordNoi: 165000, warehouseOxfordNoi: 130000 }), TOL);
    expect(r.status).toBe('large-drift');
  });

  it('never covers a sign conflict or a $0 workbook NOI', () => {
    expect(classifyNoiReconciliation(input({ workbookOxfordNoi: -20000 }), TOL).status).toBe('large-drift');
    expect(classifyNoiReconciliation(input({ workbookOxfordNoi: 0 }), TOL).status).toBe('large-drift');
  });

  it('an acknowledgment for another property never applies', () => {
    const r = classifyNoiReconciliation(input({ acknowledgment: { ...ACK, propertyId: 'other-property' } }), TOL);
    expect(r.status).toBe('large-drift');
  });

  it('never touches in-tolerance or drift rows, and absent acknowledgment changes nothing', () => {
    expect(classifyNoiReconciliation(input({ workbookOxfordNoi: 160000 }), TOL).status).toBe('in-tolerance');
    expect(classifyNoiReconciliation(input({ workbookOxfordNoi: 145000 }), TOL).status).toBe('drift');
    expect(classifyNoiReconciliation(input({ acknowledgment: null }), TOL).status).toBe('large-drift');
    expect(classifyNoiReconciliation(input({ acknowledgment: undefined }), TOL).status).toBe('large-drift');
  });
});

describe('loadNoiAcknowledgments — fail closed on absence, fail loud on malformation', () => {
  let dir: string | undefined;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });
  const write = (body: unknown): string => {
    dir = mkdtempSync(join(tmpdir(), 'noi-ack-'));
    const p = join(dir, 'acks.json');
    writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body));
    return p;
  };

  it('a missing file means no acknowledgments (never a downgrade)', () => {
    expect(loadNoiAcknowledgments(join(tmpdir(), 'does-not-exist-noi-acks.json'))).toEqual([]);
  });

  it('parses a valid file', () => {
    expect(loadNoiAcknowledgments(write({ version: 1, acknowledgments: [ACK] }))).toEqual([ACK]);
  });

  it.each([
    ['unparseable JSON', '{ not json'],
    ['unknown top-level key', { version: 1, acknowledgments: [], extra: true }],
    ['wrong version', { version: 2, acknowledgments: [ACK] }],
    ['unknown entry key', { version: 1, acknowledgments: [{ ...ACK, amountUsd: 1 }] }],
    ['ceiling above 100%', { version: 1, acknowledgments: [{ ...ACK, maxDeltaPct: 1.5 }] }],
    ['ceiling of zero', { version: 1, acknowledgments: [{ ...ACK, maxDeltaPct: 0 }] }],
    ['bad expiry date', { version: 1, acknowledgments: [{ ...ACK, expires: '2027-13-40' }] }],
    ['period not a year', { version: 1, acknowledgments: [{ ...ACK, comparisonPeriod: '2025-H1' }] }],
    ['unsupported direction', { version: 1, acknowledgments: [{ ...ACK, direction: 'workbook-exceeds-warehouse' }] }],
    ['empty reason', { version: 1, acknowledgments: [{ ...ACK, reason: '' }] }],
    ['expiry not after ratification', { version: 1, acknowledgments: [{ ...ACK, expires: '2026-11-23' }] }],
    ['duplicate property', { version: 1, acknowledgments: [ACK, { ...ACK, reason: 'second' }] }],
  ])('throws on %s', (_label, body) => {
    expect(() => loadNoiAcknowledgments(write(body))).toThrow();
  });

  it('the shipped config parses and its Rarig entry is the ratified R34-3 shape', () => {
    const acks = loadNoiAcknowledgments(NOI_ACKNOWLEDGMENTS_PATH);
    const rarig = acks.find((a) => a.propertyId === RARIG)!;
    expect(rarig).toBeDefined();
    expect(rarig.comparisonPeriod).toBe('2025');
    expect(rarig.direction).toBe('warehouse-exceeds-workbook');
    expect(rarig.maxDeltaPct).toBe(0.25); // ratified 2026-11-23; see the internal record
    expect(rarig.expires <= '2027-06-30').toBe(true);
  });

  // 2026-11-27 review: this file is committed to a PUBLIC repo, so a reason is an opaque reference to
  // the internal record, never unit-level occupancy events (which unit, lease dates, notices to vacate).
  it('every shipped reason is an opaque reference: no unit, lease, notice or calendar-date detail', () => {
    for (const a of loadNoiAcknowledgments(NOI_ACKNOWLEDGMENTS_PATH)) {
      expect(a.reason).toMatch(/internal record/i);
      expect(a.reason).not.toMatch(/\bunits?\b|\bsuites?\b|\blease|\bvacate|\bnotice|\btenant|\d{4}-\d{2}-\d{2}/i);
    }
  });

  it('the shipped entry covers a gap under its 25% ceiling but NOT one above it (pseudonymous amounts)', () => {
    const rarig = loadNoiAcknowledgments(NOI_ACKNOWLEDGMENTS_PATH).find((a) => a.propertyId === RARIG)!;
    const shipped = (wb: number) => classifyNoiReconciliation(
      input({ workbookOxfordNoi: wb, warehouseOxfordNoi: 100000, acknowledgment: rarig, asOfDate: '2026-11-23' }), TOL,
    );
    // 22%: strictly between TOL.largeDriftPct (20%) and the 25% ceiling, so only the acknowledgment saves it.
    expect(shipped(78000).status).toBe('structural-mismatch');
    expect(shipped(78000).reason).toMatch(/Acknowledged/);
    expect(shipped(45000).status).toBe('large-drift'); // 55%
    expect(shipped(45000).severity).toBe('error');
  });
});

describe('reconcileNoiABFromDb — acknowledgments flow through the DB join', () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => { cleanup?.(); cleanup = undefined; });

  async function buildDb() {
    const dir = mkdtempSync(join(tmpdir(), 'noi-ack-db-'));
    const db = openWarehouse(join(dir, 'f.sqlite'));
    seedPropertyMaster(db);
    seedMappings(db, [
      { account: 'Rent', code: '5064', normalized_category: 'Rental Revenue', classification: 'revenue' },
      { account: 'HVAC Repair', code: '6285', normalized_category: 'Repairs & Maintenance', classification: 'opex' },
    ]);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    for (const r of [
      ['Profit & Loss', null, null, null],
      ['Property: 1100 Rarig Ave', null, null, null],
      ['01/01/25 - 12/31/25  (cash basis)', null, null, null],
      [null, 'INCOME', null, null],
      [null, null, '     5002 RENTAL INCOME', null],
      [null, null, '          5064 Rent', 100000],
      [null, 'EXPENSE', null, null],
      [null, null, '     6160 REPAIR', null],
      [null, null, '          6285 HVAC Repair', 5000],
    ]) ws.addRow(r);
    const f = join(dir, 'P&L 2025 -- 1100 Rarig.xlsx');
    await wb.xlsx.writeFile(f);
    expect((await ingestFile(db, f, { rawDir: join(dir, 'raw'), importedAt: '2026-06-13T00:00:00Z' })).status).toBe('committed');
    cleanup = () => { db.close(); rmSync(dir, { recursive: true, force: true }); };
    return db;
  }

  const snap = (noi: number): PortfolioSnapshot => ({
    properties: [{
      id: RARIG, name: RARIG, address: '', city: null, state: null, market: 'Columbus', type: 'Industrial',
      sf: 20000, tenantCount: 1, occPct: 1, acqDate: null, estValue100: 1000000, oxfordOwnPct: 1,
      oxfordValue: 1000000, grossIncome: noi + 5000, expenses: 5000, noi, noiScenarioAdj: 0, debtService: 0,
      netCashFlow: noi, capRate: null, dscr: null, lender: null, loanBalance: 0, ltv: null, valuePerSf: null,
      rentPerSf: null, equityInvested: 0, cashOnCash: null, holdYrs: null, encumbered: false, flags: [], index: null,
    }],
    leases: [],
  } as unknown as PortfolioSnapshot);

  it('the builder rejects duplicate acknowledgments even when the loader is bypassed', async () => {
    const db = await buildDb();
    expect(() => reconcileNoiABFromDb(db, snap(70000), undefined, {
      acknowledgments: [{ ...ACK, maxDeltaPct: 0.25 }, ACK], asOfDate: '2026-11-23',
    })).toThrow(/duplicate/);
  });

  it('warehouse 95,000 vs workbook 70,000 (26.3%): error without an acknowledgment, warn with one', async () => {
    const db = await buildDb();
    const without = reconcileNoiABFromDb(db, snap(70000)).find((r) => r.propertyId === RARIG)!;
    expect(without.status).toBe('large-drift');
    const withAck = reconcileNoiABFromDb(db, snap(70000), undefined, { acknowledgments: [ACK], asOfDate: '2026-11-23' })
      .find((r) => r.propertyId === RARIG)!;
    expect(withAck.status).toBe('structural-mismatch');
    expect(withAck.severity).toBe('warn');
  });
});
