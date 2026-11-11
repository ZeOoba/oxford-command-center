// tests/unit/parse-cash.test.ts
//
// parseCash() coverage (server/workbook/parse.ts) for the two cash defects the 2026-09-14
// financial-code sweep found live in the committed snapshot. Both are DETECTION or DERIVATION
// fixes -- nothing here backfills, overrides, or refuses:
//
//  (1) deltaPct / growth12Pct were read verbatim from the workbook's own percent cells, which divide
//      by the prior (or 12-month-ago) balance as-is. When that denominator is NEGATIVE the cell's
//      sign inverts against its own dollar figure (live: a negative deltaDollar beside a positive
//      deltaPct; a positive growth12Dollar beside a large negative growth12Pct). The parser now recomputes both from the
//      dollar figure and the balance it is measured against, and emits null -- this repo's
//      "verified null over a wrong-signed number" rule -- whenever that balance is <= 0 or missing.
//  (2) The Cash Balances sheet's typed "As of" dateline could sit LATER than the last row of its own
//      Cash Data history matrix (live: as-of 2026-09-10 over a history ending 2026-07-10) with no
//      flag. That mismatch is exactly what let a September as-of coexist with a July-ending history.
//
// Fixture pattern follows tests/unit/parse-workbook.test.ts (real ExcelJS file, real parseWorkbook,
// no mocks); all names are deliberately synthetic.
import ExcelJS from 'exceljs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseWorkbook } from '../../server/workbook/parse';

interface EntityRow {
  entity: string;
  current: number;
  prior: number | null;
  deltaDollar: number | null;
  /** The workbook's OWN percent cell -- deliberately wrong in most cases, to prove it is not trusted. */
  deltaPctCell: number | null;
  minAllTime?: number | null;
  maxAllTime?: number | null;
  bal12: number | null;
  growth12Dollar: number | null;
  growth12PctCell: number | null;
}

interface FixtureOpts {
  /** Cash Balances A2 dateline, e.g. 'As of September 10, 2026'. */
  dateline: string;
  entities: EntityRow[];
  /** Cash Data history rows: [date, entity balances..., total]. */
  history: { date: Date; balances: number[]; total: number }[];
}

async function writeFixture(path: string, opts: FixtureOpts): Promise<void> {
  const wb = new ExcelJS.Workbook();

  const noi = wb.addWorksheet('Property NOI');
  noi.addRow([1, 'Fixture Property Delta', 'Industrial', 50000, 1, 0.9]);
  wb.addWorksheet('Master Tenant Rent Roll');
  wb.addWorksheet('Loan Index');

  // Layout mirrors the live sheet: title, dateline, spacer, "Entity / LLC" header, one row per
  // entity (col: entity, current, prior, Δ$, Δ%, avg3, min, max, bal12, g12$, g12%, %port, arrow),
  // "Total Portfolio", spacer, then the "Date" history matrix (Date, entity..., Total).
  const cash = wb.addWorksheet('Cash Balances');
  cash.addRow(['OXFORD REALTY ADVISORS — ENTITY CASH BALANCE SUMMARY']);
  cash.addRow([opts.dateline]);
  cash.addRow([]);
  cash.addRow(['Entity / LLC', 'Current', 'Prior', 'Δ $', 'Δ %', 'Avg 3', 'Min', 'Max', '12mo Ago', '12mo Δ $', '12mo Δ %', '% Port', 'Trend']);
  for (const e of opts.entities) {
    cash.addRow([
      e.entity, e.current, e.prior, e.deltaDollar, e.deltaPctCell, null, e.minAllTime ?? null, e.maxAllTime ?? null,
      e.bal12, e.growth12Dollar, e.growth12PctCell, null, null,
    ]);
  }
  cash.addRow(['Total Portfolio', opts.entities.reduce((s, e) => s + e.current, 0)]);
  cash.addRow([]);
  cash.addRow(['Date', ...opts.entities.map((e) => e.entity), 'Total']);
  for (const h of opts.history) cash.addRow([h.date, ...h.balances, h.total]);

  wb.addWorksheet('Insurance Renewals');
  wb.addWorksheet('Monthly Checklist');
  wb.addWorksheet('Assumptions');
  await wb.xlsx.writeFile(path);
}

function tmpFile(prefix: string): string {
  return join(mkdtempSync(join(tmpdir(), prefix)), 'fixture.xlsx');
}

const solar: EntityRow = {
  // The clean case, live-shaped: positive prior and 12-month balances, so the recomputed percents
  // are ordinary. The workbook cells are set to nonsense to prove they are not what gets served.
  entity: 'Fixture Solar (25%)',
  current: 1234.567, prior: 1000, deltaDollar: 234.567, deltaPctCell: -0.5,
  bal12: 900, growth12Dollar: 334.567, growth12PctCell: -0.9,
};

