// tests/unit/warehouse-detect.test.ts
import { describe, expect, it } from 'vitest';
import { detectFromFilename } from '../../server/warehouse/detect';

describe('filename detection', () => {
  it('parses "P&L <year> -- <token>" forms', () => {
    const d = detectFromFilename('P&L 2025 -- 1100 Rarig.xlsx');
    expect(d).toMatchObject({
      propertyId: '1100-rarig-ave-columbus-oh', year: 2025, grain: 'year', format: 'xlsx',
    });
    expect(d?.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it('parses YTD and year-first PDF forms', () => {
    expect(detectFromFilename('P&L 2026 YTD -- FVC.xlsx')).toMatchObject({
      propertyId: 'sepich-portfolio-columbus-oh-8-props', year: 2026, grain: 'ytd',
    });
    expect(detectFromFilename('2025 P&L -- 2203-2207 Northwood.pdf')).toMatchObject({
      propertyId: '2203-2207-northwood-dr-salisbury-md', year: 2025, format: 'pdf',
    });
  });

  it('resolves every real staged token', () => {
    const cases: Array<[string, string]> = [
      ['P&L 2024 -- 1851 South Club Solar.xlsm', '1851-s-club-solar'],
      ['P&L 2024 -- 1900 Broadway.xlsx', '1900-n-broadway-baltimore-md'],
      ['P&L 2024 -- 29000 Info Lane.xlsx', '29000-information-lane-easton-md'],
      ['P&L 2024 -- 3540 E 5th.xlsx', '3540-e-5th-ave-columbus-oh'],
      ['P&L 2024 -- 55 New Plant (EGFLLC).xlsx', '55-new-plant-ct-owings-mills-md'],
      ['P&L 2024 -- 9050 Red Branch.xlsx', '9050-red-branch-rd-columbia-md'],
      ['P&L 2025 -- 3034 Westerville.xlsx', '3034-westerville-rd-columbus-oh'],
      ['P&L 2025 -- 3883 Livingston.xlsx', '3875-3883-e-livingston-ave-columbus-oh'],
      ['P&L 2025 -- 9620 State 350.xlsx', '9620-e-state-route-350-raytown-mo'],
    ];
    for (const [file, id] of cases) expect(detectFromFilename(file)?.propertyId).toBe(id);
  });

  it('normalizes stray spaces around hyphens in the token (AppFolio "2203 -2207 Northwood" naming)', () => {
    const d = detectFromFilename('P&L 2025 -- 2203 -2207 Northwood.xlsx');
    expect(d).toMatchObject({
      propertyId: '2203-2207-northwood-dr-salisbury-md', year: 2025, grain: 'year', format: 'xlsx',
    });
    expect(d?.confidence).toBeGreaterThanOrEqual(0.85);
    expect(detectFromFilename('P&L 2026 YTD -- 2203 -2207 Northwood.xlsx')).toMatchObject({
      propertyId: '2203-2207-northwood-dr-salisbury-md', year: 2026, grain: 'ytd',
    });
  });

  it('returns null for non-financial files and unknown tokens', () => {
    expect(detectFromFilename('Lease Eurosort -- 55 New Plant Court 10-2022.pdf')).toBeNull();
    const unknown = detectFromFilename('P&L 2025 -- Mystery Building.xlsx');
    expect(unknown?.propertyId).toBeNull();
    expect(unknown?.confidence).toBeLessThan(0.85);
  });
});
