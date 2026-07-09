import { describe, it, expect, afterEach } from 'vitest';
import { workbookPath, serverPort } from '../../server/config';

describe('serverPort()', () => {
  const original = process.env.BRAIN_SERVER_PORT;

  afterEach(() => {
    if (original === undefined) delete process.env.BRAIN_SERVER_PORT;
    else process.env.BRAIN_SERVER_PORT = original;
  });

  it('re-reads process.env.BRAIN_SERVER_PORT on every call, not just at module import time', () => {
    delete process.env.BRAIN_SERVER_PORT;
    const before = serverPort(); // establishes the module was already imported with no override

    process.env.BRAIN_SERVER_PORT = '8930';
    expect(serverPort()).toBe(8930);
    expect(serverPort()).not.toBe(before);
  });

  it('falls back to 8911 when unset', () => {
    delete process.env.BRAIN_SERVER_PORT;
    expect(serverPort()).toBe(8911);
  });
});

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
