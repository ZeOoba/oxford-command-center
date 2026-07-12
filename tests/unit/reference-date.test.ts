// tests/unit/reference-date.test.ts
//
// Frozen-dateline decouple (2026-07-11). WORKBOOK_AS_OF (the workbook DATA date, pinned
// '2026-06-01') was doing double duty as the day-count / "As of" reference, freezing the Daily
// Brief body dateline and every "expires in Nd" count in June while the run date advanced into
// July. (The 2026-07-09 incident fixed the SUBJECT line only.) These tests pin the ratified
// decouple:
//   (1) config.referenceDate() = the run date, REPORT_DATE-pinnable, call-time resolved;
//   (2) lease day-count math (monthsToExpiry at parse time, critical-date "Nd" in the analytics
//       bundle, the brief body "As of" label) tracks the reference date;
//   (3) the workbook data-month column selection (parse.ts monthCol) STAYS bound to
//       WORKBOOK_AS_OF — early in a month the workbook may not carry the run month's column yet,
//       and reading an empty column would silently corrupt every snapshot metric.
import ExcelJS from 'exceljs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import type { PortfolioSnapshot, Lease, InsurancePolicy } from '../../src/contracts/index';
import { WORKBOOK_AS_OF, referenceDate } from '../../server/config';
import { parseWorkbook } from '../../server/workbook/parse';
import { buildAnalytics } from '../../src/analytics/engine';
import { evaluateConditions } from '../../src/analytics/conditions';
import { runBrief } from '../../server/brief/run';

// ── env hygiene: never leak REPORT_DATE / WAREHOUSE_DB into other tests ─────────────────────────
const ORIGINAL_REPORT_DATE = process.env.REPORT_DATE;
const ORIGINAL_WAREHOUSE_DB = process.env.WAREHOUSE_DB;
afterEach(() => {
  if (ORIGINAL_REPORT_DATE === undefined) delete process.env.REPORT_DATE;
  else process.env.REPORT_DATE = ORIGINAL_REPORT_DATE;
  if (ORIGINAL_WAREHOUSE_DB === undefined) delete process.env.WAREHOUSE_DB;
  else process.env.WAREHOUSE_DB = ORIGINAL_WAREHOUSE_DB;
});

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────────
function lease(l: Partial<Lease>): Lease {
  return {
    id: Math.random().toString(36).slice(2),
    propertyKey: 'P',
    propertyId: 'p',
    tenantName: 'T',
    unit: null,
    company: 'Fixture Co',
    sf: 0,
    monthlyRent: 0,
    rentPerSf: null,
    leaseStart: null,
    leaseEnd: null,
    escalationDate: null,
    escalationPct: null,
    status: 'Active',
    annualRent: 0,
    monthsToExpiry: null,
    flags: [],
    ...l,
  };
}

function snap(s: Partial<PortfolioSnapshot>): PortfolioSnapshot {
  return {
    meta: { schemaVersion: '1.0.0', asOf: '2026-06-01', generatedAt: '2026-06-01T00:00:00.000Z', source: 'test', scenario: 'Base' },
    assumptions: {
      activeScenario: 'Base', revenueFactor: 1, vacancyFactor: 1, exitCapFactor: 1,
      thresholds: { balloonAlertMonths: 18, concentrationYellow: 0.25, concentrationRed: 0.5 },
      asOf: '2026-06-01',
    },
    properties: [], leases: [], loans: [], deals: [], insurance: [], tasks: [], counterparties: [], dataQuality: [],
    renewalStages: {}, tenantArrears: {}, tenantNotes: {}, dealStages: {}, noiBudgets: {},
    cash: { asOf: '2026-06-01', totalCash: 0, activeEntities: 0, largestEntity: null, concentrationTopPct: null, cagr: null, entities: [], history: [] },
    ...s,
  } as unknown as PortfolioSnapshot;
}

const PROPERTY_NAME = 'Fixture Property Beta';

/**
 * Minimal synthetic workbook: one property, one lease ending 2027-01-01, and one Monthly
 * Checklist task row carrying DIFFERENT status glyphs in the WORKBOOK_AS_OF month column
 * ('✅' → done) vs the reference-date month column ('⚠' → overdue) — so which column
 * parseTasks reads is directly observable from the parsed status.
 */
