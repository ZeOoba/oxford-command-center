// tests/unit/lease-market-cli.test.ts
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as IngestModule from '../../server/warehouse/lease-market/ingest';

// `ingest()` opens a warehouse and calls ingestCostarListingsFile per file — both are mocked so the
// per-file-failure test below never touches disk beyond the throwaway intake dir, and never risks
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

  it('uses the LOCAL calendar date for the mtime fallback, not the UTC date (matches ingest.ts localDateString)', () => {
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
});

describe('parseArgs', () => {
  it('ingest with no --dir', () => {
    expect(parseArgs(['ingest'])).toEqual({ command: 'ingest', dir: undefined });
  });

  it('ingest with --dir <path>', () => {
    expect(parseArgs(['ingest', '--dir', '/some/path'])).toEqual({ command: 'ingest', dir: '/some/path' });
  });

  it('ingest with --dir as the last arg (no value) is invalid', () => {
    expect(parseArgs(['ingest', '--dir'])).toMatchObject({ command: 'invalid' });
  });

  it('ingest with --dir followed by another flag is invalid (never silently falls back)', () => {
    expect(parseArgs(['ingest', '--dir', '--as-of'])).toMatchObject({ command: 'invalid' });
  });

  it('compute with no --as-of', () => {
    expect(parseArgs(['compute'])).toEqual({ command: 'compute', asOf: undefined });
  });

  it('compute with a valid --as-of', () => {
    expect(parseArgs(['compute', '--as-of', '2026-03-01'])).toEqual({ command: 'compute', asOf: '2026-03-01' });
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

  it('unknown command is invalid', () => {
    expect(parseArgs(['bogus'])).toMatchObject({ command: 'invalid' });
  });

  it('no command is invalid', () => {
    expect(parseArgs([])).toMatchObject({ command: 'invalid' });
  });
});

describe('ingest() per-file failure handling', () => {
  it('stops the loop on the first thrown per-file error, still prints the summary line, exit 1', async () => {
    const dir = mkTmp();
    writeFileSync(join(dir, 'costar-listings_columbus_2026-01-01.xlsx'), 'x');
    writeFileSync(join(dir, 'costar-listings_columbus_2026-01-02.xlsx'), 'x');

    const mocked = vi.mocked(ingestCostarListingsFile);
    mocked.mockReset();
    mocked.mockRejectedValueOnce(new Error('boom'));

    const logs: unknown[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => {
      logs.push(msg);
    });
    let code: number;
    try {
      code = await ingest(dir);
    } finally {
      spy.mockRestore();
    }

    expect(code).toBe(1);
    // Second file must never be attempted -- the loop stops on the first throw.
    expect(mocked).toHaveBeenCalledTimes(1);
    expect(logs[0]).toBe('failed costar-listings_columbus_2026-01-01.xlsx | ERROR: boom');
    expect(logs[1]).toBe('2 file(s), 1 failed.');
  });
});
