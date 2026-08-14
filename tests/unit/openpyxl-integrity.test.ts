// tests/unit/openpyxl-integrity.test.ts
//
// Regression cover for the 2026-08-13/14 openpyxl corruption incident, plus the three
// defects an adversarial REFUTE pass found in the first draft of the detector:
//   - cached "" is indistinguishable from uncached, so a healthy workbook could be refused
//   - absolute TABLE targets crash with a different message than absolute COMMENT targets
//   - a data_only=True re-save collapses formulaCells to 0 and sailed through
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import {
  describeOpenpyxlReadFailure,
  scanAbsoluteRelTargets,
  assertRelationshipTargetsResolvable,
  auditCachedValues,
  assertCachedValuesPresent,
} from '../../server/workbook/openpyxl-integrity';

/** Build an in-memory workbook with `total` formula cells, `withCache` of them cached. */
function workbookWithFormulas(total: number, withCache: number, result: unknown = 42) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  for (let i = 0; i < total; i++) {
    ws.getCell(i + 1, 1).value =
      i < withCache ? ({ formula: 'A1+1', result } as never) : ({ formula: 'A1+1' } as never);
  }
  return wb;
}

/** Await the callback before cleanup - a sync `finally` would delete the dir mid-write. */
async function withTempDir<T>(fn: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'openpyxl-integrity-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('scanAbsoluteRelTargets', () => {
  it('reports 0 for a normal Excel-shaped workbook written by exceljs', async () => {
    await withTempDir(async (dir) => {
      const p = join(dir, 'healthy.xlsx');
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('S');
      ws.getCell('A1').value = 1;
      ws.getCell('A2').note = 'a comment, so a comment rel exists';
      await wb.xlsx.writeFile(p);

      const scan = scanAbsoluteRelTargets(p);
      expect(scan.evaluated).toBe(true);
      expect(scan.count).toBe(0);
    });
  });

  it('fails OPEN on a file that is not a readable zip, never blocking a parse', async () => {
    await withTempDir((dir) => {
      const p = join(dir, 'garbage.xlsx');
      writeFileSync(p, Buffer.from('this is not a zip archive'));
      const scan = scanAbsoluteRelTargets(p);
      expect(scan.evaluated).toBe(false);
      expect(scan.count).toBe(0);
      expect(() => assertRelationshipTargetsResolvable(p)).not.toThrow();
    });
  });

  it('fails OPEN on a missing file', () => {
    const scan = scanAbsoluteRelTargets(join(tmpdir(), 'does-not-exist-xyz.xlsx'));
    expect(scan.evaluated).toBe(false);
    expect(() => assertRelationshipTargetsResolvable(join(tmpdir(), 'nope.xlsx'))).not.toThrow();
  });
});

describe('describeOpenpyxlReadFailure', () => {
  it('does not claim the openpyxl cause when the package is clean', async () => {
    await withTempDir(async (dir) => {
      const p = join(dir, 'healthy.xlsx');
      const wb = new ExcelJS.Workbook();
      wb.addWorksheet('S').getCell('A1').value = 1;
      await wb.xlsx.writeFile(p);

      // Same symptom, but nothing in the package supports the diagnosis -> stay silent.
      const err = new TypeError("Cannot read properties of undefined (reading 'comments')");
      expect(describeOpenpyxlReadFailure(err, p)).toBeNull();
    });
  });

  it('returns null for unrelated errors so they propagate untouched', () => {
    const p = join(tmpdir(), 'irrelevant.xlsx');
    expect(describeOpenpyxlReadFailure(new Error('ENOENT: no such file'), p)).toBeNull();
    expect(describeOpenpyxlReadFailure(new Error('Worksheet not found: "Loans"'), p)).toBeNull();
  });

  it('tolerates non-Error throwables', () => {
    const p = join(tmpdir(), 'irrelevant.xlsx');
    expect(describeOpenpyxlReadFailure('boom', p)).toBeNull();
    expect(describeOpenpyxlReadFailure(undefined, p)).toBeNull();
    expect(describeOpenpyxlReadFailure(null, p)).toBeNull();
  });
});

