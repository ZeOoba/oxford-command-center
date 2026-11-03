// tests/unit/expense-matrix.test.ts
//
// Roadmap 3.2: property × expense-line $/SF matrix, portfolio-quartile shading (interim until the
// design-step-7 per-column thresholds are ratified). No postings is "no postings", never $0.
import { describe, expect, it } from 'vitest';
import type { PfDataset } from '@contracts/property-financials';
import { PF_ENTITY_IDS } from '@contracts/property-financials';
import { buildExpenseMatrix, isFullYear, latestFullYear, quartileOf } from '../../src/modules/property-financials/expense-matrix';

describe('quartileOf', () => {
  const vals = [1, 2, 3, 4, 5, 6, 7, 8];
  it('ranks low to high into four buckets', () => {
    expect(vals.map((v) => quartileOf(v, vals))).toEqual([1, 1, 2, 2, 3, 3, 4, 4]);
  });
  it('ties share the lower rank', () => {
    expect(quartileOf(5, [5, 5, 5, 9])).toBe(1);
  });
  it('does not rank a column with fewer than four values', () => {
    expect(quartileOf(2, [1, 2, 3])).toBeNull();
  });
});

/** Minimal dataset slice: only `sf` and `history[*].yr` are read. */
function dataset(rows: Record<string, { sf: number | null; cats?: Record<string, number>; partial?: boolean; noYear?: boolean; months?: number }>): PfDataset {
  const sf: Record<string, unknown> = {};
  const history: Record<string, unknown> = {};
  for (const id of PF_ENTITY_IDS) {
    const r = rows[id] ?? { sf: null };
    sf[id] = { sf: r.sf, note: 'x' };
    // Monthly entity: a year is full only with 12 months (the contract's `partial` stays false mid-year).
    history[id] = { monthly: true, yr: r.noYear ? {} : { '2025': { cats: r.cats ?? {}, partial: r.partial ?? false, n: r.months ?? 12 } } };
  }
  return { sf, history } as unknown as PfDataset;
}

describe('isFullYear', () => {
  const y = (n: number, partial: boolean) => ({ n, partial }) as Parameters<typeof isFullYear>[1];
  it('monthly entity: only 12 months is full, whatever the partial flag says', () => {
    expect(isFullYear(true, y(12, false))).toBe(true);
    expect(isFullYear(true, y(9, false))).toBe(false);
  });
  it('annual entity: one statement is full unless flagged partial', () => {
    expect(isFullYear(false, y(1, false))).toBe(true);
    expect(isFullYear(false, y(1, true))).toBe(false);
  });
});

describe('latestFullYear', () => {
  it('is the newest non-partial year among entities with SF', () => {
    const d = dataset({ [PF_ENTITY_IDS[0]!]: { sf: 1000 } });
    expect(latestFullYear(d)).toBe('2025');
    // 9 months with partial=false is how the live dataset marks an in-progress monthly year.
    const inProgress = dataset({ [PF_ENTITY_IDS[0]!]: { sf: 1000, months: 9 } });
    expect(latestFullYear(inProgress)).toBeNull();
  });
});

describe('buildExpenseMatrix', () => {
  const ids = PF_ENTITY_IDS;
  const base = Object.fromEntries(
    ids.slice(0, 5).map((id, i) => [id, { sf: 1000, cats: { Insurance: (i + 1) * 1000, 'Real estate & property tax': 500 } }]),
  );

  it('divides each line by SF, entity 100% basis', () => {
    const m = buildExpenseMatrix(dataset(base), '2025');
    const row = m.rows.find((r) => r.entity === ids[2])!;
    expect(row.cells.Insurance).toMatchObject({ perSf: 3, usd: 3000 });
  });

  it('a line with no postings is null and stays out of the quartile cut', () => {
    const m = buildExpenseMatrix(dataset(base), '2025');
    for (const r of m.rows) expect(r.cells.Utilities).toEqual({ perSf: null, usd: null, quartile: null });
  });

  it('quartiles each column across the portfolio', () => {
    const m = buildExpenseMatrix(dataset(base), '2025');
    expect(m.rows.map((r) => r.cells.Insurance.quartile)).toEqual([1, 1, 2, 3, 4]);
  });

  it('excludes entities with no SF, a partial year or no statements — with the reason', () => {
    const m = buildExpenseMatrix(
      dataset({
        ...base,
        [ids[5]!]: { sf: null, cats: { Insurance: 1 } },
        [ids[6]!]: { sf: 1000, cats: { Insurance: 1 }, months: 9 },
        [ids[7]!]: { sf: 1000, noYear: true },
      }),
      '2025',
    );
    expect(m.rows).toHaveLength(5);
    const reasons = Object.fromEntries(m.excluded.map((e) => [e.entity, e.reason]));
    expect(reasons[ids[5]!]).toBe('no square footage');
    expect(reasons[ids[6]!]).toBe('2025 is a partial year');
    expect(reasons[ids[7]!]).toBe('no 2025 statements');
  });
});
