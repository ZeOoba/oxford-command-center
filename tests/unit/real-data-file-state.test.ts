// fileState (server/real-data-status.ts) and server/ar/mapping-cache-basis.ts: how scripts/reconcile.ts
// picks the roster for the AR mapping-cache check — a synthetic stand-in cache (pseudonymous lease ids
// that can never resolve against the real workbook) is checked against the synthetic snapshot instead.
// Temp roots only; no real data.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fileState } from '../../server/real-data-status';
import { cacheCheckBasis, cacheFileState, classifyCacheCheck, runCacheCheck, type ReadState } from '../../server/ar/mapping-cache-basis';

const CACHE = 'data/ar-mapping-cache.json';
const roots: string[] = [];

function put(root: string, rel: string, body: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'file-state-'));
  roots.push(root);
  put(root, 'scripts/fixtures/real-data-manifest.json', JSON.stringify({ files: [CACHE], dirs: [] }));
  put(root, `fixtures/synthetic/${CACHE}`, '{"entries":{"Synthetic Co":"lease-a"}}');
  return root;
}

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe('fileState', () => {
  it('reads a byte-identical copy of the stand-in as synthetic', () => {
    const root = makeRoot();
    put(root, CACHE, '{"entries":{"Synthetic Co":"lease-a"}}');
    expect(fileState(root, CACHE)).toBe('synthetic');
  });

  it('reads a marker-listed file as synthetic even after it diverged from the stand-in', () => {
    const root = makeRoot();
    put(root, CACHE, '{"entries":{"Other Co":"lease-b"}}');
    put(root, 'data/.synthetic-seeded.json', JSON.stringify({ seeded: [CACHE] }));
    expect(fileState(root, CACHE)).toBe('synthetic');
  });

  it('reads a differing, unlisted file as real', () => {
    const root = makeRoot();
    put(root, CACHE, '{"entries":{"Other Co":"lease-b"}}');
    expect(fileState(root, CACHE)).toBe('real');
  });

  it('reads a missing file as absent, matching the path case- and slash-insensitively', () => {
    const root = makeRoot();
    expect(fileState(root, CACHE)).toBe('absent');
    put(root, CACHE, '{"entries":{"Synthetic Co":"lease-a"}}');
    expect(fileState(root, 'DATA\\AR-Mapping-Cache.json')).toBe('synthetic');
  });

  it('throws when the seed marker is unreadable (reconcile then runs the check)', () => {
    const root = makeRoot();
    put(root, CACHE, '{"entries":{"Other Co":"lease-b"}}');
    put(root, 'data/.synthetic-seeded.json', '{not json');
    expect(() => fileState(root, CACHE)).toThrow();
  });
});

describe('cacheCheckBasis', () => {
  const states: ReadState[] = ['absent', 'synthetic', 'real', 'unknown'];

  it('keeps the real-workbook check for every cell except synthetic/synthetic and synthetic/absent', () => {
    for (const cache of states) {
      for (const snapshot of states) {
        const expected =
          cache === 'synthetic' && snapshot === 'synthetic'
            ? 'synthetic-snapshot'
            : cache === 'synthetic' && snapshot === 'absent'
              ? 'skip'
              : 'workbook';
        expect([cache, snapshot, cacheCheckBasis(cache, snapshot)]).toEqual([cache, snapshot, expected]);
      }
    }
  });
});

describe('classifyCacheCheck', () => {
  const SNAP = 'data/snapshots/portfolio.json';
  const FIX_CACHE = '{"entries":{"Synthetic Co":"lease-a"}}';
  const FIX_SNAP = '{"leases":[{"id":"lease-a"}]}';

  // A root whose manifest covers both files, each with a synthetic stand-in.
  function makeRoot2(): string {
    const root = mkdtempSync(join(tmpdir(), 'file-state-'));
    roots.push(root);
    put(root, 'scripts/fixtures/real-data-manifest.json', JSON.stringify({ files: [CACHE, SNAP], dirs: [] }));
    put(root, `fixtures/synthetic/${CACHE}`, FIX_CACHE);
    put(root, `fixtures/synthetic/${SNAP}`, FIX_SNAP);
    return root;
  }

  it('checks a seeded cache against the seeded snapshot', () => {
    const root = makeRoot2();
    put(root, CACHE, FIX_CACHE);
    put(root, SNAP, '{"leases":[{"id":"lease-a"},{"id":"lease-z"}]}');
    put(root, 'data/.synthetic-seeded.json', JSON.stringify({ seeded: [CACHE, SNAP] }));
    expect(classifyCacheCheck(root, {})).toBe('synthetic-snapshot');
  });

  it('keeps the workbook check for a fixture-identical cache beside a real snapshot and no marker (mixed checkout)', () => {
    const root = makeRoot2();
    put(root, CACHE, FIX_CACHE);
    put(root, SNAP, '{"leases":[{"id":"real-1"}]}');
    expect(classifyCacheCheck(root, {})).toBe('workbook');
  });

  it('skips a synthetic cache only when there is no snapshot at all', () => {
    const root = makeRoot2();
    put(root, CACHE, FIX_CACHE);
    expect(classifyCacheCheck(root, {})).toBe('skip');
  });

  it('keeps the workbook check for a real cache, an out-of-repo override and an unreadable marker', () => {
    const root = makeRoot2();
    put(root, CACHE, '{"entries":{"Real Co":"real-1"}}');
    put(root, SNAP, FIX_SNAP);
    expect(classifyCacheCheck(root, {})).toBe('workbook');
    put(root, CACHE, FIX_CACHE);
    put(root, 'data/.synthetic-seeded.json', JSON.stringify({ seeded: [CACHE, SNAP] }));
    expect(classifyCacheCheck(root, {})).toBe('synthetic-snapshot');
    const outside = mkdtempSync(join(tmpdir(), 'file-state-cache-'));
    roots.push(outside);
    put(outside, 'cache.json', FIX_CACHE);
    expect(classifyCacheCheck(root, { AR_MAPPING_CACHE: join(outside, 'cache.json') })).toBe('workbook');
    put(root, 'data/.synthetic-seeded.json', '{not json');
    expect(classifyCacheCheck(root, {})).toBe('workbook');
  });
});

