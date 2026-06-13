// tests/unit/intel-hooks.test.ts
//
// Pure response-shaping helpers for the Property Financial Intelligence module.
// The React Query hooks themselves are exercised by the route tests + e2e smoke,
// not jsdom fetch mocking — only the pure transforms are unit-tested here.
import { describe, expect, it } from 'vitest';
import { groupNoiByProperty, type NoiMatrixCell } from '../../src/modules/intel/hooks';

const cell = (propertyId: string, propertyName: string | null, period: string, noi: number): NoiMatrixCell => ({
  propertyId,
  propertyName,
  period,
  noi,
});

describe('groupNoiByProperty', () => {
  it('returns one row per property with a period→noi map and the union of periods sorted ascending', () => {
    const matrix: NoiMatrixCell[] = [
      cell('rarig', '1100 Rarig Ave', '2024', 90000),
      cell('rarig', '1100 Rarig Ave', '2025', 95000),
      cell('club', '1851 S Club', '2025', 42000),
    ];
    const { periods, rows } = groupNoiByProperty(matrix);

    expect(periods).toEqual(['2024', '2025']);
    expect(rows).toHaveLength(2);

    const rarig = rows.find((r) => r.propertyId === 'rarig');
    expect(rarig).toBeDefined();
    expect(rarig?.propertyName).toBe('1100 Rarig Ave');
    expect(rarig?.byPeriod).toEqual({ '2024': 90000, '2025': 95000 });

    const club = rows.find((r) => r.propertyId === 'club');
    // A property missing a period has no entry for it (renders as em-dash, not 0).
    expect(club?.byPeriod['2024']).toBeUndefined();
    expect(club?.byPeriod['2025']).toBe(42000);
  });

  it('sorts rows by property name (id fallback) and is stable for an empty matrix', () => {
    expect(groupNoiByProperty([])).toEqual({ periods: [], rows: [] });

    const matrix: NoiMatrixCell[] = [
      cell('z-id', 'Zeta Plaza', '2025', 10),
      cell('a-id', 'Alpha Center', '2025', 20),
    ];
    const { rows } = groupNoiByProperty(matrix);
    expect(rows.map((r) => r.propertyId)).toEqual(['a-id', 'z-id']);
  });

  it('falls back to the property id for the display name when name is null', () => {
    const { rows } = groupNoiByProperty([cell('orphan-id', null, '2025', 5)]);
    expect(rows[0]?.propertyName).toBe('orphan-id');
  });

  it('deduplicates periods that repeat across properties', () => {
    const { periods } = groupNoiByProperty([
      cell('a', 'A', '2025', 1),
      cell('b', 'B', '2025', 2),
      cell('a', 'A', '2024', 3),
    ]);
    expect(periods).toEqual(['2024', '2025']);
  });
});