async function writeFixtureWorkbook(path: string, dataMonthCol: number, refMonthCol: number): Promise<void> {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('Property NOI').addRow([
    1, PROPERTY_NAME, 'Industrial', 50000, 1, 0.9, new Date('2020-01-01'),
    1000000, 1, 1000000, 100000, 20000, 80000, 80000, 0, 80000, 0.08, null, null, 0,
  ]);
  wb.addWorksheet('Master Tenant Rent Roll').addRow([
    PROPERTY_NAME, 'Fixture Tenant', 'A', 'Fixture Tenant',
    1000, 1000, 12, new Date('2022-01-01'), new Date('2027-01-01'), null, null, 'Active', 12000,
  ]);
  wb.addWorksheet('Loan Index');
  wb.addWorksheet('Cash Balances');
  wb.addWorksheet('Insurance Renewals');
  const tasks = wb.addWorksheet('Monthly Checklist');
  const row: unknown[] = [];
  row[0] = 'Fixture recurring task'; // label (col 1)
  row[3] = 'Recurring'; // type (col 4)
  row[4] = '15'; // dueDay (col 5)
  row[dataMonthCol - 1] = '✅'; // status in the WORKBOOK_AS_OF month column
  row[refMonthCol - 1] = '⚠'; // status in the reference-date month column
  row[18] = 'Ops'; // section (col 19)
  row[19] = 'task-1'; // RowID (col 20)
  tasks.addRow(row);
  wb.addWorksheet('Assumptions');
  await wb.xlsx.writeFile(path);
}

// ── (1) config.referenceDate() ───────────────────────────────────────────────────────────────────
describe('referenceDate()', () => {
  it('REPORT_DATE env wins, re-read at call time (not module import time)', () => {
    delete process.env.REPORT_DATE;
    referenceDate(); // module already imported with no override
    process.env.REPORT_DATE = '2031-12-31';
    expect(referenceDate()).toBe('2031-12-31');
    expect(referenceDate('2026-01-15')).toBe('2031-12-31'); // env beats the caller fallback
  });

  it('uses the caller-supplied fallback when REPORT_DATE is unset', () => {
    delete process.env.REPORT_DATE;
    expect(referenceDate('2026-01-15')).toBe('2026-01-15');
  });

  it('defaults to the current UTC date when neither env nor fallback is given', () => {
    delete process.env.REPORT_DATE;
    const got = referenceDate();
    expect(got).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(got).toBe(new Date().toISOString().slice(0, 10));
  });
});

// ── (2a) parse: monthsToExpiry off referenceDate; (3) monthCol stays on WORKBOOK_AS_OF ──────────
describe('parseWorkbook — day-counts track referenceDate, data-month column stays on WORKBOOK_AS_OF', () => {
  it('computes lease monthsToExpiry from the reference date, reads task status from the WORKBOOK_AS_OF month column, and keeps meta.asOf on the workbook data date', async () => {
    const REF = '2026-07-11';
    process.env.REPORT_DATE = REF;

    const dataMonthCol = 7 + new Date(WORKBOOK_AS_OF).getUTCMonth();
    const refMonthCol = 7 + new Date(REF).getUTCMonth();
    // Sanity: the two candidate columns must differ or this test proves nothing.
    expect(refMonthCol).not.toBe(dataMonthCol);

    const dir = mkdtempSync(join(tmpdir(), 'refdate-parse-'));
    const file = join(dir, 'fixture.xlsx');
    await writeFixtureWorkbook(file, dataMonthCol, refMonthCol);

    const { snapshot } = await parseWorkbook(file);

    // (a) Day-count math: leaseEnd 2027-01-01 is 6 calendar months from 2026-07-11.
    //     The frozen behavior (WORKBOOK_AS_OF 2026-06-01) would yield 7.
    expect(snapshot.leases).toHaveLength(1);
    expect(snapshot.leases[0]!.monthsToExpiry).toBe(6);

    // (c) Data-month selection UNCHANGED: the task status must come from the WORKBOOK_AS_OF
    //     month column ('✅' → done), NOT the reference-date month column ('⚠' → overdue).
    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.tasks[0]!.status).toBe('done');

    // Data-snapshot label unchanged: meta.asOf remains the workbook DATA date.
    expect(snapshot.meta.asOf).toBe(WORKBOOK_AS_OF);
  });
});

