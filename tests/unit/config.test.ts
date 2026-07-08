import { describe, it, expect, afterEach } from 'vitest';
import { workbookPath } from '../../server/config';

describe('workbookPath()', () => {
  const original = process.env.WORKBOOK_PATH;

  afterEach(() => {
    if (original === undefined) delete process.env.WORKBOOK_PATH;
    else process.env.WORKBOOK_PATH = original;
  });

  it('re-reads process.env.WORKBOOK_PATH on every call, not just at module import time', () => {
    delete process.env.WORKBOOK_PATH;
    const before = workbookPath(); // establishes the module was already imported with no override

    process.env.WORKBOOK_PATH = '/tmp/late-set-override.xlsx';
    expect(workbookPath()).toBe('/tmp/late-set-override.xlsx');
    expect(workbookPath()).not.toBe(before);
  });

  it('falls back to the OneDrive default path when unset', () => {
    delete process.env.WORKBOOK_PATH;
    expect(workbookPath()).toContain('Master Excel Template Company Wide -- Oxford.xlsx');
  });
});
