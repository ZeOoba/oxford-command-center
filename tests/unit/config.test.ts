import { describe, it, expect, afterEach } from 'vitest';
import { workbookPath, serverPort, snapshotAgeMs, isSnapshotStale } from '../../server/config';

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

describe('snapshotAgeMs / isSnapshotStale — portfolio.json staleness guard', () => {
  it('computes age in ms between now and generatedAt', () => {
    const now = new Date('2026-07-24T12:00:00.000Z').getTime();
    const generatedAt = '2026-07-24T10:00:00.000Z';
    expect(snapshotAgeMs(now, generatedAt)).toBe(2 * 60 * 60 * 1000);
  });

  it('is not stale within the default 6h threshold', () => {
    const now = new Date('2026-07-24T12:00:00.000Z').getTime();
    const generatedAt = '2026-07-24T10:00:00.000Z';
    expect(isSnapshotStale(now, generatedAt)).toBe(false);
  });

  it('is stale past the default 6h threshold', () => {
    const now = new Date('2026-07-24T12:00:00.000Z').getTime();
    const generatedAt = '2026-07-24T05:00:00.000Z'; // 7h old
    expect(isSnapshotStale(now, generatedAt)).toBe(true);
  });

  it('respects a custom threshold', () => {
    const now = new Date('2026-07-24T12:00:00.000Z').getTime();
    const generatedAt = '2026-07-24T11:00:00.000Z'; // 1h old
    expect(isSnapshotStale(now, generatedAt, 30 * 60 * 1000)).toBe(true); // 30min threshold
  });

  it('treats an unparseable generatedAt as stale (fail loud, not silent)', () => {
    const now = new Date('2026-07-24T12:00:00.000Z').getTime();
    expect(isSnapshotStale(now, 'not-a-date')).toBe(true);
  });
});