describe('cacheFileState', () => {
  it('reads <root>/data/ar-mapping-cache.json when AR_MAPPING_CACHE is unset', () => {
    const root = makeRoot();
    put(root, CACHE, '{"entries":{"Synthetic Co":"lease-a"}}');
    expect(cacheFileState(root, {})).toBe('synthetic');
  });

  it('classifies the AR_MAPPING_CACHE file, not the default one', () => {
    const root = makeRoot();
    put(root, CACHE, '{"entries":{"Synthetic Co":"lease-a"}}');
    const outside = mkdtempSync(join(tmpdir(), 'file-state-cache-'));
    roots.push(outside);
    put(outside, 'cache.json', '{"entries":{"Other Co":"lease-b"}}');
    expect(cacheFileState(root, { AR_MAPPING_CACHE: join(outside, 'cache.json') })).toBe('real');
    expect(cacheFileState(root, { AR_MAPPING_CACHE: CACHE })).toBe('synthetic');
    expect(cacheFileState(root, { AR_MAPPING_CACHE: 'data/elsewhere.json' })).toBe('absent');
  });

  it('reads an unreadable seed marker as unknown, which keeps the workbook check', () => {
    const root = makeRoot();
    put(root, CACHE, '{"entries":{"Synthetic Co":"lease-a"}}');
    put(root, 'data/.synthetic-seeded.json', '{not json');
    expect(cacheFileState(root, {})).toBe('unknown');
    expect(cacheCheckBasis(cacheFileState(root, {}), 'synthetic')).toBe('workbook');
    expect(cacheFileState(root, { AR_MAPPING_CACHE: CACHE })).toBe('unknown');
  });
});

describe('runCacheCheck', () => {
  const SNAP = 'data/snapshots/portfolio.json';
  const cache = (entries: Record<string, string>) => ({ entries, savedAt: '2026-01-01T00:00:00Z' });

  it('checks against the workbook roster on the workbook basis, and counts a dangling entry as a failure', () => {
    const root = makeRoot();
    put(root, SNAP, JSON.stringify({ leases: [{ id: 'lease-snap' }] }));
    const ok = runCacheCheck('workbook', ['lease-wb'], cache({ 'a co': 'lease-wb', 'b co': 'SKIP' }), root);
    expect(ok.failed).toBe(false);
    expect(ok.lines).toEqual([expect.stringMatching(/^✓ PASS {2}AR mapping cache resolves +0 dangling$/)]);
    const bad = runCacheCheck('workbook', ['lease-wb'], cache({ 'a co': 'lease-snap' }), root);
    expect(bad.failed).toBe(true);
    expect(bad.lines[0]).toMatch(/^✗ FAIL {2}AR mapping cache resolves +1 dangling$/);
    expect(bad.lines).toHaveLength(2);
    expect(bad.lines[1]).toContain('a co → lease-snap');
  });

  it('checks against the synthetic snapshot roster, not the workbook, on the synthetic basis', () => {
    const root = makeRoot();
    put(root, SNAP, JSON.stringify({ leases: [{ id: 'lease-snap' }] }));
    const ok = runCacheCheck('synthetic-snapshot', ['lease-wb'], cache({ 'a co': 'lease-snap' }), root);
    expect(ok.failed).toBe(false);
    expect(ok.lines[0]).toMatch(/^✓ PASS {2}AR mapping cache resolves \(synthetic\) +0 dangling$/);
    const bad = runCacheCheck('synthetic-snapshot', ['lease-wb'], cache({ 'a co': 'lease-wb' }), root);
    expect(bad.failed).toBe(true);
    expect(bad.lines[0]).toMatch(/^✗ FAIL {2}AR mapping cache resolves \(synthetic\) +1 dangling$/);
  });

  it('turns a missing or torn synthetic snapshot into a FAIL line instead of throwing', () => {
    const root = makeRoot();
    const missing = runCacheCheck('synthetic-snapshot', [], cache({}), root);
    expect(missing.failed).toBe(true);
    expect(missing.lines).toEqual([expect.stringMatching(/^✗ FAIL .*synthetic snapshot unreadable: /)]);
    put(root, SNAP, '{"leases": [');
    const torn = runCacheCheck('synthetic-snapshot', [], cache({}), root);
    expect(torn.failed).toBe(true);
    expect(torn.lines[0]).toMatch(/synthetic snapshot unreadable/);
  });

  it('skips without failing only on the skip basis', () => {
    const root = makeRoot();
    const skip = runCacheCheck('skip', [], cache({ 'a co': 'nowhere' }), root);
    expect(skip).toEqual({ failed: false, lines: [expect.stringMatching(/^– SKIP {2}AR mapping cache resolves /)] });
  });
});