// ── (2b) buildAnalytics: injected referenceDate drives critical-date "Nd"; default unchanged ────
describe('buildAnalytics — optional referenceDate for critical-date day-counts', () => {
  const s = snap({ leases: [lease({ id: 'l1', leaseEnd: '2026-07-21', annualRent: 12000 })] });

  it('computes criticalDates daysToDate from the injected referenceDate', () => {
    const a = buildAnalytics(s, 'Base', '2026-07-11');
    const exp = a.criticalDates.find((c) => c.kind === 'Expiration')!;
    expect(exp).toBeDefined();
    expect(exp.daysToDate).toBe(10); // 2026-07-21 minus 2026-07-11
  });

  it('defaults to meta.asOf when no referenceDate is passed (backward compatibility)', () => {
    const a = buildAnalytics(s);
    const exp = a.criticalDates.find((c) => c.kind === 'Expiration')!;
    expect(exp).toBeDefined();
    expect(exp.daysToDate).toBe(50); // 2026-07-21 minus meta.asOf 2026-06-01
  });
});

// ── (2c) runBrief: body "As of" label + critical-date "Nd" track the run date ────────────────────
describe('runBrief — body "As of" and day-counts track the run date, not the workbook date', () => {
  it('renders "As of <run date>" and lease-expiry day-counts relative to the run date', async () => {
    delete process.env.REPORT_DATE; // prove the deps.now → ET-date fallback path
    const dir = mkdtempSync(join(tmpdir(), 'refdate-brief-'));
    process.env.WAREHOUSE_DB = join(dir, 'nonexistent.sqlite'); // deterministic: skip warehouse insights
    const statePath = join(dir, 'state.json');

    const s = snap({
      meta: { schemaVersion: '1.0.0', asOf: '2026-06-04', generatedAt: '2026-06-04T00:00:00Z', source: 't', scenario: 'Base' },
      leases: [lease({ id: 'l1', leaseEnd: '2026-07-19', annualRent: 12000, company: 'Fixture Co' })],
    } as unknown as Partial<PortfolioSnapshot>);

    const emails: { subject: string; html: string }[] = [];
    const res = await runBrief(s, {
      statePath,
      now: new Date('2026-07-09T11:00:00Z'), // 07:00 ET → run/ET date 2026-07-09
      send: async (email) => { emails.push(email); return { ok: true, via: 'com' }; },
    });

    expect(res.briefSent).toBe(true);
    const brief = emails.find((e) => e.subject.includes('Daily Brief'))!;
    expect(brief).toBeDefined();

    // Body header: "As of" must be the RUN date (frozen-dateline defect: it showed the
    // pinned workbook date). The subject was already fixed 2026-07-09 and must stay on
    // the send date too.
    expect(brief.html).toContain('As of 2026-07-09');
    expect(brief.html).not.toContain('As of 2026-06-04');
    expect(brief.subject).toContain('2026-07-09');

    // Critical-date "Nd": 2026-07-19 is 10 days from the 2026-07-09 run date. The frozen
    // behavior computed 45 days (from meta.asOf 2026-06-04).
    expect(brief.html).toContain('Expiration: Fixture Co');
    expect(brief.html).toContain('(10d)');
    expect(brief.html).not.toContain('(45d)');
  });
});

// ── Finding A: Spine-A insurance-renewing insight day-count off referenceDate, not the
//    frozen workbook daysToExpiry column ─────────────────────────────────────────────────────────
function policy(p: Partial<InsurancePolicy>): InsurancePolicy {
  return {
    id: 'ins-fixture', property: 'Fixture Property', entity: null, coverage: 'Property',
    effective: null, expires: null, policyNo: null, carrier: 'Fixture Carrier', premium: 0,
    daysToExpiry: null, status: 'Renewing Soon', notes: null, flags: [],
    tiv: null, deductible: null, coverageLimit: null, ...p,
  };
}

