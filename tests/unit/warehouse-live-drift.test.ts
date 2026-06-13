// tests/unit/warehouse-live-drift.test.ts
import { describe, expect, it } from 'vitest';
import { basisDrift } from '../../server/warehouse/live-drift';

// basisDrift is the pure core of the warehouse:drift gate: it compares the committed
// file_name→basis map of the LIVE persistent warehouse against a fresh rebuild from the same
// source files, and returns one row per divergence. This catches the stale-served-DB class of
// bug (a parser improvement that hash-dedup'd backfill never re-applied), which warehouse:verify
// cannot see because it scores a fresh temp DB, not the served one.
describe('basisDrift', () => {
  it('reports no drift when live and fresh agree exactly', () => {
    const live = new Map([['P&L 2025 -- A.xlsx', 'cash'], ['P&L 2025 -- B.xlsx', 'accrual']]);
    const fresh = new Map(live);
    expect(basisDrift(live, fresh)).toEqual([]);
  });

  it("flags a file whose live basis is stale vs a fresh rebuild (the real defect: live 'unknown', fresh 'accrual')", () => {
    const live = new Map([['P&L 2025 -- 55 New Plant.xlsx', 'unknown']]);
    const fresh = new Map([['P&L 2025 -- 55 New Plant.xlsx', 'accrual']]);
    expect(basisDrift(live, fresh)).toEqual([
      { fileName: 'P&L 2025 -- 55 New Plant.xlsx', live: 'unknown', fresh: 'accrual' },
    ]);
  });

  it('flags a presence mismatch in either direction (absent from live, or absent from fresh)', () => {
    const live = new Map([['A.xlsx', 'cash'], ['Stale.xlsx', 'cash']]);
    const fresh = new Map([['A.xlsx', 'cash'], ['New.xlsx', 'accrual']]);
    expect(basisDrift(live, fresh)).toEqual([
      { fileName: 'New.xlsx', live: null, fresh: 'accrual' },
      { fileName: 'Stale.xlsx', live: 'cash', fresh: null },
    ]);
  });

  it('returns every mismatch, sorted by file name; agreeing files are omitted', () => {
    const live = new Map([['Z.xlsx', 'cash'], ['A.xlsx', 'cash'], ['M.xlsx', 'cash']]);
    const fresh = new Map([['Z.xlsx', 'accrual'], ['A.xlsx', 'unknown'], ['M.xlsx', 'cash']]);
    const rows = basisDrift(live, fresh);
    expect(rows.map((r) => r.fileName)).toEqual(['A.xlsx', 'Z.xlsx']); // M.xlsx agrees → omitted
  });
});
