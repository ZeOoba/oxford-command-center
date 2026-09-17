// tests/unit/lease-market-cli.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listIntakeFiles } from '../../scripts/lease-market';

describe('listIntakeFiles', () => {
  it('orders exports by date and ignores lock files and other types', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lm-cli-'));
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
});