describe('evaluateConditions — Spine-A insurance renewal day-count tracks referenceDate', () => {
  it('does NOT emit a stale positive "Nd" for a policy that already expired before the reference date', () => {
    // Bug repro: the workbook daysToExpiry column still reads +19 (frozen at the June data date),
    // but the policy expired 2026-06-20 — 21 days BEFORE the 2026-07-11 reference date. The old
    // code rendered "renews Jun 20, 2026 (19d)"; the fixed code computes daysBetween(expires, ref)
    // = -21 → not >= 0 → no "renewing soon" insight at all.
    const s = snap({ insurance: [policy({ id: 'ins-stale', expires: '2026-06-20', daysToExpiry: 19, status: 'Renewing Soon' })] });
    const out = evaluateConditions(s, { referenceDate: '2026-07-11' });
    const ins = out.find((i) => i.id === 'ins-ins-stale');
    expect(ins).toBeUndefined();
  });

  it('renders the run-date-relative "Nd" for a future policy, not the frozen daysToExpiry column', () => {
    // Policy expires 2026-07-21 = 10 days after the 2026-07-11 reference date. The frozen column
    // says 50; the fixed insight must render (10d).
    const s = snap({ insurance: [policy({ id: 'ins-future', expires: '2026-07-21', daysToExpiry: 50, status: 'Renewing Soon' })] });
    const out = evaluateConditions(s, { referenceDate: '2026-07-11' });
    const ins = out.find((i) => i.id === 'ins-ins-future');
    expect(ins).toBeDefined();
    expect(ins!.detail).toContain('(10d)');
    expect(ins!.detail).not.toContain('(50d)');
  });

  it('an already-Expired policy still surfaces the lapsed-critical insight (unchanged path)', () => {
    // Guard: the fix touches only the "renewing soon" branch. A status='Expired' policy must
    // still produce its ins-lapsed critical regardless of the day-count.
    const s = snap({ insurance: [policy({ id: 'ins-exp', expires: '2026-06-20', daysToExpiry: 19, status: 'Expired' })] });
    const out = evaluateConditions(s, { referenceDate: '2026-07-11' });
    expect(out.some((i) => i.id === 'ins-lapsed-ins-exp')).toBe(true);
    expect(out.some((i) => i.id === 'ins-ins-exp')).toBe(false);
  });
});

// ── Finding B: parseWorkbook accepts an explicit (ET) reference date for monthsToExpiry ──────────
describe('parseWorkbook — explicit referenceDateIso drives monthsToExpiry (ET-consistency)', () => {
  it('computes monthsToExpiry from the passed reference date, across a month boundary', async () => {
    // Month-boundary evening case: at ~8pm ET on 2026-07-31 the process UTC date has already
    // rolled to 2026-08-01. leaseEnd is 2027-01-01 (from writeFixtureWorkbook) and
    // differenceInCalendarMonths ignores day-of-month, so the ET date (Jul) and the UTC date
    // (Aug) yield DIFFERENT counts — the brief must use the ET date it supplies.
    const dir = mkdtempSync(join(tmpdir(), 'refdate-parse-et-'));
    const file = join(dir, 'fixture-et.xlsx');
    // monthCol columns are irrelevant here; reuse the same builder with equal cols (no task assert).
    await writeFixtureWorkbook(file, 12, 12);

    delete process.env.REPORT_DATE; // prove the passed arg wins over the (unset-env) default path

    const { snapshot: etSnap } = await parseWorkbook(file, '2026-07-31'); // ET evening
    expect(etSnap.leases).toHaveLength(1);
    expect(etSnap.leases[0]!.monthsToExpiry).toBe(6); // Jul 2026 → Jan 2027

    const { snapshot: utcSnap } = await parseWorkbook(file, '2026-08-01'); // rolled UTC date
    expect(utcSnap.leases[0]!.monthsToExpiry).toBe(5); // Aug 2026 → Jan 2027 — one fewer

    // Contrast: pinning REPORT_DATE to yet another date must NOT change the count — proving the
    // explicit arg, not the env, is what parseWorkbook used above.
    process.env.REPORT_DATE = '2026-06-01';
    const { snapshot: stillEt } = await parseWorkbook(file, '2026-07-31');
    expect(stillEt.leases[0]!.monthsToExpiry).toBe(6); // explicit arg still wins over env
  });

  it('falls back to referenceDate() (REPORT_DATE / UTC) when no explicit date is passed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'refdate-parse-def-'));
    const file = join(dir, 'fixture-def.xlsx');
    await writeFixtureWorkbook(file, 12, 12);

    process.env.REPORT_DATE = '2026-07-01'; // leaseEnd 2027-01-01 → 6 months
    const { snapshot } = await parseWorkbook(file);
    expect(snapshot.leases[0]!.monthsToExpiry).toBe(6);
  });
});
