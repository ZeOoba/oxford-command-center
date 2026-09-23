// @vitest-environment node
//
// Every synchronous rename in server/ and scripts/ goes through renameSyncWithRetry (server/lib/
// rename-retry.ts), so a Windows antivirus / indexer / OneDrive transient lock (EPERM/EBUSY/EACCES)
// on a temp+rename atomic write is retried instead of failing the writer (gate flake 2026-09-23;
// PRs #365/#367). The retry behaviour itself is covered in alerts-store.test.ts.
//
// Two checks:
//   1. a static guard -- no bare renameSync( call outside the helper -- which pins the two CLI
//      writers whose rename sits deep inside main() (extract-workbook.ts, lease-snapshot-drift-
//      check.ts) and catches the next new writer that forgets the retry;
//   2. a behaviour check on server/warehouse/backup.ts writeManifest through a pass-through spy.
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type * as RenameRetryModule from '../../server/lib/rename-retry';

vi.mock('../../server/lib/rename-retry', async (importOriginal) => {
  const actual = await importOriginal<typeof RenameRetryModule>();
  return { ...actual, renameSyncWithRetry: vi.fn(actual.renameSyncWithRetry) };
});

const { renameSyncWithRetry } = await import('../../server/lib/rename-retry');
const { writeManifest } = await import('../../server/warehouse/backup');

const ROOTS = ['server', 'scripts'];
const SOURCE_EXT = /\.(ts|mts|cts|mjs|cjs|js)$/;
const HELPER = 'server/lib/rename-retry.ts';

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (SOURCE_EXT.test(entry) && !entry.endsWith('.d.ts') && !entry.endsWith('.d.mts')) out.push(full);
  }
  return out;
}

describe('rename call sites', () => {
  it('no bare renameSync( call in server/ or scripts/ outside the retry helper', () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of sourceFiles(root)) {
        const rel = relative('.', file).replace(/\\/g, '/');
        if (rel === HELPER) continue;
        readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
          const code = line.trim();
          if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return;
          if (/\brenameSync\s*\(/.test(code)) offenders.push(`${rel}:${i + 1}: ${code}`);
        });
      }
    }
    expect(offenders).toEqual([]);
  });

  it('writeManifest publishes manifest.json through the retry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'manifest-retry-'));
    try {
      const manifest = { latest: 'finance-x.sqlite.enc', at: '2026-09-23T00:00:00.000Z', bytes: 1, tables: 1, counts: { t: 1 } };
      writeManifest(dir, manifest);
      const finalPath = join(dir, 'manifest.json');
      expect(vi.mocked(renameSyncWithRetry)).toHaveBeenCalledWith(`${finalPath}.tmp`, finalPath);
      expect(JSON.parse(readFileSync(finalPath, 'utf8'))).toEqual(manifest);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
