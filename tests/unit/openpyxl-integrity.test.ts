// tests/unit/openpyxl-integrity.test.ts
//
// Regression cover for the 2026-08-13/14 openpyxl corruption incident. An openpyxl
// re-save of the Master Workbook breaks exceljs two independent ways; these tests pin
// both detectors, and pin the deliberate choice NOT to normalize-and-continue.
import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import {
  describeOpenpyxlReadFailure,
  auditCachedValues,
  assertCachedValuesPresent,
} from '../../server/workbook/openpyxl-integrity';

/** Build an in-memory workbook with `total` formula cells, `withCache` of them cached. */
function workbookWithFormulas(total: number, withCache: number): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  for (let i = 0; i < total; i++) {
    const cell = ws.getCell(i + 1, 1);
    cell.value =
      i < withCache ? { formula: 'A1+1', result: 42 } : ({ formula: 'A1+1' } as never);
  }
  return wb;
}

describe('describeOpenpyxlReadFailure', () => {
  it('recognizes the exceljs reconcile crash from absolute comment rel targets', () => {
    const err = new TypeError("Cannot read properties of undefined (reading 'comments')");
    const msg = describeOpenpyxlReadFailure(err);
    expect(msg).toBeTruthy();
    expect(msg).toContain('ABSOLUTE');
    expect(msg).toContain('openpyxl');
    // Must tell the operator what to actually do.
    expect(msg).toContain('re-save');
  });

  it('recognizes the older singular phrasing of the same V8 error', () => {
    const err = new TypeError("Cannot read property of undefined (reading 'comments')");
    expect(describeOpenpyxlReadFailure(err)).toBeTruthy();
  });

  it('returns null for unrelated errors so they propagate untouched', () => {
    expect(describeOpenpyxlReadFailure(new Error('ENOENT: no such file'))).toBeNull();
    expect(describeOpenpyxlReadFailure(new Error('Worksheet not found: "Loans"'))).toBeNull();
    // A different undefined-property crash must NOT be mislabeled as the openpyxl bug.
    expect(
      describeOpenpyxlReadFailure(
        new TypeError("Cannot read properties of undefined (reading 'hyperlinks')"),
      ),
    ).toBeNull();
  });

  it('tolerates non-Error throwables', () => {
    expect(describeOpenpyxlReadFailure('boom')).toBeNull();
    expect(describeOpenpyxlReadFailure(undefined)).toBeNull();
    expect(describeOpenpyxlReadFailure(null)).toBeNull();
  });
});

describe('auditCachedValues', () => {
  it('reports a healthy workbook as not stripped', () => {
    // Mirrors the repaired incident file: ~98.7% cached.
    const audit = auditCachedValues(workbookWithFormulas(1000, 987));
    expect(audit.formulaCells).toBe(1000);
    expect(audit.missingCached).toBe(13);
    expect(audit.stripped).toBe(false);
  });

  it('flags the openpyxl signature (cached values essentially all gone)', () => {
    // Mirrors the broken incident file: 4 of 14,715 cached.
    const audit = auditCachedValues(workbookWithFormulas(1000, 3));
    expect(audit.missingCached).toBe(997);
    expect(audit.stripped).toBe(true);
  });

  it('does not flag a small workbook, where the ratio is not meaningful', () => {
    const audit = auditCachedValues(workbookWithFormulas(20, 0));
    expect(audit.missingRatio).toBe(1);
    expect(audit.stripped).toBe(false);
  });

  it('does not flag a workbook with no formulas at all', () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    ws.getCell('A1').value = 'text';
    ws.getCell('A2').value = 123;
    const audit = auditCachedValues(wb);
    expect(audit.formulaCells).toBe(0);
    expect(audit.missingRatio).toBe(0);
    expect(audit.stripped).toBe(false);
  });
});

describe('assertCachedValuesPresent', () => {
  it('refuses a stripped workbook rather than emitting null financials', () => {
    const wb = workbookWithFormulas(1000, 3);
    expect(() => assertCachedValuesPresent(wb, 'C:/wb.xlsx')).toThrow(/cached formula values/i);
    expect(() => assertCachedValuesPresent(wb, 'C:/wb.xlsx')).toThrow(/openpyxl/);
    // The path must be in the message - three different consumers hit this.
    expect(() => assertCachedValuesPresent(wb, 'C:/wb.xlsx')).toThrow(/C:\/wb\.xlsx/);
  });

  it('allows a healthy workbook through', () => {
    expect(() => assertCachedValuesPresent(workbookWithFormulas(1000, 987), 'x')).not.toThrow();
  });
});
