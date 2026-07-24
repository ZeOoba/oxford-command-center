// tests/unit/parse-workbook.test.ts
//
// Real ingestion-path coverage for parseWorkbook() (server/workbook/parse.ts) -- the core Excel
// ingestion function that turns the firm's Master Workbook into properties/loans/leases/financials.
// Before this file, the only coverage was tests/unit/parse.test.ts (small pure helpers only, never
// calling parseWorkbook itself) and tests/unit/brain.test.ts (mocks parseWorkbook away entirely) --
// a regression here would silently corrupt financial data ingestion undetected. All fixture data
// below is deliberately, obviously synthetic (no real firm/tenant/deal/counterparty names).
import ExcelJS from 'exceljs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseWorkbook } from '../../server/workbook/parse';
import { slug } from '@contracts/index';

const PROPERTY_NAME = 'Test Property Alpha (Fixture)';

async function writeFixtureWorkbook(path: string): Promise<void> {
  const wb = new ExcelJS.Workbook();

  // col: idx, name, type, sf, tenantCount, occ, acqDate, estValue100, oxfordOwnPct, oxfordValue,
  //      grossIncome, expenses, noi, noiScenarioAdj, debtService, netCashFlow, capRate, dscr,
  //      lender, loanBalance, ltv, valuePerSf, rentPerSf, equityInvested, cashOnCash, holdYrs
  const props = wb.addWorksheet('Property NOI');
  props.addRow([
    1, PROPERTY_NAME, 'Industrial', 50000, 3, 0.92, new Date('2020-01-01'),
    5000000, 1, 5000000, 600000, 200000, 400000, 400000, 300000, 100000, 0.08, 1.3,
    'Fixture Bank', 3000000, 0.6, 100, 12, 1500000, 0.08, 5,
  ]);

  // col: propertyKey, tenantName, unit, company, sf, monthlyRent, rentPerSf, leaseStart, leaseEnd,
  //      escalationDate, escalationPct, status, annualRent
  const rentRoll = wb.addWorksheet('Master Tenant Rent Roll');
  rentRoll.addRow([
    PROPERTY_NAME, 'Fixture Tenant Co', 'Suite 100', 'Fixture Tenant Co',
    10000, 8000, 9.6, new Date('2022-01-01'), new Date('2027-01-01'),
    null, null, 'Active', 96000,
  ]);

  const loans = wb.addWorksheet('Loan Index');
  loans.addRow(['IS BORROWER']); // banner row -> section = 'borrower'
  // col: idx, rawName, counterparty, balance, rate, monthlyPmt, maturity, monthsToMaturity, ltv,
  //      status, collateralProperty
  loans.addRow([
    1, 'Fixture Loan A', 'Fixture Bank', 3000000, 0.06, 18000,
    new Date('2030-01-01'), 42, 0.6, 'Current', PROPERTY_NAME,
  ]);

  // Sheets parseWorkbook requires to EXIST (by exact name) but tolerates empty:
  wb.addWorksheet('Cash Balances');
  wb.addWorksheet('Insurance Renewals');
  wb.addWorksheet('Monthly Checklist');
  wb.addWorksheet('Assumptions');

  await wb.xlsx.writeFile(path);
}