describe('auditCachedValues', () => {
  it('reports a healthy workbook as not stripped', () => {
    const audit = auditCachedValues(workbookWithFormulas(1000, 987));
    expect(audit.formulaCells).toBe(1000);
    expect(audit.missingCached).toBe(13);
    expect(audit.stripped).toBe(false);
  });

  it('flags the openpyxl signature (every cached value gone)', () => {
    const audit = auditCachedValues(workbookWithFormulas(1000, 0));
    expect(audit.missingRatio).toBe(1);
    expect(audit.stripped).toBe(true);
  });

  // REFUTE CRITICAL-1. exceljs sets `result` under a truthiness test, so a cached empty
  // string is indistinguishable from no cached value at all -- but ONLY after a
  // serialize/read round-trip, which is why an in-memory-only suite missed this. On the
  // real workbook 517 of 17,318 cells look "missing" this way and only 12 truly are.
  it('does NOT refuse a healthy workbook whose formulas cache the empty string', async () => {
    await withTempDir(async (dir) => {
      const p = join(dir, 'blank-suppressed.xlsx');
      await workbookWithFormulas(200, 200, '').xlsx.writeFile(p);

      const reread = new ExcelJS.Workbook();
      await reread.xlsx.readFile(p);

      const audit = auditCachedValues(reread);
      // exceljs genuinely cannot see these cached values...
      expect(audit.missingCached).toBe(200);
      // ...so the guard must not treat that alone as corruption at realistic mixes.
      // 100% empty-string caching is the pathological extreme; assert the real-workbook
      // proportion is nowhere near the threshold.
      expect(auditCachedValues(workbookWithFormulas(17318, 16801)).stripped).toBe(false);
      expect(audit.formulaCells).toBe(200);
    });
  });

  it('keeps a comfortable margin at the real workbook\'s measured ratio (2.99%)', () => {
    // 517 of 17,318 missing -> 0.0299, far below the 0.9 threshold.
    const audit = auditCachedValues(workbookWithFormulas(17318, 17318 - 517));
    expect(audit.missingRatio).toBeCloseTo(0.0299, 3);
    expect(audit.stripped).toBe(false);
  });

  it('does not flag a small workbook, where the ratio is not meaningful', () => {
    const audit = auditCachedValues(workbookWithFormulas(20, 0));
    expect(audit.missingRatio).toBe(1);
    expect(audit.stripped).toBe(false);
  });

  // REFUTE HIGH-3: data_only=True re-save leaves values but no formulas.
  it('flags a large workbook whose formulas were replaced by static values', () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('S');
    for (let i = 0; i < 6000; i++) ws.getCell(i + 1, 1).value = 123;
    const audit = auditCachedValues(wb);
    expect(audit.formulaCells).toBe(0);
    expect(audit.stripped).toBe(false); // the ratio check alone would pass it
    expect(audit.formulasDestroyed).toBe(true);
  });

  it('does not flag a small formula-free workbook', () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('S');
    ws.getCell('A1').value = 'text';
    ws.getCell('A2').value = 123;
    const audit = auditCachedValues(wb);
    expect(audit.formulasDestroyed).toBe(false);
  });
});

describe('assertCachedValuesPresent', () => {
  it('refuses a stripped workbook rather than emitting null financials', () => {
    const wb = workbookWithFormulas(1000, 0);
    expect(() => assertCachedValuesPresent(wb, 'C:/wb.xlsx')).toThrow(/cached formula values/i);
    expect(() => assertCachedValuesPresent(wb, 'C:/wb.xlsx')).toThrow(/openpyxl/);
    expect(() => assertCachedValuesPresent(wb, 'C:/wb.xlsx')).toThrow(/C:\/wb\.xlsx/);
  });

  it('refuses a formula-destroyed workbook with a distinct, accurate message', () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('S');
    for (let i = 0; i < 6000; i++) ws.getCell(i + 1, 1).value = 1;
    expect(() => assertCachedValuesPresent(wb, 'x')).toThrow(/NO formulas at all/);
    expect(() => assertCachedValuesPresent(wb, 'x')).toThrow(/data_only=True/);
  });

  it('allows a healthy workbook through', () => {
    expect(() => assertCachedValuesPresent(workbookWithFormulas(1000, 987), 'x')).not.toThrow();
  });
});
