// tests/unit/warehouse-live-drift.test.ts
import { describe, expect, it } from 'vitest';
import type { BasisEntry } from '../../server/warehouse/live-drift';
import { basisDrift } from '../../server/warehouse/live-drift';

// basisDrift is the pure core of the warehouse:drift gate: it compares the committed
// file_hash→BasisEntry map of the LIVE persistent warehouse against a fresh rebuild from the same
// source files, and returns one row per divergence. This catches the stale-served-DB class of
// bug (a parser improvement that hash-dedup'd backfill never re-applied), which warehouse:verify
// cannot see because it scores a fresh temp DB, not the served one.
//
// Keys are file_hash strings (unique per content). BasisEntry carries both basis and fileName
// so the display layer can show a human-readable name even though the comparator keys on hash.
function entry(basis: string, fileName: string): BasisEntry { return { basis, fileName }; }

describe('basisDrift', () => {
  it('reports no drift when live and fresh agree exactly', () => {
    const live = new Map([
      ['hash-a', entry('cash', 'P&L 2025 -- A.xlsx')],
      ['hash-b', entry('accrual', 'P&L 2025 -- B.xlsx')],
    ]);
    const fresh = new Map(live);
    expect(basisDrift(live, fresh)).toEqual([]);
  });

  it("flags a file whose live basis is stale vs a fresh rebuild (the real defect: live 'unknown', fresh 'accrual')", () => {
    const live = new Map([['hash-plant', entry('unknown', 'P&L 2025 -- 55 New Plant.xlsx')]]);
    const fresh = new Map([['hash-plant', entry('accrual', 'P&L 2025 -- 55 New Plant.xlsx')]]);
    expect(basisDrift(live, fresh)).toEqual([
      { fileHash: 'hash-plant', fileName: 'P&L 2025 -- 55 New Plant.xlsx', live: 'unknown', fresh: 'accrual' },
    ]);
  });

  it('flags a presence mismatch in either direction (absent from live, or absent from fresh)', () => {
    const live = new Map([
      ['hash-a', entry('cash', 'A.xlsx')],
      ['hash-stale', entry('cash', 'Stale.xlsx')],
    ]);
    const fresh = new Map([
      ['hash-a', entry('cash', 'A.xlsx')],
      ['hash-new', entry('accrual', 'New.xlsx')],
    ]);
    expect(basisDrift(live, fresh)).toEqual([
      { fileHash: 'hash-new', fileName: 'New.xlsx', live: null, fresh: 'accrual' },
      { fileHash: 'hash-stale', fileName: 'Stale.xlsx', live: 'cash', fresh: null },
    ]);
  });

  it('returns every mismatch, sorted by file name; agreeing files are omitted', () => {
    const live = new Map([
      ['hash-z', entry('cash', 'Z.xlsx')],
      ['hash-a', entry('cash', 'A.xlsx')],
      ['hash-m', entry('cash', 'M.xlsx')],
    ]);
    const fresh = new Map([
      ['hash-z', entry('accrual', 'Z.xlsx')],
      ['hash-a', entry('unknown', 'A.xlsx')],
      ['hash-m', entry('cash', 'M.xlsx')],
    ]);
    const rows = basisDrift(live, fresh);
    expect(rows.map((r) => r.fileName)).toEqual(['A.xlsx', 'Z.xlsx']); // M.xlsx agrees → omitted
  });
});
