// tests/unit/lease-market-cli.test.ts
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as IngestModule from '../../server/warehouse/lease-market/ingest';

// `ingest()` opens a warehouse and calls ingestCostarListingsFile per file — both are mocked so the
// per-file-failure tests below never touch disk beyond the throwaway intake dir, and never risk
// resolving to the real data/warehouse/finance.sqlite.
vi.mock('../../server/warehouse/db', () => ({
  openWarehouse: vi.fn(() => ({ close: vi.fn() })),
}));
vi.mock('../../server/warehouse/lease-market/ingest', async (importOriginal) => {
  const actual = await importOriginal<typeof IngestModule>();
  return { ...actual, ingestCostarListingsFile: vi.fn() };
});

import { ingest, listIntakeFiles, parseArgs } from '../../scripts/lease-market';
import { ingestCostarListingsFile } from '../../server/warehouse/lease-market/ingest';
import { CostarParseError } from '../../server/warehouse/lease-market/costar-parse';

const tmpDirs: string[] = [];
function mkTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lm-cli-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('listIntakeFiles', () => {
  it('orders exports by date and ignores lock files and other types', () => {
    const dir = mkTmp();
    for (const f of ['costar-listings_columbus_2026-03-01.xlsx', 'costar-listings_columbus_2026-01-01.xlsx', '~$lock.xlsx', 'notes.txt', 'Export.csv']) {
      writeFileSync(join(dir, f), 'x');
    }
    const feb = new Date('2026-02-01T12:00:00Z');
    utimesSync(join(dir, 'Export.csv'), feb, feb);
    expect(listIntakeFiles(dir)).toEqual([
      'costar-listings_columbus_2026-01-01.xlsx',
      'Export.csv',
      'costar-listings_columbus_2026-03-01.xlsx',
    ]);
  });

  it('includes uppercase .XLSX extensions', () => {
    const dir = mkTmp();
    writeFileSync(join(dir, 'costar-listings_columbus_2026-01-01.XLSX'), 'x');
    expect(listIntakeFiles(dir)).toEqual(['costar-listings_columbus_2026-01-01.XLSX']);
  });

  it('excludes Excel lock files (~$ prefix)', () => {
    const dir = mkTmp();
    writeFileSync(join(dir, 'costar-listings_columbus_2026-01-01.xlsx'), 'x');
    writeFileSync(join(dir, '~$costar-listings_columbus_2026-01-01.xlsx'), 'x');
    expect(listIntakeFiles(dir)).toEqual(['costar-listings_columbus_2026-01-01.xlsx']);
  });

  it('breaks a same-date tie by plain code-point order, not localeCompare', () => {
    // 'Zebra.csv' < 'apple.csv' by code point (uppercase sorts before lowercase) but
    // localeCompare (case-insensitive-ish alphabetical) would order 'apple.csv' first —
    // this discriminates between the two implementations.
    const dir = mkTmp();
    writeFileSync(join(dir, 'Zebra.csv'), 'x');
    writeFileSync(join(dir, 'apple.csv'), 'x');
    const same = new Date(2026, 2, 1, 10, 0);
    utimesSync(join(dir, 'Zebra.csv'), same, same);
    utimesSync(join(dir, 'apple.csv'), same, same);
    expect(listIntakeFiles(dir)).toEqual(['Zebra.csv', 'apple.csv']);
  });

  it('uses the LOCAL calendar date for the mtime fallback, not the UTC date (matches ingest.ts localDateString) — late-evening case, catches the bug west of UTC', () => {
    // 2026-02-14 23:30 in LOCAL time. On a host west of UTC this is already 2026-02-15 in UTC,
    // so a UTC-based fallback would tie/overtake the named 2026-02-14 export below; the local-date
    // fallback keeps it same-day, so it sorts first on the code-point name tie-break ('E' < 'c').
    const dir = mkTmp();
    writeFileSync(join(dir, 'costar-listings_columbus_2026-02-14.xlsx'), 'x');
    writeFileSync(join(dir, 'Export.csv'), 'x');
    const lateLocal = new Date(2026, 1, 14, 23, 30);
    utimesSync(join(dir, 'Export.csv'), lateLocal, lateLocal);
    expect(listIntakeFiles(dir)).toEqual(['Export.csv', 'costar-listings_columbus_2026-02-14.xlsx']);
  });

  it('uses the LOCAL calendar date for the mtime fallback, not the UTC date — early-morning case (00:30), catches the bug east of UTC too', () => {
    // 2026-06-15 00:30 in LOCAL time. On a host EAST of UTC this is still 2026-06-14 in UTC, so a
    // UTC-based fallback would roll BACKWARD a day relative to the named 2026-06-15 export below
    // (no tie, chronological order puts the named file first); the local-date fallback ties on
    // 2026-06-15 and the name tie-break ('E' < 'c') puts Export.csv first, regardless of host offset.
    const dir = mkTmp();
    writeFileSync(join(dir, 'costar-listings_columbus_2026-06-15.xlsx'), 'x');
    writeFileSync(join(dir, 'Export.csv'), 'x');
    const earlyLocal = new Date(2026, 5, 15, 0, 30);
    utimesSync(join(dir, 'Export.csv'), earlyLocal, earlyLocal);
    expect(listIntakeFiles(dir)).toEqual(['Export.csv', 'costar-listings_columbus_2026-06-15.xlsx']);
  });
});