describe('parseWorkbook — real ingestion path (synthetic fixture, no mocks)', () => {
  it('parses properties, leases, and loans with resolved cross-references', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parse-workbook-test-'));
    const file = join(dir, 'fixture.xlsx');
    await writeFixtureWorkbook(file);

    const { snapshot, flags } = await parseWorkbook(file);

    // Properties
    expect(snapshot.properties).toHaveLength(1);
    const property = snapshot.properties[0]!;
    expect(property.id).toBe(slug(PROPERTY_NAME));
    expect(property.name).toBe(PROPERTY_NAME);
    expect(property.type).toBe('Industrial');
    expect(property.sf).toBe(50000);
    expect(property.occPct).toBeCloseTo(0.92);
    expect(property.noi).toBe(400000);
    expect(property.loanBalance).toBe(3000000);
    expect(property.encumbered).toBe(true); // loanBalance > 0

    // Leases -- propertyId must resolve via the shared-token match against the property name
    expect(snapshot.leases).toHaveLength(1);
    const lease = snapshot.leases[0]!;
    expect(lease.tenantName).toBe('Fixture Tenant Co');
    expect(lease.propertyKey).toBe(PROPERTY_NAME);
    expect(lease.propertyId).toBe(property.id);
    expect(lease.monthlyRent).toBe(8000);
    expect(lease.annualRent).toBe(96000);
    expect(lease.status).toBe('Active');

    // Loans -- section-aware banner parsing
    expect(snapshot.loans).toHaveLength(1);
    const loan = snapshot.loans[0]!;
    expect(loan.direction).toBe('borrower');
    expect(loan.name).toBe('Fixture Loan A');
    expect(loan.currentBalance).toBe(3000000);
    expect(loan.absBalance).toBe(3000000);
    expect(loan.lender).toBe('Fixture Bank');
    expect(loan.collateralProperty).toBe(PROPERTY_NAME);
    expect(loan.isDemand).toBe(false);
    expect(loan.maturity).toBe('2030-01-01');

    // A clean, fully-populated fixture should raise no data-quality flags of its own.
    // (loadDeals()/loadM365Tasks() run independently of the workbook and are asserted separately.)
    const ownFlags = flags.filter((f) => f.entity === property.id || f.entity === loan.id);
    expect(ownFlags).toEqual([]);
  });

  it('a lease id is stable when an unrelated row is inserted above it in the rent roll (row-position regression)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parse-workbook-test-'));
    const fileBefore = join(dir, 'before.xlsx');
    const fileAfter = join(dir, 'after.xlsx');

    async function writeWithLeases(path: string, insertExtraRowFirst: boolean): Promise<void> {
      const wb = new ExcelJS.Workbook();
      const props = wb.addWorksheet('Property NOI');
      props.addRow([
        1, PROPERTY_NAME, 'Industrial', 50000, 3, 0.92, new Date('2020-01-01'),
        5000000, 1, 5000000, 600000, 200000, 400000, 400000, 300000, 100000, 0.08, 1.3,
        'Fixture Bank', 3000000, 0.6, 100, 12, 1500000, 0.08, 5,
      ]);
      const rentRoll = wb.addWorksheet('Master Tenant Rent Roll');
      if (insertExtraRowFirst) {
        rentRoll.addRow([
          PROPERTY_NAME, 'Newly Added Tenant Co', 'Suite 050', 'Newly Added Tenant Co',
          5000, 4000, 9.6, new Date('2023-01-01'), new Date('2028-01-01'), null, null, 'Active', 48000,
        ]);
      }
      rentRoll.addRow([
        PROPERTY_NAME, 'Fixture Tenant Co', 'Suite 100', 'Fixture Tenant Co',
        10000, 8000, 9.6, new Date('2022-01-01'), new Date('2027-01-01'), null, null, 'Active', 96000,
      ]);
      const loans = wb.addWorksheet('Loan Index');
      loans.addRow(['IS BORROWER']); // banner row -> section = 'borrower'
      loans.addRow([
        1, 'Fixture Loan A', 'Fixture Bank', 3000000, 0.06, 18000,
        new Date('2030-01-01'), 42, 0.6, 'Current', PROPERTY_NAME,
      ]);
      wb.addWorksheet('Cash Balances');
      wb.addWorksheet('Insurance Renewals');
      wb.addWorksheet('Monthly Checklist');
      wb.addWorksheet('Assumptions');
      await wb.xlsx.writeFile(path);
    }

    await writeWithLeases(fileBefore, false);
    await writeWithLeases(fileAfter, true);

    const before = await parseWorkbook(fileBefore);
    const after = await parseWorkbook(fileAfter);

    const leaseBefore = before.snapshot.leases.find((l) => l.tenantName === 'Fixture Tenant Co')!;
    const leaseAfter = after.snapshot.leases.find((l) => l.tenantName === 'Fixture Tenant Co')!;

    // THE regression this fix closes: inserting an unrelated row above must NOT change this lease's id.
    expect(leaseAfter.id).toBe(leaseBefore.id);
    // The id is exactly the slug-derived base — no extra row-number suffix appended beyond what
    // the property/unit names naturally produce (the unit label "Suite 100" itself ends in
    // digits, so a bare /-\d+$/ check would false-positive; assert exact equality instead).
    expect(leaseBefore.id).toBe(`${slug(PROPERTY_NAME)}-${slug('Suite 100')}`);
  });

  it('attributes a date-quality flag to the FINAL (disambiguated) lease id, not the stale pre-collision base id', async () => {
    // Regression for the flag-misattribution defect: two rows collide on the same base lease id
    // (same property + same Suite/Unit -- the id formula keys off unit, not tenant name). The
    // SECOND colliding row carries an implausible-year leaseEnd cell (isoOrNull rejects years
    // outside 1990-2100 and raises a data-quality flag using the row's PRE-disambiguation id).
    // Under the pre-fix code, that flag's `entity` stayed the stale base id -- indistinguishable
    // from a flag legitimately belonging to the FIRST lease, which keeps that same base id after
    // disambiguateLeaseIds runs. The fix re-homes each row's flags onto the lease's FINAL id via
    // object-reference correlation, so the flag must land on the second lease's disambiguated
    // "<base>-2" id -- never the bare base id shared by the first lease.
    const dir = mkdtempSync(join(tmpdir(), 'parse-workbook-test-'));
    const file = join(dir, 'fixture-lease-id-collision-flag.xlsx');
    const wb = new ExcelJS.Workbook();

    const props = wb.addWorksheet('Property NOI');
    props.addRow([1, PROPERTY_NAME, 'Industrial', 50000, 3, 0.92]);

    const rentRoll = wb.addWorksheet('Master Tenant Rent Roll');
    // First row: same unit, valid leaseEnd -- raises no flag, keeps the base id.
    rentRoll.addRow([
      PROPERTY_NAME, 'Tenant One Co', 'Suite 100', 'Tenant One Co',
      10000, 8000, 9.6, new Date('2022-01-01'), new Date('2027-01-01'),
      null, null, 'Active', 96000,
    ]);
    // Second row: SAME unit ("Suite 100") -> collides on the pre-dedup base id; different tenant
    // name; leaseEnd year (1899) is outside isoOrNull's 1990-2100 plausible range -> raises a
    // 'leaseEnd' flag keyed (pre-fix) to the shared base id.
    rentRoll.addRow([
      PROPERTY_NAME, 'Tenant Two Co', 'Suite 100', 'Tenant Two Co',
      6000, 5000, 9.6, new Date('2022-06-01'), new Date('1899-01-01'),
      null, null, 'Active', 60000,
    ]);

    wb.addWorksheet('Loan Index');
    wb.addWorksheet('Cash Balances');
    wb.addWorksheet('Insurance Renewals');
    wb.addWorksheet('Monthly Checklist');
    wb.addWorksheet('Assumptions');
    await wb.xlsx.writeFile(file);

    const { snapshot, flags } = await parseWorkbook(file);

    expect(snapshot.leases).toHaveLength(2);
    const leaseOne = snapshot.leases.find((l) => l.tenantName === 'Tenant One Co')!;
    const leaseTwo = snapshot.leases.find((l) => l.tenantName === 'Tenant Two Co')!;

    const baseId = `${slug(PROPERTY_NAME)}-${slug('Suite 100')}`;
    // (a) distinct ids: first keeps the base, second gets disambiguated.
    expect(leaseOne.id).toBe(baseId);
    expect(leaseTwo.id).toBe(`${baseId}-2`);
    expect(leaseTwo.id).not.toBe(leaseOne.id);

    // (b) the leaseEnd flag must be attributed to the SECOND lease's final id -- not the bare
    // base id, and not the first lease's id (which happens to equal the bare base id).
    const leaseEndFlags = flags.filter((f) => f.field === 'leaseEnd');
    expect(leaseEndFlags).toHaveLength(1);
    expect(leaseEndFlags[0]!.entity).toBe(leaseTwo.id);
    expect(leaseEndFlags[0]!.entity).not.toBe(baseId);
    expect(leaseEndFlags[0]!.entity).not.toBe(leaseOne.id);
  });

  it('tolerates the four optional sheets being present but empty (Cash/Insurance/Checklist/Assumptions)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parse-workbook-test-'));
    const file = join(dir, 'fixture-empty-optional.xlsx');
    await writeFixtureWorkbook(file);

    const { snapshot } = await parseWorkbook(file);

    expect(snapshot.insurance).toEqual([]);
    expect(snapshot.tasks).toEqual([]);
    expect(snapshot.cash.totalCash).toBe(0);
    expect(snapshot.cash.entities).toEqual([]);
    // Assumptions falls back to documented defaults when the sheet has no data rows.
    expect(snapshot.assumptions.activeScenario).toBe('Base');
    expect(snapshot.assumptions.thresholds.balloonAlertMonths).toBe(18);
  });

  it('throws a clear error when a required sheet is missing entirely', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parse-workbook-test-'));
    const file = join(dir, 'fixture-missing-sheet.xlsx');
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Property NOI').addRow([1, PROPERTY_NAME, 'Industrial']);
    // Deliberately omit every other required sheet.
    await wb.xlsx.writeFile(file);

    await expect(parseWorkbook(file)).rejects.toThrow(/Worksheet not found/);
  });

  it('skips Property NOI rows failing each of the three guard conditions independently', async () => {
    // parse.ts:164 -- `if (idx === null || !name || /portfolio total/i.test(name)) continue;`
    // Exercises all three OR-branches with a DISTINCT row per condition, then asserts the exact
    // surviving name set -- not just a count -- so a row skipped for the WRONG reason (or not
    // skipped at all) cannot pass by accidental cancellation.
    const dir = mkdtempSync(join(tmpdir(), 'parse-workbook-test-'));
    const file = join(dir, 'fixture-skip-rows.xlsx');
    const wb = new ExcelJS.Workbook();
    const props = wb.addWorksheet('Property NOI');
    props.addRow([1, PROPERTY_NAME, 'Industrial', 50000, 3, 0.92]); // kept
    props.addRow([null, 'No Index Row', 'Industrial', 1000]); // idx === null -> skipped
    props.addRow([2, '', 'Industrial', 1000]); // !name (empty string) -> skipped
    props.addRow([3, 'Portfolio Total', 'Industrial', 1000]); // portfolio-total regex -> skipped
    wb.addWorksheet('Master Tenant Rent Roll');
    wb.addWorksheet('Loan Index');
    wb.addWorksheet('Cash Balances');
    wb.addWorksheet('Insurance Renewals');
    wb.addWorksheet('Monthly Checklist');
    wb.addWorksheet('Assumptions');
    await wb.xlsx.writeFile(file);

    const { snapshot } = await parseWorkbook(file);
    expect(snapshot.properties.map((p) => p.name)).toEqual([PROPERTY_NAME]);
  });

  it('captures the workbook\'s own "Portfolio Total" row into snapshot.workbookTotals', async () => {
    // The Portfolio Total row is excluded from properties/leases (it isn't a real entity), but its
    // NOI/Value (Property NOI cols 13/10) and Annualized Rent (Master Tenant Rent Roll col 14) must
    // still be captured for reconcile-runtime's cross-check against the derived per-entity sums.
    const dir = mkdtempSync(join(tmpdir(), 'parse-workbook-test-'));
    const file = join(dir, 'fixture-portfolio-total.xlsx');
    const wb = new ExcelJS.Workbook();

    const props = wb.addWorksheet('Property NOI');
    props.addRow([1, PROPERTY_NAME, 'Industrial', 50000, 3, 0.92, new Date('2020-01-01'), 5000000, 1, 5000000, 600000, 200000, 400000]);
    // col10 (value) = 7654321, col13 (noi) = 987654; everything else irrelevant to this test.
    props.addRow([null, 'Portfolio Total', null, null, null, null, null, null, null, 7654321, null, null, 987654]);

    const rentRoll = wb.addWorksheet('Master Tenant Rent Roll');
    rentRoll.addRow([PROPERTY_NAME, 'Fixture Tenant Co', 'Suite 100', 'Fixture Tenant Co', 10000, 8000, 9.6, new Date('2022-01-01'), new Date('2027-01-01'), null, null, 'Active', 96000]);
    // col14 (the workbook's own rent total, one column right of individual rows' col13 annualRent).
    rentRoll.addRow(['Portfolio Total', null, null, null, null, null, null, null, null, null, null, null, null, 555555]);

    wb.addWorksheet('Loan Index');
    wb.addWorksheet('Cash Balances');
    wb.addWorksheet('Insurance Renewals');
    wb.addWorksheet('Monthly Checklist');
    wb.addWorksheet('Assumptions');
    await wb.xlsx.writeFile(file);

    const { snapshot } = await parseWorkbook(file);
    // The total row itself must not leak into the per-entity lists.
    expect(snapshot.properties.map((p) => p.name)).toEqual([PROPERTY_NAME]);
    expect(snapshot.leases).toHaveLength(1);
    expect(snapshot.workbookTotals).toEqual({ noi: 987654, value: 7654321, rent: 555555 });
  });

  it('keeps the FIRST "Portfolio Total" row match, ignoring a second matching row', async () => {
    // Regression guard: a naive last-match-wins capture would let a second banner/footnote row
    // (e.g. a stray note also containing "Portfolio Total") silently clobber an already-captured
    // total with no warning. scripts/reconcile.ts's own find() returns on the FIRST match --
    // parse.ts must agree, not silently disagree with the CI gate it's meant to mirror.
    const dir = mkdtempSync(join(tmpdir(), 'parse-workbook-test-'));
    const file = join(dir, 'fixture-duplicate-total-row.xlsx');
    const wb = new ExcelJS.Workbook();

    const props = wb.addWorksheet('Property NOI');
    props.addRow([1, PROPERTY_NAME, 'Industrial', 50000, 3, 0.92, new Date('2020-01-01'), 5000000, 1, 5000000, 600000, 200000, 400000]);
    props.addRow([null, 'Portfolio Total', null, null, null, null, null, null, null, 111, null, null, 222]); // first match — kept
    props.addRow([null, 'Portfolio Total (footnote)', null, null, null, null, null, null, null, 999, null, null, 888]); // second match — ignored

    const rentRoll = wb.addWorksheet('Master Tenant Rent Roll');
    rentRoll.addRow([PROPERTY_NAME, 'Fixture Tenant Co', 'Suite 100', 'Fixture Tenant Co', 10000, 8000, 9.6, new Date('2022-01-01'), new Date('2027-01-01'), null, null, 'Active', 96000]);
    rentRoll.addRow(['Portfolio Total', null, null, null, null, null, null, null, null, null, null, null, null, 333]); // first — kept
    rentRoll.addRow(['Portfolio Total (footnote)', null, null, null, null, null, null, null, null, null, null, null, null, 777]); // second — ignored

    wb.addWorksheet('Loan Index');
    wb.addWorksheet('Cash Balances');
    wb.addWorksheet('Insurance Renewals');
    wb.addWorksheet('Monthly Checklist');
    wb.addWorksheet('Assumptions');
    await wb.xlsx.writeFile(file);

    const { snapshot } = await parseWorkbook(file);
    expect(snapshot.workbookTotals).toEqual({ noi: 222, value: 111, rent: 333 });
  });

  it('leaves snapshot.workbookTotals all-null when the workbook has no "Portfolio Total" row', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parse-workbook-test-'));
    const file = join(dir, 'fixture-no-total-row.xlsx');
    await writeFixtureWorkbook(file);

    const { snapshot } = await parseWorkbook(file);
    expect(snapshot.workbookTotals).toEqual({ noi: null, value: null, rent: null });
  });
});