describe('parseCash — deltaPct / growth12Pct are recomputed, never read verbatim', () => {
  it('derives deltaPct = deltaDollar / priorBalance and growth12Pct = growth12Dollar / bal12moAgo, ignoring the workbook percent cells', async () => {
    const file = tmpFile('parse-cash-recompute-');
    await writeFixture(file, {
      dateline: 'As of July 10, 2026',
      entities: [solar],
      history: [{ date: new Date('2026-07-10'), balances: [1234.567], total: 1234.567 }],
    });

    const { snapshot } = await parseWorkbook(file);

    const e = snapshot.cash.entities[0]!;
    expect(e.deltaDollar).toBeCloseTo(234.567, 3); // the dollar figure itself is still the workbook's
    expect(e.deltaPct).toBeCloseTo(234.567 / 1000, 6);
    expect(e.growth12Pct).toBeCloseTo(334.567 / 900, 6);
    expect(e.deltaPct).not.toBe(-0.5);
    expect(e.growth12Pct).not.toBe(-0.9);
  });

  it('emits null -- never a wrong-signed number -- when the denominator is negative (the live sign-inversion pair)', async () => {
    const file = tmpFile('parse-cash-negative-denominator-');
    await writeFixture(file, {
      dateline: 'As of July 10, 2026',
      entities: [
        {
          // Live shape: overdrawn prior balance, so the workbook's Δ% cell reads +11.1% on a -$2,222 move.
          entity: 'Fixture Livingston',
          current: -22222.22, prior: -20000, deltaDollar: -2222.22, deltaPctCell: 0.1111,
          bal12: null, growth12Dollar: -22222.22, growth12PctCell: null,
        },
        {
          // Live shape: positive prior (Δ% recomputes fine) but a NEGATIVE 12-month-ago balance, so
          // the workbook's 12-mo % cell reads -989% on a +$1,236 move.
          entity: 'Fixture Broadway',
          current: 1111.125, prior: 1500, deltaDollar: -388.875, deltaPctCell: -0.2593,
          bal12: -125, growth12Dollar: 1236.125, growth12PctCell: -9.889,
        },
      ],
      history: [{ date: new Date('2026-07-10'), balances: [-22222.22, 1111.125], total: -21111.095 }],
    });

    const { snapshot } = await parseWorkbook(file);

    const livingston = snapshot.cash.entities.find((e) => e.entity === 'Fixture Livingston')!;
    expect(livingston.deltaPct).toBeNull();
    expect(livingston.growth12Pct).toBeNull(); // bal12moAgo missing -> nothing to measure against

    const broadway = snapshot.cash.entities.find((e) => e.entity === 'Fixture Broadway')!;
    expect(broadway.deltaPct).toBeCloseTo(-388.875 / 1500, 6); // positive prior: ordinary
    expect(broadway.growth12Pct).toBeNull(); // negative 12-month-ago balance: verified null
  });

  it('emits null when the denominator is zero or missing, and when the dollar figure itself is missing', async () => {
    const file = tmpFile('parse-cash-zero-denominator-');
    await writeFixture(file, {
      dateline: 'As of July 10, 2026',
      entities: [
        { entity: 'Fixture Zero Prior', current: 100, prior: 0, deltaDollar: 100, deltaPctCell: 1, bal12: 0, growth12Dollar: 100, growth12PctCell: 1 },
        { entity: 'Fixture No Prior', current: 100, prior: null, deltaDollar: null, deltaPctCell: 0.25, bal12: null, growth12Dollar: null, growth12PctCell: 0.25 },
        { entity: 'Fixture No Dollar', current: 100, prior: 80, deltaDollar: null, deltaPctCell: 0.25, bal12: 50, growth12Dollar: null, growth12PctCell: 1 },
      ],
      history: [{ date: new Date('2026-07-10'), balances: [100, 100, 100], total: 300 }],
    });

    const { snapshot } = await parseWorkbook(file);

    for (const e of snapshot.cash.entities) {
      expect(e.deltaPct, e.entity).toBeNull();
      expect(e.growth12Pct, e.entity).toBeNull();
    }
  });
});

describe('parseCash — the sheet dateline must not outrun its own history matrix', () => {
  it('warns when the typed "As of" dateline is LATER than the last Cash Data row -- the September as-of over a July-ending history', async () => {
    const file = tmpFile('parse-cash-dateline-ahead-');
    await writeFixture(file, {
      dateline: 'As of September 10, 2026',
      entities: [solar],
      history: [
        { date: new Date('2026-06-10'), balances: [1000], total: 1000 },
        { date: new Date('2026-07-10'), balances: [1234.567], total: 1234.567 },
      ],
    });

    const { snapshot, flags } = await parseWorkbook(file);

    const f =flags.find((x) => x.entity === 'cash' && x.field === 'asOf');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('warn');
    expect(f!.issue).toContain('2026-09-10');
    expect(f!.issue).toContain('2026-07-10');

    // Detection only: the as-of is still the sheet's own dateline (the provenance rule from OI-023
    // stands), and the history is served exactly as the workbook has it -- no rows invented.
    expect(snapshot.cash.asOf).toBe('2026-09-10');
    expect(snapshot.cash.history.map((h) => h.date)).toEqual(['2026-06-10', '2026-07-10']);
  });

  it('is silent when the dateline equals the last history date (the normal, data-derived case)', async () => {
    const file = tmpFile('parse-cash-dateline-aligned-');
    await writeFixture(file, {
      dateline: 'As of July 10, 2026',
      entities: [solar],
      history: [
        { date: new Date('2026-06-10'), balances: [1000], total: 1000 },
        { date: new Date('2026-07-10'), balances: [1234.567], total: 1234.567 },
      ],
    });

    const { snapshot, flags } = await parseWorkbook(file);

    expect(snapshot.cash.asOf).toBe('2026-07-10');
    expect(flags.filter((x) => x.entity === 'cash' && x.field === 'asOf')).toEqual([]);
  });
});