describe('parseArgs', () => {
  it('ingest with no --dir', () => {
    expect(parseArgs(['ingest'])).toEqual({ command: 'ingest', dir: undefined });
  });

  it('ingest with --dir <path> (space form)', () => {
    expect(parseArgs(['ingest', '--dir', '/some/path'])).toEqual({ command: 'ingest', dir: '/some/path' });
  });

  it('ingest with --dir=<path> (equals form)', () => {
    expect(parseArgs(['ingest', '--dir=/p'])).toEqual({ command: 'ingest', dir: '/p' });
  });

  it('ingest with --dir as the last arg (no value) is invalid', () => {
    expect(parseArgs(['ingest', '--dir'])).toMatchObject({ command: 'invalid' });
  });

  it('ingest with --dir followed by another flag is invalid (never silently falls back)', () => {
    expect(parseArgs(['ingest', '--dir', '--as-of'])).toMatchObject({ command: 'invalid' });
  });

  it('ingest with a stray positional is invalid', () => {
    expect(parseArgs(['ingest', '/p'])).toMatchObject({ command: 'invalid' });
  });

  it('ingest with the OTHER command\'s flag (--as-of) is invalid', () => {
    expect(parseArgs(['ingest', '--as-of', '2026-01-01'])).toMatchObject({ command: 'invalid' });
  });

  it('ingest with a repeated --dir is invalid', () => {
    expect(parseArgs(['ingest', '--dir', '/p', '--dir', '/q'])).toMatchObject({ command: 'invalid' });
  });

  it('ingest with a repeated --dir= (equals form) is invalid', () => {
    expect(parseArgs(['ingest', '--dir=/p', '--dir=/q'])).toMatchObject({ command: 'invalid' });
  });

  it('ingest with --dir= empty value is invalid', () => {
    expect(parseArgs(['ingest', '--dir='])).toMatchObject({ command: 'invalid' });
  });

  it('compute with no --as-of', () => {
    expect(parseArgs(['compute'])).toEqual({ command: 'compute', asOf: undefined });
  });

  it('compute with a valid --as-of (space form)', () => {
    expect(parseArgs(['compute', '--as-of', '2026-03-01'])).toEqual({ command: 'compute', asOf: '2026-03-01' });
  });

  it('compute with a valid --as-of=<date> (equals form)', () => {
    expect(parseArgs(['compute', '--as-of=2026-03-01'])).toEqual({ command: 'compute', asOf: '2026-03-01' });
  });

  it('compute with --as-of as the last arg (no value) is invalid', () => {
    expect(parseArgs(['compute', '--as-of'])).toMatchObject({ command: 'invalid' });
  });

  it('compute with --as-of followed by another flag is invalid', () => {
    expect(parseArgs(['compute', '--as-of', '--dir'])).toMatchObject({ command: 'invalid' });
  });

  it('compute with a malformed --as-of (not YYYY-MM-DD) is invalid', () => {
    expect(parseArgs(['compute', '--as-of', '03-01-2026'])).toMatchObject({ command: 'invalid' });
  });

  it('compute with an --as-of that is not a real calendar date is invalid', () => {
    expect(parseArgs(['compute', '--as-of', '2026-02-30'])).toMatchObject({ command: 'invalid' });
  });

  it('compute with a misspelled flag (--asof) is invalid', () => {
    expect(parseArgs(['compute', '--asof', '2026-03-01'])).toMatchObject({ command: 'invalid' });
  });

  it('compute with a repeated --as-of is invalid', () => {
    expect(parseArgs(['compute', '--as-of', '2026-03-01', '--as-of', '2026-04-01'])).toMatchObject({ command: 'invalid' });
  });

  it('compute with the OTHER command\'s flag (--dir) is invalid', () => {
    expect(parseArgs(['compute', '--dir', 'x'])).toMatchObject({ command: 'invalid' });
  });

  it('compute with --as-of= empty value is invalid', () => {
    expect(parseArgs(['compute', '--as-of='])).toMatchObject({ command: 'invalid' });
  });

  it('unknown command is invalid', () => {
    expect(parseArgs(['bogus'])).toMatchObject({ command: 'invalid' });
  });

  it('no command is invalid', () => {
    expect(parseArgs([])).toMatchObject({ command: 'invalid' });
  });
});

