// @vitest-environment node
//
// Every rename in server/ and scripts/ goes through renameSyncWithRetry / renameWithRetry (server/lib/
// rename-retry.ts), so a Windows antivirus / indexer / OneDrive transient lock (EPERM/EBUSY/EACCES)
// on a temp+rename atomic write is retried instead of failing the writer (gate flake 2026-09-23;
// PRs #365/#367/#368). The retry behaviour itself is covered in alerts-store.test.ts and
// rename-retry-async.test.ts.
//
// Checks:
//   1. a static guard -- no raw fs rename call, sync or async, outside the helper -- which pins the
//      writers whose rename sits deep inside main() (extract-workbook.ts, lease-snapshot-drift-
//      check.ts) and catches the next new writer that forgets the retry. The async side is
//      import-aware: `rename(` only counts when that name is bound to fs / fs/promises in the file,
//      so prose, other objects' .rename() and the retry helpers themselves never trip it. The
//      scanner's own fixtures below pin exactly which forms it catches and ignores;
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

const FS_MODULE = String.raw`['"](?:node:)?fs(?:/promises)?['"]`;
const IDENT = String.raw`[A-Za-z_$][\w$]*`;
const isCommentLine = (code: string) => code.startsWith('//') || code.startsWith('*') || code.startsWith('/*');
const escapeRe = (name: string) => name.replace(/[$]/g, '\\$');

/** Local names this source binds to fs's rename: `import { rename, rename as mv } from 'fs...'` and
 *  `const { rename, rename: mv } = require('fs...')`, including multi-line specifier lists. */
function renameBindings(source: string): string[] {
  const names: string[] = [];
  const lists = [
    ...source.matchAll(new RegExp(String.raw`import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*${FS_MODULE}`, 'g')),
    ...source.matchAll(new RegExp(String.raw`\{([^}]*)\}\s*=\s*require\(\s*${FS_MODULE}\s*\)`, 'g')),
  ];
  for (const [, list] of lists) {
    for (const spec of list!.split(',')) {
      const m = spec.trim().match(new RegExp(String.raw`^rename(?:\s*(?:as|:)\s*(${IDENT}))?$`));
      if (m) names.push(m[1] ?? 'rename');
    }
  }
  return names;
}

/** Local names bound to the whole fs / fs/promises module: `import * as fs`, `import fs`, `const fs = require(...)`. */
function moduleBindings(source: string): string[] {
  const patterns = [
    String.raw`import\s*\*\s*as\s*(${IDENT})\s*from\s*${FS_MODULE}`,
    String.raw`import\s+(${IDENT})\s*(?:,\s*\{[^}]*\})?\s*from\s*${FS_MODULE}`,
    String.raw`(?:const|let|var)\s+(${IDENT})\s*=\s*require\(\s*${FS_MODULE}\s*\)`,
  ];
  return patterns.flatMap((p) => [...source.matchAll(new RegExp(p, 'g'))].map((m) => m[1]!));
}

/** Every raw fs rename call in `source` (1-based line numbers), sync or async; comment lines skipped. */
function findRawRenames(source: string): Array<{ line: number; code: string }> {
  const checks = [
    /\brenameSync\s*\(/, // any renameSync(, incl. fs.renameSync(
    /\bpromises\s*\.\s*rename\s*\(/, // fs.promises.rename( / require('fs').promises.rename(
    ...renameBindings(source).map((n) => new RegExp(String.raw`(?<![\w$.])${escapeRe(n)}\s*\(`)),
    ...moduleBindings(source).map((n) => new RegExp(String.raw`(?<![\w$.])${escapeRe(n)}\s*\.\s*rename\s*\(`)),
  ];
  const hits: Array<{ line: number; code: string }> = [];
  source.split('\n').forEach((line, i) => {
    const code = line.trim();
    if (isCommentLine(code)) return;
    if (checks.some((re) => re.test(code))) hits.push({ line: i + 1, code });
  });
  return hits;
}

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

describe('findRawRenames — what the guard catches and ignores', () => {
  const lines = (src: string) => findRawRenames(src).map((h) => h.line);

  it.each([
    ['sync call', `renameSync(a, b);`, [1]],
    ['sync via namespace', `fs.renameSync(a, b);`, [1]],
    ['fs/promises named import', `import { writeFile, rename } from 'node:fs/promises';\nawait rename(tmp, path);`, [2]],
    ['aliased import', `import { rename as mv } from 'fs/promises';\nawait mv(a, b);`, [2]],
    ['multi-line import', `import {\n  mkdir,\n  rename,\n} from 'node:fs/promises';\nawait rename(a, b);`, [5]],
    ['callback rename from node:fs', `import { existsSync, rename } from 'node:fs';\nrename(a, b, cb);`, [2]],
    ['namespace import', `import * as fs from 'node:fs';\nfs.rename(a, b, cb);`, [2]],
    ['namespace .promises', `import * as fs from 'fs';\nawait fs.promises.rename(a, b);`, [2]],
    ['default import', `import fsp from 'node:fs/promises';\nawait fsp.rename(a, b);`, [2]],
    ['require namespace', `const fs = require('fs');\nfs.rename(a, b, cb);`, [2]],
    ['require destructure', `const { rename: mv } = require('node:fs/promises');\nmv(a, b);`, [2]],
    ['inline require().promises', `await require('fs').promises.rename(a, b);`, [1]],
  ])('catches: %s', (_label, src, expected) => {
    expect(lines(src)).toEqual(expected);
  });

  it.each([
    ['prose in a comment', `// rename(tmp, path) is atomic\n * the rename(a, b) below`],
    ['prose in a string', `const msg = 'rename in the workbook to disambiguate';`],
    ['the retry helpers', `import { renameWithRetry, renameSyncWithRetry } from './lib/rename-retry';\nawait renameWithRetry(a, b);\nrenameSyncWithRetry(a, b);`],
    ['another object\'s .rename()', `import { rename } from 'node:fs/promises';\nsheet.rename('Q3');`],
    ['a local rename() with no fs binding', `function rename(x: string) { return x; }\nrename('y');`],
    ['rename imported from a non-fs module', `import { rename } from './columns';\nrename(col);`],
  ])('ignores: %s', (_label, src) => {
    expect(lines(src)).toEqual([]);
  });

  it("flags the helper's own raw renames (so its exemption below is load-bearing)", () => {
    const hits = findRawRenames(readFileSync(HELPER, 'utf8'));
    expect(hits.map((h) => h.code)).toEqual(['renameSync(from, to);', 'await rename(from, to);']);
  });
});

describe('rename call sites', () => {
  it('no raw fs rename call, sync or async, in server/ or scripts/ outside the retry helper', () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of sourceFiles(root)) {
        const rel = relative('.', file).replace(/\\/g, '/');
        if (rel === HELPER) continue;
        for (const hit of findRawRenames(readFileSync(file, 'utf8'))) offenders.push(`${rel}:${hit.line}: ${hit.code}`);
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
