// tests/unit/warehouse-data-quality.test.ts
import { describe, expect, it } from 'vitest';
import { computeBasisCoverage } from '../../server/warehouse/data-quality';

// computeBasisCoverage is the pure core of the warehouse:verify "basis coverage" gate (check #6).
// It counts committed imports whose accounting basis failed to parse ('unknown' — a period-header
// miss). This is a basis-discipline data-quality signal: scores.ts G3 benchmarks an unknown-basis
// property against NO same-basis peers (it treats 'unknown' as non-comparable), so that property's
// NOI/SF benchmark position falls to neutral. The gate ratchets the unknown count against regression.
// NOTE: this is deliberately a per-IMPORT data-quality count, NOT a model of G3's per-property
// suppression (which depends on each property's latest-full-year basis and same-basis peer count).
describe('computeBasisCoverage', () => {
  it('reports zero coverage gap for an empty warehouse', () => {
    expect(computeBasisCoverage([])).toEqual({ committed: 0, unknown: 0, unknownFiles: [] });
  });

  it('reports no gap when every import has a parsed basis', () => {
    const r = computeBasisCoverage([
      { basis: 'cash', fileName: 'P&L 2025 -- A.xlsx' },
      { basis: 'accrual', fileName: 'P&L 2025 -- B.xlsx' },
    ]);
    expect(r).toEqual({ committed: 2, unknown: 0, unknownFiles: [] });
  });

  it('counts unknown-basis imports and lists their file names in input order', () => {
    const r = computeBasisCoverage([
      { basis: 'cash', fileName: 'P&L 2025 -- A.xlsx' },
      { basis: 'unknown', fileName: 'P&L 2025 -- B.xlsm' },
      { basis: 'unknown', fileName: 'P&L 2024 -- C.xlsx' },
    ]);
    expect(r).toEqual({
      committed: 3,
      unknown: 2,
      unknownFiles: ['P&L 2025 -- B.xlsm', 'P&L 2024 -- C.xlsx'],
    });
  });

  it("treats a null/empty basis as 'unknown' (matches the engine's COALESCE to unknown)", () => {
    const r = computeBasisCoverage([
      { basis: null as unknown as string, fileName: 'nullbasis.xlsx' },
      { basis: '', fileName: 'emptybasis.xlsx' },
      { basis: 'cash', fileName: 'ok.xlsx' },
    ]);
    expect(r.unknown).toBe(2);
    expect(r.unknownFiles).toEqual(['nullbasis.xlsx', 'emptybasis.xlsx']);
  });

  it('matches the live warehouse shape (8 of 32 committed imports unknown)', () => {
    const rows = Array.from({ length: 32 }, (_, i) => ({
      basis: i < 8 ? 'unknown' : 'cash',
      fileName: `P&L file ${i}.xlsx`,
    }));
    const r = computeBasisCoverage(rows);
    expect(r.committed).toBe(32);
    expect(r.unknown).toBe(8);
    expect(r.unknownFiles).toHaveLength(8);
  });
});