describe('ingest() per-file failure handling', () => {
  it('stops the loop on the first thrown per-file error, logs via console.error with the stack, reports not-attempted in the summary, exit 1', async () => {
    const dir = mkTmp();
    writeFileSync(join(dir, 'costar-listings_columbus_2026-01-01.xlsx'), 'x');
    writeFileSync(join(dir, 'costar-listings_columbus_2026-01-02.xlsx'), 'x');

    const mocked = vi.mocked(ingestCostarListingsFile);
    mocked.mockReset();
    mocked.mockRejectedValueOnce(new Error('boom'));

    const errorLogs: unknown[] = [];
    const plainLogs: unknown[] = [];
    const errSpy = vi.spyOn(console, 'error').mockImplementation((msg?: unknown) => {
      errorLogs.push(msg);
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => {
      plainLogs.push(msg);
    });
    let code: number;
    try {
      code = await ingest(dir);
    } finally {
      errSpy.mockRestore();
      logSpy.mockRestore();
    }

    expect(code).toBe(1);
    // Second file must never be attempted -- the loop stops on the first throw.
    expect(mocked).toHaveBeenCalledTimes(1);
    expect(errorLogs).toHaveLength(1);
    const failureLine = String(errorLogs[0]);
    expect(failureLine).toContain('failed costar-listings_columbus_2026-01-01.xlsx | ERROR: boom');
    // A plain Error (not CostarParseError) gets its stack appended.
    expect(failureLine).toContain('Error: boom');
    expect(failureLine.split('\n').length).toBeGreaterThan(1);
    // Total discovered (2) minus attempted (1) = 1 not attempted.
    expect(plainLogs).toEqual(['2 file(s), 1 failed, 1 not attempted.']);
  });

  it('a CostarParseError failure logs via console.error WITHOUT a stack trace (expected, already-descriptive error class)', async () => {
    const dir = mkTmp();
    writeFileSync(join(dir, 'costar-listings_columbus_2026-01-01.xlsx'), 'x');

    const mocked = vi.mocked(ingestCostarListingsFile);
    mocked.mockReset();
    mocked.mockRejectedValueOnce(new CostarParseError('bad header map'));

    const errorLogs: unknown[] = [];
    const errSpy = vi.spyOn(console, 'error').mockImplementation((msg?: unknown) => {
      errorLogs.push(msg);
    });
    try {
      await ingest(dir);
    } finally {
      errSpy.mockRestore();
    }

    expect(errorLogs).toEqual(['failed costar-listings_columbus_2026-01-01.xlsx | ERROR: bad header map']);
  });

  it('reports 0 not-attempted when every discovered file is attempted (no early stop)', async () => {
    const dir = mkTmp();
    writeFileSync(join(dir, 'costar-listings_columbus_2026-01-01.xlsx'), 'x');

    const mocked = vi.mocked(ingestCostarListingsFile);
    mocked.mockReset();
    mocked.mockResolvedValueOnce({
      file: 'costar-listings_columbus_2026-01-01.xlsx', status: 'ingested', landingId: 1, marketId: 'columbus',
      exportDate: '2026-01-01', completeness: 'complete', partialReason: null, insertedSpaces: 0, updatedSpaces: 0,
      newProperties: 0, skipped: 0, markedMissing: 0, markedRemoved: 0,
      events: { new: 0, returned: 0, price_cut: 0, price_increase: 0, sf_change: 0, dom_reset: 0, missing: 0, removed: 0 },
      error: null,
    });

    const plainLogs: unknown[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => {
      plainLogs.push(msg);
    });
    let code: number;
    try {
      code = await ingest(dir);
    } finally {
      logSpy.mockRestore();
    }

    expect(code).toBe(0);
    expect(plainLogs[plainLogs.length - 1]).toBe('1 file(s), 0 failed.');
  });
});
