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
    // The id is exactly the slug-derived property+unit+tenant base — no extra row-number suffix
    // appended beyond what those fields naturally produce (the unit label "Suite 100" itself ends
    // in digits, so a bare /-\d+$/ check would false-positive; assert exact equality instead).
    expect(leaseBefore.id).toBe(`${slug(PROPERTY_NAME)}-${slug('Suite 100')}-${slug('Fixture Tenant Co')}`);
  });

  it('attributes a date-quality flag to the FINAL (disambiguated) lease id, not the stale pre-collision base id', async () => {
    // Regression for the flag-misattribution defect: two rows collide on the same base lease id
    // (same property + same Suite/Unit + same tenant -- e.g. a duplicate/split row for the same
    // tenancy; with tenant identity now folded into the id (Defect A fix), a collision requires
    // matching tenant too, not just unit). The SECOND colliding row carries an implausible-year
    // leaseEnd cell (isoOrNull rejects years outside 1990-2100 and raises a data-quality flag using
    // the row's PRE-disambiguation id). Under the pre-fix code, that flag's `entity` stayed the
    // stale base id -- indistinguishable from a flag legitimately belonging to the FIRST lease,
    // which keeps that same base id after disambiguateLeaseIds runs. The fix re-homes each row's
    // flags onto the lease's FINAL id via object-reference correlation, so the flag must land on the
    // second lease's disambiguated "<base>-2" id -- never the bare base id shared by the first lease.
    const dir = mkdtempSync(join(tmpdir(), 'parse-workbook-test-'));
    const file = join(dir, 'fixture-lease-id-collision-flag.xlsx');
    const wb = new ExcelJS.Workbook();

    const props = wb.addWorksheet('Property NOI');
    props.addRow([1, PROPERTY_NAME, 'Industrial', 50000, 3, 0.92]);

    const rentRoll = wb.addWorksheet('Master Tenant Rent Roll');
    // First row: same unit + same tenant, valid leaseEnd -- raises no flag, keeps the base id.
    rentRoll.addRow([
      PROPERTY_NAME, 'Tenant One Co', 'Suite 100', 'Tenant One Co',
      10000, 8000, 9.6, new Date('2022-01-01'), new Date('2027-01-01'),
      null, null, 'Active', 96000,
    ]);
    // Second row: SAME unit ("Suite 100") AND same tenant ("Tenant One Co") -> collides on the
    // pre-dedup base id even with tenant identity folded in; leaseEnd year (1899) is outside
    // isoOrNull's 1990-2100 plausible range -> raises a 'leaseEnd' flag keyed (pre-fix) to the
    // shared base id.
    rentRoll.addRow([
      PROPERTY_NAME, 'Tenant One Co', 'Suite 100', 'Tenant One Co',
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
    const [leaseOne, leaseTwo] = snapshot.leases;

    const baseId = `${slug(PROPERTY_NAME)}-${slug('Suite 100')}-${slug('Tenant One Co')}`;
    // (a) distinct ids: first keeps the base, second gets disambiguated.
    expect(leaseOne!.id).toBe(baseId);
    expect(leaseTwo!.id).toBe(`${baseId}-2`);
    expect(leaseTwo!.id).not.toBe(leaseOne!.id);

    // (b) the leaseEnd flag must be attributed to the SECOND lease's final id -- not the bare
    // base id, and not the first lease's id (which happens to equal the bare base id).
    const leaseEndFlags = flags.filter((f) => f.field === 'leaseEnd');
    expect(leaseEndFlags).toHaveLength(1);
    expect(leaseEndFlags[0]!.entity).toBe(leaseTwo!.id);
    expect(leaseEndFlags[0]!.entity).not.toBe(baseId);
    expect(leaseEndFlags[0]!.entity).not.toBe(leaseOne!.id);
  });

  it('a suite turnover (same property+unit, different tenant) produces a DIFFERENT lease id (REFUTE Defect A)', async () => {
    // The defect: the pre-fix id was `${slug(propertyKey)}-${slug(unit ?? tenantName)}` -- tenant
    // identity was only a fallback for a MISSING unit, and almost every lease has a unit. So a
    // routine suite turnover (Tenant A vacates, Tenant B signs for the identical unit) produced the
    // IDENTICAL id as the old lease, silently re-attaching every overlay entry keyed to that id
    // (tenantArrears, renewalStages, marketRents) onto the new tenant. The fix folds tenant identity
    // (company ?? tenantName, same convention as elsewhere) into the id itself.
    async function writeSingleLeaseWorkbook(path: string, tenant: string): Promise<void> {
      const wb = new ExcelJS.Workbook();
      const props = wb.addWorksheet('Property NOI');
      props.addRow([1, PROPERTY_NAME, 'Industrial', 50000, 3, 0.92]);
      const rentRoll = wb.addWorksheet('Master Tenant Rent Roll');
      rentRoll.addRow([
        PROPERTY_NAME, tenant, 'Suite 100', tenant,
        10000, 8000, 9.6, new Date('2022-01-01'), new Date('2027-01-01'),
        null, null, 'Active', 96000,
      ]);
      wb.addWorksheet('Loan Index');
      wb.addWorksheet('Cash Balances');
      wb.addWorksheet('Insurance Renewals');
      wb.addWorksheet('Monthly Checklist');
      wb.addWorksheet('Assumptions');
      await wb.xlsx.writeFile(path);
    }

    const dir = mkdtempSync(join(tmpdir(), 'parse-workbook-test-'));
    const fileA = join(dir, 'tenant-a.xlsx');
    const fileB = join(dir, 'tenant-b.xlsx');
    await writeSingleLeaseWorkbook(fileA, 'Tenant A Co');
    await writeSingleLeaseWorkbook(fileB, 'Tenant B Co');

    const resultA = await parseWorkbook(fileA);
    const resultB = await parseWorkbook(fileB);

    const leaseA = resultA.snapshot.leases[0]!;
    const leaseB = resultB.snapshot.leases[0]!;

    // Pre-fix, both of these would have been `${slug(PROPERTY_NAME)}-${slug('Suite 100')}` --
    // identical despite being different tenants. Verify the exact scenario is now prevented.
    expect(leaseA.id).not.toBe(leaseB.id);
    expect(leaseA.id).toContain(slug('Tenant A Co'));
    expect(leaseB.id).toContain(slug('Tenant B Co'));
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

  // The live rent roll's per-lease annualised rent is the column headed "Annual Rent" (col 14), the
  // SAME column as the Portfolio Total, and it is net of abated months (monthly x (12 - abated)). The
  // old fixed col-13 read hit the "Notice to Vacate" flag column in the live layout, returned null, and
  // silently fell back to monthly x 12 -- so one abated month on a $4,700/mo lease opened a $4,700 gap
  // against the workbook's own total and the extract refused (2026-10-06). These tests pin the
  // header-driven read: the annual column is found by its header, abatement is honoured, and a sheet
  // with no such header keeps the legacy col-13 read (every other fixture in this file).
  // A formula cell, as the live sheet's Annual Rent (=F*(12-R)) and Portfolio Total (=SUM) really are.
  // NB ExcelJS drops a cached result of 0 on read, and an {error} result reads as unreadable.
  type Cell = string | number | Date | null | ExcelJS.CellFormulaValue;
  async function writeLiveLayoutWorkbook(
    path: string,
    annualHeader: string,
    rows: Cell[][],
    total: Cell,
    // insertCol: one extra column inserted before Annual Rent (annual + total move from col 14 to 15).
    // titleRow: a stray title row ABOVE the header carrying "Annual Rent" in an unrelated column.
    // abatedHeader: label for the Abated Months column (default 'Abated Months').
    // extraAnnualHeader: relabels the 'Esc. Exception' column (col 15) as a SECOND annual-rent header.
    // padRows: filler title-block rows above the header row.
    // totalNextCol: a value in the column immediately RIGHT of the Portfolio Total (the live sheet's
    // "Esc. Exception" column), to prove the total is never adopted from there on the live layout.
    opts: { insertCol?: boolean; titleRow?: boolean; abatedHeader?: string; extraAnnualHeader?: string; padRows?: number; totalNextCol?: number; legendRow?: boolean; headerOverrides?: Record<number, string>; mergeTenantHeader?: boolean; totalsOnTop?: boolean; errorTitleRow?: boolean; topTotalValue?: number; noBottomTotal?: boolean; summaryRowAboveTop?: boolean } = {},
  ): Promise<void> {
    const wb = new ExcelJS.Workbook();
    const props = wb.addWorksheet('Property NOI');
    props.addRow([1, PROPERTY_NAME, 'Industrial', 50000, 3, 0.92, new Date('2020-01-01'), 5000000, 1, 5000000, 600000, 200000, 400000]);
    const rentRoll = wb.addWorksheet('Master Tenant Rent Roll');
    // Insert a column at index 13 (0-based) so the annual column shifts right by one.
    const shift = (r: Cell[]): Cell[] => (opts.insertCol ? [...r.slice(0, 13), null, ...r.slice(13)] : r);
    // A totals-on-top summary line, ABOVE the header and before any lease row.
    if (opts.summaryRowAboveTop) rentRoll.addRow(['KPI', 'Weekly summary', null, null, null, 12345]);
    if (opts.totalsOnTop) rentRoll.addRow(opts.topTotalValue === undefined ? ['Portfolio Total', 'summary line'] : ['Portfolio Total', null, null, null, null, null, null, null, null, null, null, null, null, opts.topTotalValue]);
    // A title row above the header whose "Annual Rent" cell is an error value and whose col 2 holds text.
    if (opts.errorTitleRow) rentRoll.addRow(['Rent Roll', 'Weekly Rent Roll Title', ...Array(11).fill(null), { formula: 'NA()', result: { error: '#N/A' } }]);
    for (let i = 0; i < (opts.padRows ?? 0); i++) rentRoll.addRow([`Title block line ${i}`]);
    if (opts.titleRow) rentRoll.addRow([...Array(19).fill(null), 'Annual Rent']);
    // A legend line above the real header with a bare "Tenant Name" cell (no other header label).
    if (opts.legendRow) rentRoll.addRow(['Key:', 'Tenant Name', 'legal entity on the lease']);
    const headerCells: Cell[] = [
      'Property', 'Tenant Name', 'Unit', 'Company', 'Sq Ft', 'Monthly Rent', 'Rent / SF', 'Lease Start',
      'Lease End', 'Escalation Date', 'Escalation %', 'Status', 'Notice to Vacate', annualHeader,
      opts.extraAnnualHeader ?? 'Esc. Exception', 'Occupancy Class', 'Lease Type', opts.abatedHeader ?? 'Abated Months',
    ];
    for (const [col, label] of Object.entries(opts.headerOverrides ?? {})) headerCells[Number(col) - 1] = label;
    rentRoll.addRow(shift(headerCells));
    // A merged header cell: ExcelJS echoes the master's value into the slave cell (here B:C -> col 3 reads "Tenant Name").
    if (opts.mergeTenantHeader) rentRoll.mergeCells(`B${rentRoll.rowCount}:C${rentRoll.rowCount}`);
    for (const r of rows) rentRoll.addRow(shift(r));
    if (!opts.noBottomTotal) rentRoll.addRow(shift([
      'Portfolio Total', null, null, null, null, null, null, null, null, null, null, null, null, total,
      ...(opts.totalNextCol === undefined ? [] : [opts.totalNextCol]),
    ]));
    for (const n of ['Loan Index', 'Cash Balances', 'Insurance Renewals', 'Monthly Checklist', 'Assumptions']) wb.addWorksheet(n);
    await wb.xlsx.writeFile(path);
  }

  const lease = (
    tenant: string, monthly: number, notice: string | number | null, annual: Cell, abated: Cell,
  ): Cell[] => [
    PROPERTY_NAME, tenant, 'Suite 1', tenant, 10000, monthly, 6, new Date('2022-01-01'), new Date('2028-01-01'),
    null, null, 'Active', notice, annual, null, null, null, abated,
  ];

  it('reads per-lease rent from the "Annual Rent" header column, net of abated months, so the lease sum ties to the Portfolio Total', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parse-workbook-test-'));
    const file = join(dir, 'fixture-live-layout-abatement.xlsx');
    // A: $4,700/mo with ONE abated month -> annualised 51,700 (not 56,400). B: carries a text flag in col 13.
    await writeLiveLayoutWorkbook(file, 'Annual Rent', [
      lease('Abated Tenant Co', 4700, null, 51700, 1),
      lease('Flagged Tenant Co', 2000, 'Yes', 24000, null),
    ], 75700);
    const { snapshot } = await parseWorkbook(file);
    const byName = Object.fromEntries(snapshot.leases.map((l) => [l.tenantName, l.annualRent]));
    expect(byName['Abated Tenant Co']).toBe(51700);
    expect(byName['Flagged Tenant Co']).toBe(24000);
    const sum = snapshot.leases.reduce((s, l) => s + l.annualRent, 0);
    expect(sum).toBe(snapshot.workbookTotals.rent);
  });

  it('accepts the "Annualized Rent" header spelling', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parse-workbook-test-'));
    const file = join(dir, 'fixture-annualized-header.xlsx');
    await writeLiveLayoutWorkbook(file, 'Annualized Rent', [lease('Abated Tenant Co', 4700, null, 51700, 1)], 51700);
    const { snapshot } = await parseWorkbook(file);
    expect(snapshot.leases.map((l) => l.annualRent)).toEqual([51700]);
  });

  it('falls back to monthly x 12 for a lease whose "Annual Rent" cell is blank, and never reads the col-13 flag column as rent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parse-workbook-test-'));
    const file = join(dir, 'fixture-blank-annual.xlsx');
    // 999 sits in the legacy col 13 ("Notice to Vacate" in the live layout). The old fixed-col read
    // would have returned 999; the header-driven read must ignore it and fall back to monthly x 12.
    await writeLiveLayoutWorkbook(file, 'Annual Rent', [lease('Blank Annual Co', 1000, 999, null, null)], 12000);
    const { snapshot } = await parseWorkbook(file);
    expect(snapshot.leases.map((l) => l.annualRent)).toEqual([12000]);
  });

  it('still ties after a column is inserted before "Annual Rent": the Portfolio Total follows the header column', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parse-workbook-test-'));
    const file = join(dir, 'fixture-inserted-column.xlsx');
    await writeLiveLayoutWorkbook(file, 'Annual Rent', [
      lease('Abated Tenant Co', 4700, null, 51700, 1),
      lease('Flagged Tenant Co', 2000, 'Yes', 24000, null),
    ], 75700, { insertCol: true });
    const { snapshot } = await parseWorkbook(file);
    expect(snapshot.leases.map((l) => l.annualRent).sort((a, b) => a - b)).toEqual([24000, 51700]);
    // Previously the total stayed on col 14 (now the inserted blank) and came back null, silently
    // switching off the Σ lease rent vs workbook total tie-out.
    expect(snapshot.workbookTotals.rent).toBe(75700);
  });

  it('flags a header row that has lost its "Annual Rent" column instead of silently using monthly x 12', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parse-workbook-test-'));
    const file = join(dir, 'fixture-renamed-header.xlsx');
    await writeLiveLayoutWorkbook(file, 'Annual Rent (Net)', [lease('Abated Tenant Co', 4700, null, 51700, 1)], 51700);
    const { snapshot, flags } = await parseWorkbook(file);
    expect(flags.some((f) => f.field === 'annualRentHeader' && f.severity === 'warn')).toBe(true);
    // Falls back (legacy col 13 is the flag column -> null -> monthly x 12); the flag is the signal.
    expect(snapshot.leases.map((l) => l.annualRent)).toEqual([56400]);
  });

  it('ignores a stray "Annual Rent" cell above the header row (only the header row counts)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parse-workbook-test-'));
    const file = join(dir, 'fixture-stray-title.xlsx');
    await writeLiveLayoutWorkbook(file, 'Annual Rent', [lease('Abated Tenant Co', 4700, null, 51700, 1)], 51700, { titleRow: true });
    const { snapshot } = await parseWorkbook(file);
    expect(snapshot.leases.map((l) => l.annualRent)).toEqual([51700]);
  });

  it('clamps a negative Annual Rent (Abated Months typo above 12) to 0 with a row flag instead of aborting the parse', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parse-workbook-test-'));
    const file = join(dir, 'fixture-negative-annual.xlsx');
    await writeLiveLayoutWorkbook(file, 'Annual Rent', [lease('Typo Tenant Co', 4700, null, -4700, 13)], -4700);
    const { snapshot, flags } = await parseWorkbook(file); // must not throw on the Lease contract's annualRent >= 0
    expect(snapshot.leases.map((l) => l.annualRent)).toEqual([0]);
    expect(flags.some((f) => f.field === 'annualRent' && /negative Annual Rent/.test(f.issue))).toBe(true);
    // Exactly ONE annualRent flag for the cell: the clamp flag, not a second contradictory zero-rent line.
    expect(flags.filter((f) => f.field === 'annualRent')).toHaveLength(1);
  });

  it('raises ONE specific flag for a $0 Annual Rent the sheet does not explain (blank Abated Months)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parse-workbook-test-'));
    const file = join(dir, 'fixture-zero-unrecorded.xlsx');
    // Annual Rent 0 on an Active lease with a BLANK Abated Months: a zeroed cell is the likely cause. The
    // per-lease check names it (monthly x 12 expected); the generic zero-rent line is suppressed as a duplicate.
    await writeLiveLayoutWorkbook(file, 'Annual Rent', [lease('Zeroed Co', 4700, null, 0, null)], 0);
    const { snapshot, flags } = await parseWorkbook(file);
    expect(snapshot.leases.map((l) => l.annualRent)).toEqual([0]);
    const rowFlags = flags.filter((f) => f.field === 'annualRent');
    expect(rowFlags).toHaveLength(1);
    expect(rowFlags[0]!.issue).toMatch(/≠ monthly rent × \(12 − abated months\)/);
  });

  it('does NOT warn on a fully abated year that the sheet itself records (Abated Months = 12, Annual Rent 0)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parse-workbook-test-'));
    const file = join(dir, 'fixture-fully-abated.xlsx');
    await writeLiveLayoutWorkbook(file, 'Annual Rent', [lease('Free Year Co', 4700, null, 0, 12)], 0);
    const { snapshot, flags } = await parseWorkbook(file);
    expect(snapshot.leases.map((l) => l.annualRent)).toEqual([0]);
    // Explained by the sheet: a standing warn for twelve months would only train people to ignore alerts.
    expect(flags.filter((f) => f.field === 'annualRent')).toEqual([]);
  });

  it('flags a hard-coded Annual Rent that is not monthly x (12 - abated), even though the Portfolio Total (a SUM of the same cells) ties to it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parse-workbook-test-'));
    const file = join(dir, 'fixture-hardcoded-annual.xlsx');
    // 5,640 on a $4,700/mo lease with no abated months: the total sums the same cell, so it ties.
    await writeLiveLayoutWorkbook(file, 'Annual Rent', [lease('Typo Tenant Co', 4700, null, 5640, null)], 5640);
    const { snapshot, flags } = await parseWorkbook(file);
    expect(snapshot.workbookTotals.rent).toBe(5640);
    expect(snapshot.leases.reduce((s, l) => s + l.annualRent, 0)).toBe(5640); // the total tie-out cannot see it
    expect(flags.some((f) => f.field === 'annualRent' && /monthly rent × \(12 − abated months\)/.test(f.issue))).toBe(true);
  });

  it('raises no per-lease annual-rent flag when Annual Rent equals monthly x (12 - abated)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parse-workbook-test-'));
    const file = join(dir, 'fixture-consistent-annual.xlsx');
    await writeLiveLayoutWorkbook(file, 'Annual Rent', [
      lease('Abated Tenant Co', 4700, null, 51700, 1),
      lease('Plain Tenant Co', 2000, 'Yes', 24000, null),
    ], 75700);
    const { flags } = await parseWorkbook(file);
    expect(flags.filter((f) => f.field === 'annualRent')).toEqual([]);
  });

  it('accepts a fractional Abated Months (0.25) with no per-lease flag when Annual Rent follows the formula', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parse-workbook-test-'));
    const file = join(dir, 'fixture-fractional-abatement.xlsx');
    await writeLiveLayoutWorkbook(file, 'Annual Rent', [lease('Quarter Month Co', 4000, null, 47000, 0.25)], 47000);
    const { snapshot, flags } = await parseWorkbook(file);
    expect(snapshot.leases.map((l) => l.annualRent)).toEqual([47000]);
    expect(flags.filter((f) => f.field === 'annualRent')).toEqual([]);
  });

  // --- refute-financial-change wf_d12221a6-d8f findings -----------------------------------------------

  it('does NOT go silent when the Abated Months header is renamed: flags it and falls back to a monthly x 12 check', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parse-workbook-test-'));
    const file = join(dir, 'fixture-no-abated-header.xlsx');
    // 5,640 hard-coded on a $4,700/mo lease; the total sums the same cell so it ties. With the header
    // missing this used to produce ZERO flags (the old col-13 read would have refused via the total).
    await writeLiveLayoutWorkbook(file, 'Annual Rent', [lease('Typo Tenant Co', 4700, null, 5640, null)], 5640, { abatedHeader: 'Free Rent (Mo)' });
    const { flags } = await parseWorkbook(file);
    expect(flags.some((f) => f.field === 'abatedMonthsHeader' && f.severity === 'warn')).toBe(true);
    expect(flags.some((f) => f.field === 'annualRent' && /no Abated Months column to explain it/.test(f.issue))).toBe(true);
  });

  it('skips the per-lease check on Vacant rows (asking rent with a zero Annual Rent is by design)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parse-workbook-test-'));
    const file = join(dir, 'fixture-vacant-row.xlsx');
    const vacant = lease('Vacant Suite', 3000, null, 0, null);
    vacant[11] = 'Vacant';
    await writeLiveLayoutWorkbook(file, 'Annual Rent', [vacant, lease('Plain Tenant Co', 2000, null, 24000, null)], 24000);
    const { flags } = await parseWorkbook(file);
    expect(flags.filter((f) => f.field === 'annualRent')).toEqual([]);
  });

  it('flags a non-numeric Abated Months cell as unreadable instead of coercing it to 0', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parse-workbook-test-'));
    const file = join(dir, 'fixture-text-abated.xlsx');
    // Annual Rent 51,700 is CORRECT for one abated month; reading the text 'one' as 0 would call it a typo.
    await writeLiveLayoutWorkbook(file, 'Annual Rent', [lease('Text Abated Co', 4700, null, 51700, 'one' as unknown as number)], 51700);
    const { flags } = await parseWorkbook(file);
    const rowFlags = flags.filter((f) => f.field === 'annualRent');
    expect(rowFlags).toHaveLength(1);
    expect(rowFlags[0]!.issue).toMatch(/Abated Months cell is not numeric/);
    expect(rowFlags[0]!.issue).not.toMatch(/≠ monthly rent/);
  });

  it('treats a BLANK Abated Months cell as 0 months (no unreadable flag)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parse-workbook-test-'));
    const file = join(dir, 'fixture-blank-abated.xlsx');
    await writeLiveLayoutWorkbook(file, 'Annual Rent', [lease('Plain Tenant Co', 2000, null, 24000, null)], 24000);
    const { flags } = await parseWorkbook(file);
    expect(flags.filter((f) => f.field === 'annualRent')).toEqual([]);
  });

  it('flags two annual-rent header cells (leftmost wins, so column order would change the numbers)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parse-workbook-test-'));
    const file = join(dir, 'fixture-ambiguous-annual-header.xlsx');
    await writeLiveLayoutWorkbook(file, 'Annual Rent', [lease('Plain Tenant Co', 2000, null, 24000, null)], 24000, { extraAnnualHeader: 'Annualized Rent' });
    const { snapshot, flags } = await parseWorkbook(file);
    expect(flags.some((f) => f.field === 'annualRentHeader' && /more than one/.test(f.issue))).toBe(true);
    expect(snapshot.leases.map((l) => l.annualRent)).toEqual([24000]);
  });

  it('still finds the header when 20 title rows sit above it (scan is not capped at 15 rows)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parse-workbook-test-'));
    const file = join(dir, 'fixture-header-below-row-15.xlsx');
    await writeLiveLayoutWorkbook(file, 'Annual Rent', [lease('Abated Tenant Co', 4700, null, 51700, 1)], 51700, { padRows: 20 });
    const { snapshot } = await parseWorkbook(file);
    expect(snapshot.leases.map((l) => l.annualRent)).toEqual([51700]);
  });

  it('reports a systematic sub-$1 overstatement once, even though each lease is inside the per-lease tolerance', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parse-workbook-test-'));
    const file = join(dir, 'fixture-sub-dollar-residuals.xlsx');
    // 20 leases at $1,000/mo with Annual Rent 12,000.90 each: $0.90 over each (inside $1), $18 together.
    const rows = Array.from({ length: 20 }, (_, i) => lease(`Rounded Co ${i}`, 1000, null, 12000.9, null));
    await writeLiveLayoutWorkbook(file, 'Annual Rent', rows, 240018);
    const { flags } = await parseWorkbook(file);
    const annualFlags = flags.filter((f) => f.field === 'annualRent');
    expect(annualFlags).toHaveLength(1);
    expect(annualFlags[0]!.issue).toMatch(/off by \$18\.00/);
  });

  it('reads a pre-2026-10 header layout whose Portfolio Total sits one column right of Annual Rent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parse-workbook-test-'));
    const file = join(dir, 'fixture-legacy-header-total-right.xlsx');
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Property NOI').addRow([1, PROPERTY_NAME, 'Industrial', 50000, 3, 0.92, new Date('2020-01-01'), 5000000, 1, 5000000, 600000, 200000, 400000]);
    const rr = wb.addWorksheet('Master Tenant Rent Roll');
    rr.addRow(['Property', 'Tenant Name', 'Unit', 'Company', 'Sq Ft', 'Monthly Rent', 'Rent / SF', 'Lease Start', 'Lease End', 'Escalation Date', 'Escalation %', 'Status', 'Annual Rent']);
    rr.addRow([PROPERTY_NAME, 'Fixture Tenant Co', 'Suite 100', 'Fixture Tenant Co', 10000, 8000, 9.6, new Date('2022-01-01'), new Date('2027-01-01'), null, null, 'Active', 96000]);
    rr.addRow(['Portfolio Total', null, null, null, null, null, null, null, null, null, null, null, null, 96000]); // total at col 14
    for (const n of ['Loan Index', 'Cash Balances', 'Insurance Renewals', 'Monthly Checklist', 'Assumptions']) wb.addWorksheet(n);
    await wb.xlsx.writeFile(file);
    const { snapshot, flags } = await parseWorkbook(file);
    expect(snapshot.leases.map((l) => l.annualRent)).toEqual([96000]);
    expect(snapshot.workbookTotals.rent).toBe(96000);
    expect(flags.some((f) => f.field === 'workbookRentTotal')).toBe(false);
    // That legacy header layout never had an Abated Months column to lose: no warning on archived copies.
    expect(flags.some((f) => f.field === 'abatedMonthsHeader')).toBe(false);
  });

  // --- formula cells: refute round 2 (wf_e55d18e2-75b). The live Annual Rent is the FORMULA F x (12 - R).
  const FORMULA = 'F2*(12-R2)';

  it('derives a fully abated lease (Annual Rent formula, cached 0 dropped by ExcelJS) as 0, not monthly x 12', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parse-workbook-test-'));
    const file = join(dir, 'fixture-formula-zero-annual.xlsx');
    await writeLiveLayoutWorkbook(file, 'Annual Rent', [
      lease('Free Year Co', 4700, null, { formula: FORMULA, result: 0 }, 12),
    ], { formula: 'SUM(N2:N2)', result: 0 });
    const { snapshot, flags } = await parseWorkbook(file);
    // Before: the dropped 0 read as blank and the lease fell back to 56,400 (a year of rent overstated).
    expect(snapshot.leases.map((l) => l.annualRent)).toEqual([0]);
    expect(flags.filter((f) => f.field === 'annualRent')).toEqual([]); // 12 recorded abated months explain the 0
    expect(flags.some((f) => /no cached result/.test(f.issue))).toBe(false); // a dropped 0 is benign: not counted
  });

  it('derives from monthly x (12 - abated) when the Annual Rent formula is an ERROR, and flags the cell', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parse-workbook-test-'));
    const file = join(dir, 'fixture-formula-error-annual.xlsx');
    await writeLiveLayoutWorkbook(file, 'Annual Rent', [
      lease('Error Cell Co', 4700, null, { formula: FORMULA, result: { error: '#VALUE!' } }, 1),
    ], { formula: 'SUM(N2:N2)', result: { error: '#VALUE!' } });
    const { snapshot, flags } = await parseWorkbook(file);
    expect(snapshot.leases.map((l) => l.annualRent)).toEqual([51700]); // not 56,400
    expect(flags.some((f) => f.field === 'annualRent' && /Annual Rent cell is not numeric/.test(f.issue))).toBe(true);
    expect(snapshot.workbookTotals.rent).toBeNull();
    expect(flags.some((f) => f.field === 'workbookRentTotal')).toBe(true);
  });

  it('falls back to monthly x 12 and says so when Annual Rent is an error and Abated Months is a dash (blank) or real text', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parse-workbook-test-'));
    const file = join(dir, 'fixture-error-and-text.xlsx');
    await writeLiveLayoutWorkbook(file, 'Annual Rent', [
      lease('Dash Co', 4700, null, { formula: FORMULA, result: { error: '#VALUE!' } }, '-' as unknown as number),
    ], { formula: 'SUM(N2:N2)', result: { error: '#VALUE!' } });
    // '-' is a dash placeholder = blank (0 months), so the error cell derives to monthly x 12 here.
    const { snapshot, flags } = await parseWorkbook(file);
    expect(snapshot.leases.map((l) => l.annualRent)).toEqual([56400]);
    expect(flags.some((f) => f.field === 'annualRent' && /Annual Rent cell is not numeric/.test(f.issue))).toBe(true);
    // Genuine text in Abated Months is unreadable: no derivation possible, still flagged.
    const file2 = join(dir, 'fixture-error-and-real-text.xlsx');
    await writeLiveLayoutWorkbook(file2, 'Annual Rent', [
      lease('Text Co', 4700, null, { formula: FORMULA, result: { error: '#VALUE!' } }, 'n/a' as unknown as number),
    ], { formula: 'SUM(N2:N2)', result: { error: '#VALUE!' } });
    const r2 = await parseWorkbook(file2);
    expect(r2.snapshot.leases.map((l) => l.annualRent)).toEqual([56400]);
    expect(r2.flags.some((f) => f.field === 'annualRent' && /using monthly rent × 12/.test(f.issue))).toBe(true);
  });

  it('counts an uncalculated non-zero Annual Rent formula once and derives it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parse-workbook-test-'));
    const file = join(dir, 'fixture-uncached-annual.xlsx');
    await writeLiveLayoutWorkbook(file, 'Annual Rent', [
      lease('Uncached Co', 4700, null, { formula: FORMULA } as ExcelJS.CellFormulaValue, 1),
      lease('Uncached Two Co', 2000, null, { formula: FORMULA } as ExcelJS.CellFormulaValue, null),
    ], { formula: 'SUM(N2:N3)' } as ExcelJS.CellFormulaValue);
    const { snapshot, flags } = await parseWorkbook(file);
    expect(snapshot.leases.map((l) => l.annualRent).sort((a, b) => a - b)).toEqual([24000, 51700]);
    expect(flags.filter((f) => /no cached result/.test(f.issue))).toHaveLength(1);
    expect(flags.find((f) => /no cached result/.test(f.issue))!.issue).toMatch(/^2 lease row/);
  });

  it('reads an Abated Months FORMULA (cached 0 dropped, or empty-string result) and a dash as blank = 0, with no flag', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parse-workbook-test-'));
    const file = join(dir, 'fixture-formula-abated-blank.xlsx');
    await writeLiveLayoutWorkbook(file, 'Annual Rent', [
      lease('Zero Formula Co', 2000, null, 24000, { formula: '0', result: 0 }),
      lease('Empty Result Co', 2000, null, 24000, { formula: 'IF(1=1,"","")', result: '' }),
      lease('Dash Co', 2000, null, 24000, '—'),
    ], 72000);
    const { flags } = await parseWorkbook(file);
    expect(flags.filter((f) => f.field === 'annualRent')).toEqual([]);
  });

  it('still flags a real mismatch when Abated Months is a formula with a dropped 0 (detection is preserved)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parse-workbook-test-'));
    const file = join(dir, 'fixture-formula-abated-mismatch.xlsx');
    // Abated Months reads 0 (dropped), but Annual Rent is 51,700 (one month abated): the mismatch is named.
    await writeLiveLayoutWorkbook(file, 'Annual Rent', [lease('Mismatch Co', 4700, null, 51700, { formula: '0', result: 0 })], 51700);
    const { flags } = await parseWorkbook(file);
    expect(flags.some((f) => f.field === 'annualRent' && /≠ monthly rent/.test(f.issue))).toBe(true);
  });

  it('does not adopt the Esc. Exception column as the Portfolio Total on the live layout when the total cell is unreadable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parse-workbook-test-'));
    const file = join(dir, 'fixture-no-total-adoption.xlsx');
    await writeLiveLayoutWorkbook(file, 'Annual Rent', [lease('Plain Tenant Co', 2000, null, 24000, null)],
      { formula: 'SUM(N2:N2)', result: { error: '#VALUE!' } }, { totalNextCol: 3 });
    const { snapshot, flags } = await parseWorkbook(file);
    expect(snapshot.workbookTotals.rent).toBeNull(); // not 3
    expect(flags.some((f) => f.field === 'workbookRentTotal')).toBe(true);
  });

  it('skips the per-lease check on rows whose raw status says vacant, and on an Expired row at $0', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parse-workbook-test-'));
    const file = join(dir, 'fixture-status-gates.xlsx');
    const vacantExpired = lease('Vacant Expired Co', 3000, null, 0, null); vacantExpired[11] = 'Vacant (Expired)';
    const vacantPlain = lease('Vacant Plain Co', 3000, null, 0, null); vacantPlain[11] = 'Vacant';
    const expiredZero = lease('Expired Zero Co', 5000, null, 0, null); expiredZero[11] = 'Expired';
    await writeLiveLayoutWorkbook(file, 'Annual Rent', [vacantExpired, vacantPlain, expiredZero], 0);
    const { flags } = await parseWorkbook(file);
    expect(flags.filter((f) => f.field === 'annualRent')).toEqual([]);
  });

  it('flags a $0 Annual Rent on a BLANK or unrecognised status (MTM, Holdover) instead of excusing it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parse-workbook-test-'));
    const file = join(dir, 'fixture-zero-unknown-status.xlsx');
    const blank = lease('Blank Status Co', 5000, null, 0, null); blank[11] = '';
    const mtm = lease('MTM Co', 5000, null, 0, null); mtm[11] = 'MTM';
    const holdover = lease('Holdover Co', 5000, null, 0, null); holdover[11] = 'Holdover';
    await writeLiveLayoutWorkbook(file, 'Annual Rent', [blank, mtm, holdover], 0);
    const { flags } = await parseWorkbook(file);
    // The aggregate guard is range-based and cannot see these; the per-lease check must.
    expect(flags.filter((f) => f.field === 'annualRent')).toHaveLength(3);
  });

  it('checks a headerless LEGACY layout per lease too (a hard-coded partial Annual Rent is not silent)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parse-workbook-test-'));
    const file = join(dir, 'fixture-legacy-partial-annual.xlsx');
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Property NOI').addRow([1, PROPERTY_NAME, 'Industrial', 50000, 3, 0.92, new Date('2020-01-01'), 5000000, 1, 5000000, 600000, 200000, 400000]);
    const rr = wb.addWorksheet('Master Tenant Rent Roll');
    // No header row. Annual Rent is col 13: 30,000 hard-coded on a $5,000/mo lease (should be 60,000).
    rr.addRow([PROPERTY_NAME, 'Partial Co', 'Suite 1', 'Partial Co', 10000, 5000, 6, new Date('2022-01-01'), new Date('2028-01-01'), null, null, 'Active', 30000]);
    rr.addRow([PROPERTY_NAME, 'Plain Co', 'Suite 2', 'Plain Co', 10000, 2000, 6, new Date('2022-01-01'), new Date('2028-01-01'), null, null, 'Active', 24000]);
    rr.addRow(['Portfolio Total', null, null, null, null, null, null, null, null, null, null, null, null, 54000]);
    for (const n of ['Loan Index', 'Cash Balances', 'Insurance Renewals', 'Monthly Checklist', 'Assumptions']) wb.addWorksheet(n);
    await wb.xlsx.writeFile(file);
    const { flags } = await parseWorkbook(file);
    expect(flags.some((f) => f.field === 'annualRent' && /≠ monthly rent/.test(f.issue))).toBe(true);
    expect(flags.filter((f) => f.field === 'annualRent')).toHaveLength(1); // only the partial one
  });

  it('derives a blank Annual Rent on a row that records abated months, and says so', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parse-workbook-test-'));
    const file = join(dir, 'fixture-blank-annual-with-abatement.xlsx');
    await writeLiveLayoutWorkbook(file, 'Annual Rent', [lease('Deleted Formula Co', 4700, null, null, 1)], 0);
    const { snapshot, flags } = await parseWorkbook(file);
    expect(snapshot.leases.map((l) => l.annualRent)).toEqual([51700]); // not 56,400
    expect(flags.some((f) => f.field === 'annualRent' && /Annual Rent cell is blank on a row with 1 abated month/.test(f.issue))).toBe(true);
  });

  it('flags an uncomputable Annual Rent formula together with an unreadable Abated Months cell (no silent fallback)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parse-workbook-test-'));
    const file = join(dir, 'fixture-uncached-and-text-abated.xlsx');
    await writeLiveLayoutWorkbook(file, 'Annual Rent', [
      lease('Both Bad Co', 4700, null, { formula: 'F2*12' } as ExcelJS.CellFormulaValue, 'n/a' as unknown as number),
    ], 56400);
    const { snapshot, flags } = await parseWorkbook(file);
    expect(snapshot.leases.map((l) => l.annualRent)).toEqual([56400]);
    expect(flags.some((f) => f.field === 'annualRent' && /no cached result AND the Abated Months cell is not numeric/.test(f.issue))).toBe(true);
  });

  it('derives 0 (not asking rent x 12) for a vacant row whose Annual Rent formula evaluates to 0', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parse-workbook-test-'));
    const file = join(dir, 'fixture-vacant-if-zero.xlsx');
    const vacant = lease('Vacant Suite', 3000, null, { formula: 'IF(L2="Vacant",0,F2*(12-R2))', result: 0 }, null);
    vacant[11] = 'Vacant';
    await writeLiveLayoutWorkbook(file, 'Annual Rent', [vacant], 0);
    const { snapshot } = await parseWorkbook(file);
    expect(snapshot.leases.map((l) => l.annualRent)).toEqual([0]); // not 36,000
  });

  it('names an out-of-range Abated Months even when Annual Rent is a derived (uncached) value', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parse-workbook-test-'));
    const file = join(dir, 'fixture-derived-out-of-range.xlsx');
    await writeLiveLayoutWorkbook(file, 'Annual Rent', [
      lease('Derived Neg Co', 4700, null, { formula: FORMULA } as ExcelJS.CellFormulaValue, -1),
    ], { formula: 'SUM(N2:N2)' } as ExcelJS.CellFormulaValue);
    const { flags } = await parseWorkbook(file);
    expect(flags.some((f) => f.field === 'annualRent' && /outside 0–12/.test(f.issue))).toBe(true);
  });

  it('is not hijacked by a legend row above the header that carries a bare "Tenant Name" cell', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parse-workbook-test-'));
    const file = join(dir, 'fixture-legend-row.xlsx');
    await writeLiveLayoutWorkbook(file, 'Annual Rent', [lease('Abated Tenant Co', 4700, null, 51700, 1)], 51700, { legendRow: true });
    const { snapshot, flags } = await parseWorkbook(file);
    expect(snapshot.leases.map((l) => l.annualRent)).toEqual([51700]);
    expect(flags.some((f) => f.field === 'annualRentHeader')).toBe(false);
  });

  it('drops an IF-blank placeholder twin and never lets it take the real lease\'s id (Monthly Rent keeps the literal read)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parse-workbook-test-'));
    const file = join(dir, 'fixture-if-blank-twin.xlsx');
    const real = lease('Dup Co', 5000, null, 60000, null);
    // Same property / unit / tenant, Monthly Rent and Annual Rent both IF-blank formulas (cached '' is dropped
    // on read). It must not be retained as a $0 lease, or it would rank first in the id tie-break and the real
    // lease would be renamed '-2', detaching its arrears / renewal overlay.
    const twin = lease('Dup Co', 0, null, { formula: 'IF(F3="","",F3*(12-R3))', result: '' }, null);
    twin[5] = { formula: 'IF(E3="","",E3*G3/12)', result: '' };
    twin[11] = '';
    await writeLiveLayoutWorkbook(file, 'Annual Rent', [real, twin], 60000);
    const { snapshot } = await parseWorkbook(file);
    expect(snapshot.leases).toHaveLength(1);
    expect(snapshot.leases[0]!.monthlyRent).toBe(5000);
    expect(snapshot.leases[0]!.id).not.toMatch(/-2$/);
  });

  it('reports a row it skips because Monthly Rent is blank and Annual Rent is an error (never "no lease and no flag")', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parse-workbook-test-'));
    const file = join(dir, 'fixture-skipped-error-row.xlsx');
    const noRent = lease('Error Row Co', 0, null, { formula: FORMULA, result: { error: '#VALUE!' } }, null);
    noRent[5] = null;
    await writeLiveLayoutWorkbook(file, 'Annual Rent', [noRent, lease('Plain Co', 2000, null, 24000, null)], 24000);
    const { snapshot, flags } = await parseWorkbook(file);
    expect(snapshot.leases.map((l) => l.tenantName)).toEqual(['Plain Co']);
    expect(flags.some((f) => /row skipped/.test(f.issue) && /Error Row Co/.test(f.issue))).toBe(true);
  });

  const layoutFlags = <T extends { field: string }>(flags: T[]): T[] => flags.filter((f) => f.field === 'rentRollLayout');
  const parseLive = async (name: string, opts: Parameters<typeof writeLiveLayoutWorkbook>[4], row: Cell[] = lease('Plain Co', 2000, null, 24000, null), total: Cell = 24000) => {
    const dir = mkdtempSync(join(tmpdir(), 'parse-workbook-test-'));
    const file = join(dir, `${name}.xlsx`);
    await writeLiveLayoutWorkbook(file, 'Annual Rent', [row], total, opts);
    return parseWorkbook(file);
  };

  it('WARNS (visibility, never a refusal) when a column is inserted left of Monthly Rent', async () => {
    // Header labels shift: col 6 reads "Sq Ft" and col 7 reads "Monthly Rent". The header-driven Annual Rent
    // still ties to the total, but the fixed-index Monthly Rent / Status reads are now on the wrong data.
    const { flags } = await parseLive('fixture-shifted-positional-columns', { headerOverrides: { 5: 'Inserted Column', 6: 'Sq Ft', 7: 'Monthly Rent' } });
    const layout = layoutFlags(flags);
    expect(layout).toHaveLength(1);
    // 'warn', not 'error': an error refuses only the CLI writers and would take down every refresh on a cosmetic edit.
    expect(layout[0]!.severity).toBe('warn');
    expect(layout[0]!.issue).toMatch(/column 6 is "Sq Ft", expected "Monthly Rent"/);
  });

  it('raises no layout flag for the live header', async () => {
    const { flags } = await parseLive('fixture-live-header-no-layout-flag', {});
    expect(layoutFlags(flags)).toEqual([]);
  });

  it('flags a BLANK header cell in a positional column (an unlabelled column inserted ahead of Status)', async () => {
    // Status moves to col 13 and col 12 is blank: every lease would read as Unknown.
    const { flags } = await parseLive('fixture-unlabelled-inserted-column', { headerOverrides: { 12: '', 13: 'Status' } });
    expect(layoutFlags(flags)[0]!.issue).toMatch(/column 12 is blank, expected "Status"/);
  });

  it('flags a relabelled Rent / SF (col 7) and Escalation columns, which are also read by position', async () => {
    const { flags } = await parseLive('fixture-relabelled-rent-psf', { headerOverrides: { 7: 'Annual Rent / SF', 11: 'Escalation Months' } });
    const issue = layoutFlags(flags)[0]!.issue;
    expect(issue).toMatch(/column 7 is "Annual Rent \/ SF", expected "Rent \/ SF"/);
    expect(issue).toMatch(/column 11 is "Escalation Months", expected "Escalation %"/);
  });

  it('does NOT flag cosmetic header edits: Alt+Enter line break, NBSP, "Sq. Ft.", trailing colon, case, extra spaces', async () => {
    const variants: Record<number, string>[] = [
      { 6: 'Monthly\nRent' },
      { 5: 'Sq Ft' },
      { 5: 'Sq. Ft.' },
      { 12: 'Status:' },
      { 3: 'UNIT', 4: 'company  ', 8: 'Lease   Start' },
    ];
    for (const [i, headerOverrides] of variants.entries()) {
      const { flags } = await parseLive(`fixture-cosmetic-header-${i}`, { headerOverrides });
      expect(layoutFlags(flags)).toEqual([]);
    }
  });

  it('does NOT flag a merged header cell (the slave cell echoes the master label)', async () => {
    const { flags } = await parseLive('fixture-merged-header', { mergeTenantHeader: true });
    expect(layoutFlags(flags)).toEqual([]);
  });

  it('still finds the header when a "Portfolio Total" summary line sits ABOVE it (totals-on-top)', async () => {
    const { snapshot, flags } = await parseLive('fixture-totals-on-top', { totalsOnTop: true }, lease('Abated Tenant Co', 4700, null, 51700, 1), 51700);
    expect(snapshot.leases.map((l) => l.annualRent)).toEqual([51700]); // header-driven, abatement honoured
    expect(flags.some((f) => f.field === 'annualRentHeader')).toBe(false);
    // The real (bottom) total is captured, not the numberless summary line above the header.
    expect(snapshot.workbookTotals.rent).toBe(51700);
    expect(flags.some((f) => f.field === 'workbookRentTotal')).toBe(false);
  });

  it('totals-on-top with a NUMERIC total and no bottom total: the top total is adopted, so the tie-out still runs', async () => {
    const { snapshot, flags } = await parseLive('fixture-top-total-only', { totalsOnTop: true, topTotalValue: 51700, noBottomTotal: true }, lease('Abated Tenant Co', 4700, null, 51700, 1));
    expect(snapshot.workbookTotals.rent).toBe(51700);
    expect(flags.some((f) => f.field === 'workbookRentTotal')).toBe(false);
  });

  it('totals-on-top with a numberless total and no bottom total: the disabled tie-out is flagged, never silent', async () => {
    const { snapshot, flags } = await parseLive('fixture-top-total-numberless', { totalsOnTop: true, noBottomTotal: true }, lease('Abated Tenant Co', 4700, null, 51700, 1));
    expect(snapshot.workbookTotals.rent).toBeNull();
    expect(flags.some((f) => f.field === 'workbookRentTotal')).toBe(true);
  });

  it('a KPI summary row above a totals-on-top line does not push the parse onto the legacy col-13 read', async () => {
    const { snapshot, flags } = await parseLive('fixture-kpi-then-total', { totalsOnTop: true, summaryRowAboveTop: true }, lease('Abated Tenant Co', 4700, null, 51700, 1), 51700);
    // Header-driven read held: the abated lease is net of abatement (the legacy col-13 read would give 56,400).
    expect(snapshot.leases.find((l) => l.tenantName === 'Abated Tenant Co')?.annualRent).toBe(51700);
    expect(flags.some((f) => f.field === 'annualRentHeader')).toBe(false);
  });

  it('totals-on-top: a wrong bottom total is still captured, so checkSnapshot can refuse it', async () => {
    const { snapshot } = await parseLive('fixture-totals-on-top-wrong', { totalsOnTop: true }, lease('Abated Tenant Co', 4700, null, 51700, 1), 999999);
    expect(snapshot.workbookTotals.rent).toBe(999999);
  });

  it('a Vacant row with a BLANK Annual Rent is 0, not asking rent x 12', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parse-workbook-test-'));
    const file = join(dir, 'fixture-vacant-blank-annual.xlsx');
    const vacant = lease('Vacant Blank', 2000, null, null, null);
    vacant[11] = 'Vacant';
    await writeLiveLayoutWorkbook(file, 'Annual Rent', [lease('Real Tenant Co', 1000, null, 12000, null), vacant], 12000);
    const { snapshot } = await parseWorkbook(file);
    expect(snapshot.leases.find((l) => l.tenantName === 'Vacant Blank')?.annualRent).toBe(0);
    expect(snapshot.leases.reduce((s, l) => s + l.annualRent, 0)).toBe(12000);
  });

  it('does not report a "row skipped" warn for a title row ABOVE the header', async () => {
    const { flags } = await parseLive('fixture-error-title-row', { errorTitleRow: true });
    expect(flags.some((f) => /row skipped/.test(f.issue))).toBe(false);
  });

  it('applies the tenant-name vacancy signal only when Status is blank: a real tenant named "Vacant ..." keeps its checks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parse-workbook-test-'));
    const file = join(dir, 'fixture-vacant-named-tenant.xlsx');
    // Active tenant "Vacant Land LLC" with a hard-coded wrong Annual Rent: must still be flagged.
    await writeLiveLayoutWorkbook(file, 'Annual Rent', [lease('Vacant Land LLC', 4700, null, 5640, null)], 5640);
    const { flags } = await parseWorkbook(file);
    expect(flags.some((f) => f.field === 'annualRent' && /≠ monthly rent/.test(f.issue))).toBe(true);
  });

  it('adopts the one-column-right total ONLY on a genuinely legacy layout (no Abated Months header)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parse-workbook-test-'));
    const file = join(dir, 'fixture-annual13-with-abated-header.xlsx');
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Property NOI').addRow([1, PROPERTY_NAME, 'Industrial', 50000, 3, 0.92, new Date('2020-01-01'), 5000000, 1, 5000000, 600000, 200000, 400000]);
    const rr = wb.addWorksheet('Master Tenant Rent Roll');
    // Annual Rent at col 13 BUT an Abated Months header at col 15: the current layout, not the legacy one.
    rr.addRow(['Property', 'Tenant Name', 'Unit', 'Company', 'Sq Ft', 'Monthly Rent', 'Rent / SF', 'Lease Start', 'Lease End', 'Escalation Date', 'Escalation %', 'Status', 'Annual Rent', 'Other', 'Abated Months']);
    rr.addRow([PROPERTY_NAME, 'Plain Co', 'Suite 1', 'Plain Co', 10000, 2000, 6, new Date('2022-01-01'), new Date('2028-01-01'), null, null, 'Active', 24000, null, null]);
    rr.addRow(['Portfolio Total', null, null, null, null, null, null, null, null, null, null, null, null, 7]); // 7 at col 14 is unrelated
    for (const n of ['Loan Index', 'Cash Balances', 'Insurance Renewals', 'Monthly Checklist', 'Assumptions']) wb.addWorksheet(n);
    await wb.xlsx.writeFile(file);
    const { snapshot, flags } = await parseWorkbook(file);
    expect(snapshot.workbookTotals.rent).toBeNull(); // not 7
    expect(flags.some((f) => f.field === 'workbookRentTotal')).toBe(true);
  });

  it('prefers col 14 for the Portfolio Total on the legacy header layout, even with a stray number in col 13', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parse-workbook-test-'));
    const file = join(dir, 'fixture-legacy-stray-col13.xlsx');
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Property NOI').addRow([1, PROPERTY_NAME, 'Industrial', 50000, 3, 0.92, new Date('2020-01-01'), 5000000, 1, 5000000, 600000, 200000, 400000]);
    const rr = wb.addWorksheet('Master Tenant Rent Roll');
    rr.addRow(['Property', 'Tenant Name', 'Unit', 'Company', 'Sq Ft', 'Monthly Rent', 'Rent / SF', 'Lease Start', 'Lease End', 'Escalation Date', 'Escalation %', 'Status', 'Annual Rent']);
    rr.addRow([PROPERTY_NAME, 'Fixture Tenant Co', 'Suite 100', 'Fixture Tenant Co', 10000, 8000, 9.6, new Date('2022-01-01'), new Date('2027-01-01'), null, null, 'Active', 96000]);
    rr.addRow(['Portfolio Total', null, null, null, null, null, null, null, null, null, null, null, 1, 96000]); // stray 1 at col 13
    for (const n of ['Loan Index', 'Cash Balances', 'Insurance Renewals', 'Monthly Checklist', 'Assumptions']) wb.addWorksheet(n);
    await wb.xlsx.writeFile(file);
    const { snapshot } = await parseWorkbook(file);
    expect(snapshot.workbookTotals.rent).toBe(96000); // not 1
  });

  it('is not hijacked by a derived block\'s header row that sits BELOW the Portfolio Total on a headerless sheet', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parse-workbook-test-'));
    const file = join(dir, 'fixture-headerless-retitled-block.xlsx');
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Property NOI').addRow([1, PROPERTY_NAME, 'Industrial', 50000, 3, 0.92, new Date('2020-01-01'), 5000000, 1, 5000000, 600000, 200000, 400000]);
    const rr = wb.addWorksheet('Master Tenant Rent Roll');
    rr.addRow([PROPERTY_NAME, 'Partial Co', 'Suite 1', 'Partial Co', 10000, 5000, 6, new Date('2022-01-01'), new Date('2028-01-01'), null, null, 'Active', 60000]);
    rr.addRow([PROPERTY_NAME, 'Plain Co', 'Suite 2', 'Plain Co', 10000, 2000, 6, new Date('2022-01-01'), new Date('2028-01-01'), null, null, 'Active', 24000]);
    rr.addRow(['Portfolio Total', null, null, null, null, null, null, null, null, null, null, null, null, 84000]);
    rr.addRow([]);
    rr.addRow(['ROLL-OFF SCHEDULE (RETITLED)']);
    rr.addRow(['Move-Out Date', 'Property', 'Unit', 'Tenant Name', 'Company', 'SF', 'Monthly Rent', 'Annual Rent']);
    for (const n of ['Loan Index', 'Cash Balances', 'Insurance Renewals', 'Monthly Checklist', 'Assumptions']) wb.addWorksheet(n);
    await wb.xlsx.writeFile(file);
    const { snapshot, flags } = await parseWorkbook(file);
    expect(snapshot.leases.map((l) => l.annualRent).sort((a, b) => a - b)).toEqual([24000, 60000]); // literal col-13 reads
    expect(snapshot.workbookTotals.rent).toBe(84000);
    expect(flags.filter((f) => ['annualRentHeader', 'abatedMonthsHeader', 'rentRollLayout'].includes(f.field))).toEqual([]);
  });

  it('derives 0 for a vacant placeholder identified only by its tenant name (blank Status) with an IF-zeroed Annual Rent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parse-workbook-test-'));
    const file = join(dir, 'fixture-vacant-by-name.xlsx');
    const vacant = lease('VACANT', 3000, null, { formula: 'IF(B2="VACANT",0,F2*(12-R2))', result: 0 }, null);
    vacant[11] = '';
    await writeLiveLayoutWorkbook(file, 'Annual Rent', [vacant], 0);
    const { snapshot } = await parseWorkbook(file);
    expect(snapshot.leases.map((l) => l.annualRent)).toEqual([0]); // not 36,000
  });

  it('derives 0 for a vacant row whose blank Annual Rent sits next to a recorded abatement', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parse-workbook-test-'));
    const file = join(dir, 'fixture-vacant-blank-annual-abated.xlsx');
    const vacant = lease('Vacant Suite', 3000, null, null, 1);
    vacant[11] = 'Vacant';
    await writeLiveLayoutWorkbook(file, 'Annual Rent', [vacant], 0);
    const { snapshot } = await parseWorkbook(file);
    expect(snapshot.leases.map((l) => l.annualRent)).toEqual([0]); // not 33,000 asking rent as income
  });

  it('raises exactly one annualRent flag for an Active lease at $0 with monthly rent (no duplicate zero-rent line)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parse-workbook-test-'));
    const file = join(dir, 'fixture-active-zero-no-duplicate.xlsx');
    await writeLiveLayoutWorkbook(file, 'Annual Rent', [lease('Active Zero Co', 3000, null, 0, null)], 0);
    const { flags } = await parseWorkbook(file);
    expect(flags.filter((f) => f.field === 'annualRent')).toHaveLength(1);
  });

  it('names an Abated Months value outside 0-12 on its row', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parse-workbook-test-'));
    const file = join(dir, 'fixture-abated-out-of-range.xlsx');
    // -1 abated months with Annual Rent 61,100 (= 4,700 x 13): internally consistent but impossible.
    await writeLiveLayoutWorkbook(file, 'Annual Rent', [lease('Negative Abated Co', 4700, null, 61100, -1)], 61100);
    const { flags } = await parseWorkbook(file);
    expect(flags.some((f) => f.field === 'annualRent' && /outside 0–12/.test(f.issue))).toBe(true);
  });

  it('finds the header even with 45 title rows above it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parse-workbook-test-'));
    const file = join(dir, 'fixture-header-below-row-40.xlsx');
    await writeLiveLayoutWorkbook(file, 'Annual Rent', [lease('Abated Tenant Co', 4700, null, 51700, 1)], 51700, { padRows: 45 });
    const { snapshot } = await parseWorkbook(file);
    expect(snapshot.leases.map((l) => l.annualRent)).toEqual([51700]);
  });

  it('flags a Portfolio Total row that has no numeric total (the tie-out would otherwise be silently disabled)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parse-workbook-test-'));
    const file = join(dir, 'fixture-null-total.xlsx');
    await writeLiveLayoutWorkbook(file, 'Annual Rent', [lease('Abated Tenant Co', 4700, null, 51700, 1)], null);
    const { snapshot, flags } = await parseWorkbook(file);
    expect(snapshot.workbookTotals.rent).toBeNull();
    expect(flags.some((f) => f.field === 'workbookRentTotal' && f.severity === 'warn')).toBe(true);
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

  // Regression: 2026-08-03. The live rent roll gained a trailing "VACANCY & UPCOMING AVAILABILITY"
  // summary block whose column 1 is a Move-Out DATE (not a property key) and whose columns sit one
  // to the right of the roster's -- so its col 6 is SF where the roster's col 6 is monthlyRent.
  // parseLeases' `if (!propertyKey || !tenantName) continue` guard read col 1 via str(), which
  // STRINGIFIES a Date rather than rejecting it, so every row of that derived block was ingested as
  // a real lease: 10 phantom leases and +$241,880 of fabricated annual rent (each phantom's "rent"
  // was literally the unit's square footage x 12). Nothing raised a data-quality flag.
  it('ignores the trailing VACANCY & UPCOMING AVAILABILITY block instead of ingesting it as leases', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parse-workbook-test-'));
    const file = join(dir, 'fixture-vacancy-block.xlsx');

    const wb = new ExcelJS.Workbook();
    const props = wb.addWorksheet('Property NOI');
    props.addRow([
      1, PROPERTY_NAME, 'Industrial', 50000, 3, 0.92, new Date('2020-01-01'),
      5000000, 1, 5000000, 600000, 200000, 400000, 400000, 300000, 100000, 0.08, 1.3,
      'Fixture Bank', 3000000, 0.6, 100, 12, 1500000, 0.08, 5,
    ]);

    const rentRoll = wb.addWorksheet('Master Tenant Rent Roll');
    // The one genuine lease.
    rentRoll.addRow([
      PROPERTY_NAME, 'Fixture Tenant Co', 'Suite 100', 'Fixture Tenant Co',
      10000, 8000, 9.6, new Date('2022-01-01'), new Date('2027-01-01'),
      null, null, 'Active', 96000,
    ]);
    rentRoll.addRow([]); // spacer, as in the live sheet
    // Banner row -- the live workbook repeats the same text across the merged range.
    const BANNER = 'VACANCY & UPCOMING AVAILABILITY — VACANT + NOTICE TO VACATE (sorted by Lease End)';
    rentRoll.addRow([BANNER, BANNER, BANNER, BANNER, BANNER, BANNER]);
    rentRoll.addRow(['Move-Out Date', 'Property', 'Unit', 'Tenant Name', 'Company', 'SF']);
    // Derived rows: col 1 = Date, col 6 = SF (NOT rent). Both must be excluded entirely.
    rentRoll.addRow([
      new Date('2026-09-30'), PROPERTY_NAME, 'Suite 100', 'Fixture Person One',
      'Fixture Tenant Co', 1800,
    ]);
    rentRoll.addRow([
      new Date('2026-10-31'), PROPERTY_NAME, 'Suite 200', 'Fixture Person Two',
      'Fixture Other Co', 3000,
    ]);
    rentRoll.addRow(['TOTAL — 2 units', null, null, null, null, 4800]);

    wb.addWorksheet('Loan Index');
    wb.addWorksheet('Cash Balances');
    wb.addWorksheet('Insurance Renewals');
    wb.addWorksheet('Monthly Checklist');
    wb.addWorksheet('Assumptions');
    await wb.xlsx.writeFile(file);

    const { snapshot, flags } = await parseWorkbook(file);

    // Only the genuine lease survives -- the two derived rows are not tenancies.
    expect(snapshot.leases).toHaveLength(1);
    expect(snapshot.leases[0]!.tenantName).toBe('Fixture Tenant Co');

    // A RECOGNISED block must be skipped SILENTLY. It is a permanent, legitimate part of the sheet,
    // so flagging its rows would emit warnings on every run forever -- and ora-cc-snapshot-refresh
    // emails an alert whenever data-quality flags > 0, turning a correct parse into 3x/weekday
    // alert fatigue. Flags are for the UNEXPECTED (see the no-banner case below), not for this.
    expect(flags.filter((f) => f.field === 'propertyKey')).toEqual([]);
    // The block's own "Tenant Name" header row must not be mistaken for the rent roll's header row (the
    // header scan stops at the banner), or this legitimate layout would emit an annualRentHeader warning.
    expect(flags.filter((f) => f.field === 'annualRentHeader')).toEqual([]);

    // No lease may carry a stringified Date as its property key (the phantom-id signature).
    expect(snapshot.leases.filter((l) => /GMT[+-]\d{4}/.test(l.propertyKey))).toEqual([]);

    // Annual rent must not be inflated by the block's SF column being read as rent.
    expect(snapshot.leases.reduce((sum, l) => sum + (l.annualRent ?? 0), 0)).toBe(96000);
  });

  // Regression: 2026-09-07 (commit 85dfecf, found by the 2026-09-14 financial-code sweep). Three
  // retained rent-roll rows parsed to annualRent 0 in one scheduled refresh -- two 'Expired', one
  // still 'Active' with four months of term. The Active one is the parse-time signal: an Expired
  // or Vacant row legitimately carries stale/zero rent, but a live tenancy at $0 is either a real
  // vacancy nobody re-statused or a zeroed cell, and both need a human. Advisory only: a genuine
  // rent zero-out must never be refused, only surfaced.
  it('flags (warn) a $0-rent lease that is still Active or Expiring Soon, stays silent for Expired/Vacant, and never refuses the parse', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parse-workbook-test-'));
    const file = join(dir, 'fixture-zero-rent-active.xlsx');

    const wb = new ExcelJS.Workbook();
    const props = wb.addWorksheet('Property NOI');
    props.addRow([1, PROPERTY_NAME, 'Industrial', 50000, 3, 0.92]);

    const rentRoll = wb.addWorksheet('Master Tenant Rent Roll');
    // Control: a normally-rented Active lease raises nothing.
    rentRoll.addRow([PROPERTY_NAME, 'Fixture Tenant Co', 'Suite 100', 'Fixture Tenant Co', 10000, 8000, 9.6, new Date('2022-01-01'), new Date('2027-01-01'), null, null, 'Active', 96000]);
    // The incident row: Active, four months of term left, monthly AND annual rent both zeroed.
    rentRoll.addRow([PROPERTY_NAME, 'Fixture Consulting Group', 'Suite 202', 'Fixture Consulting Group', 1500, 0, null, new Date('2021-02-01'), new Date('2027-01-31'), null, 0.03, 'Active', 0]);
    // Same defect on an Expiring Soon row -- still a live tenancy, still flagged.
    rentRoll.addRow([PROPERTY_NAME, 'Fixture Expiring Co', 'Suite 203', 'Fixture Expiring Co', 1500, 0, null, new Date('2021-02-01'), new Date('2026-11-30'), null, null, 'Expiring Soon', 0]);
    // The two Expired rows from the same refresh: expected to carry $0, must NOT be flagged.
    rentRoll.addRow([PROPERTY_NAME, 'Fixture Countertops LLC', 'Suite 2000', 'Fixture Countertops LLC', 11160, 0, null, new Date('2016-05-01'), new Date('2026-07-31'), null, 0.03, 'Expired', 0]);
    rentRoll.addRow([PROPERTY_NAME, 'Fixture Tint Co', 'Suite 2004', 'Fixture Tint Co', 1850, 0, null, new Date('2019-09-01'), new Date('2026-08-31'), null, 0.03, 'Expired', 0]);
    // A Vacant row at $0 is the normal state of an empty suite.
    rentRoll.addRow([PROPERTY_NAME, 'Vacant', 'Suite 300', null, 2000, 0, null, null, null, null, null, 'Vacant', 0]);

    wb.addWorksheet('Loan Index');
    wb.addWorksheet('Cash Balances');
    wb.addWorksheet('Insurance Renewals');
    wb.addWorksheet('Monthly Checklist');
    wb.addWorksheet('Assumptions');
    await wb.xlsx.writeFile(file);

    // Never a refusal: the parse resolves, and every row is still a lease with its $0 intact.
    const { snapshot, flags } = await parseWorkbook(file);
    expect(snapshot.leases).toHaveLength(6);
    expect(snapshot.leases.filter((l) => l.annualRent === 0)).toHaveLength(5);

    const zeroRentFlags = flags.filter((f) => f.field === 'annualRent');
    const activeId = snapshot.leases.find((l) => l.tenantName === 'Fixture Consulting Group')!.id;
    const expiringId = snapshot.leases.find((l) => l.tenantName === 'Fixture Expiring Co')!.id;
    expect(zeroRentFlags.map((f) => f.entity).sort()).toEqual([activeId, expiringId].sort());
    expect(zeroRentFlags.every((f) => f.severity === 'warn')).toBe(true);
    // The reason must tell a human what to confirm, not just that a number is zero.
    expect(zeroRentFlags[0]!.issue).toMatch(/vacan/i);
    expect(zeroRentFlags[0]!.issue).toMatch(/notice/i);
    expect(zeroRentFlags[0]!.issue).toMatch(/Active/);

    // Expired / Vacant / normally-rented rows raise nothing.
    const quietIds = snapshot.leases
      .filter((l) => !['Fixture Consulting Group', 'Fixture Expiring Co'].includes(l.tenantName))
      .map((l) => l.id);
    expect(flags.filter((f) => quietIds.includes(f.entity) && f.field === 'annualRent')).toEqual([]);
  });

  // Defence in depth for the regression above. The banner terminator is text-matched, so it stops
  // working the moment someone retitles the block. A property key is never a date in any valid
  // roster row, so reject that at the type level too -- str() stringifies a Date rather than
  // returning null, which is what let these rows through the emptiness guard in the first place.
  it('never treats a date-valued property key as a lease, even with no section banner present', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parse-workbook-test-'));
    const file = join(dir, 'fixture-dated-key-no-banner.xlsx');

    const wb = new ExcelJS.Workbook();
    const props = wb.addWorksheet('Property NOI');
    props.addRow([
      1, PROPERTY_NAME, 'Industrial', 50000, 3, 0.92, new Date('2020-01-01'),
      5000000, 1, 5000000, 600000, 200000, 400000, 400000, 300000, 100000, 0.08, 1.3,
      'Fixture Bank', 3000000, 0.6, 100, 12, 1500000, 0.08, 5,
    ]);

    const rentRoll = wb.addWorksheet('Master Tenant Rent Roll');
    rentRoll.addRow([
      PROPERTY_NAME, 'Fixture Tenant Co', 'Suite 100', 'Fixture Tenant Co',
      10000, 8000, 9.6, new Date('2022-01-01'), new Date('2027-01-01'),
      null, null, 'Active', 96000,
    ]);
    // Same offset-column shape, but the banner has been renamed to something unrecognised.
    rentRoll.addRow(['ROLL-OFF SCHEDULE (RETITLED)', null, null, null, null, null]);
    rentRoll.addRow([
      new Date('2026-09-30'), PROPERTY_NAME, 'Suite 100', 'Fixture Person One',
      'Fixture Tenant Co', 1800,
    ]);

    wb.addWorksheet('Loan Index');
    wb.addWorksheet('Cash Balances');
    wb.addWorksheet('Insurance Renewals');
    wb.addWorksheet('Monthly Checklist');
    wb.addWorksheet('Assumptions');
    await wb.xlsx.writeFile(file);

    const { snapshot, flags } = await parseWorkbook(file);

    expect(snapshot.leases).toHaveLength(1);
    expect(snapshot.leases[0]!.tenantName).toBe('Fixture Tenant Co');
    expect(snapshot.leases.reduce((sum, l) => sum + (l.annualRent ?? 0), 0)).toBe(96000);

    // The drop must never be SILENT. A dropped row is the correct outcome here, but "no lease and
    // no flag" is indistinguishable from "nothing was there" -- which is exactly the blind spot
    // that let the phantom leases ship unnoticed (the original corrupt extract reported
    // "Data-quality flags: 0"). If a genuine roster row ever gets Excel-coerced to a date, this
    // flag is the only thing standing between that and a silently vanished tenancy.
    const droppedFlags = flags.filter((f) => f.field === 'propertyKey');
    expect(droppedFlags).toHaveLength(1);
    expect(droppedFlags[0]!.issue).toMatch(/date/i);
    expect(droppedFlags[0]!.severity).toBe('warn');
  });
});
