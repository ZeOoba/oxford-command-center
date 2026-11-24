// server/ar/mapping-cache-basis.ts: which lease roster scripts/reconcile.ts checks the AR mapping cache
// against. A synthetic stand-in cache (pseudonymous lease ids that can never resolve against the real
// workbook) is checked against the synthetic snapshot instead; every other reading, and any cache that is
// not positively the stand-in (every id in the committed synthetic roster), keeps the real-workbook check.
// Temp roots only; no real data.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cacheCheckBasis,
  checkMappingCache,
  classifyCacheCheck,
  runCacheCheck,
  type ReadState,
} from '../../server/ar/mapping-cache-basis';

const CACHE = 'data/ar-mapping-cache.json';
const SNAP = 'data/snapshots/portfolio.json';
const MARKER = 'data/.synthetic-seeded.json';
const FIX_CACHE = '{"entries":{"synthetic co":"lease-a"}}';
const FIX_SNAP = '{"leases":[{"id":"lease-a"},{"id":"lease-b"}]}';
const roots: string[] = [];

function put(root: string, rel: string, body: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

/** A root whose manifest covers the cache and the snapshot, each with a synthetic stand-in. */
function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'cache-basis-'));
  roots.push(root);
  put(root, 'scripts/fixtures/real-data-manifest.json', JSON.stringify({ files: [CACHE, SNAP], dirs: [] }));
  put(root, `fixtures/synthetic/${CACHE}`, FIX_CACHE);
  put(root, `fixtures/synthetic/${SNAP}`, FIX_SNAP);
  return root;
}

/** A test-seeded root: both stand-ins copied in and listed in the seed marker. */
function seededRoot(): string {
  const root = makeRoot();
  put(root, CACHE, FIX_CACHE);
  put(root, SNAP, FIX_SNAP);
  put(root, MARKER, JSON.stringify({ seeded: [CACHE, SNAP] }));
  return root;
}

const cache = (entries: Record<string, string>) => ({ entries, savedAt: '2026-01-01T00:00:00Z' });

afterEach(() => {
  vi.unstubAllEnvs();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe('cacheCheckBasis', () => {
  const states: ReadState[] = ['absent', 'synthetic', 'real', 'unknown'];

  it('keeps the real-workbook check for every cell except synthetic/synthetic and synthetic/absent', () => {
    for (const c of states) {
      for (const s of states) {
        const expected = c === 'synthetic' && s === 'synthetic' ? 'synthetic-snapshot' : c === 'synthetic' && s === 'absent' ? 'skip' : 'workbook';
        expect([c, s, cacheCheckBasis(c, s)]).toEqual([c, s, expected]);
      }
    }
  });
});

describe('classifyCacheCheck', () => {
  it('checks a seeded cache against the seeded snapshot, even after both diverged from their stand-ins', () => {
    const root = seededRoot();
    expect(classifyCacheCheck(root, {})).toBe('synthetic-snapshot');
    put(root, CACHE, '{"entries":{"other co":"lease-z"}}');
    put(root, SNAP, '{"leases":[{"id":"lease-z"}]}');
    expect(classifyCacheCheck(root, {})).toBe('synthetic-snapshot');
  });

  it('reads byte-identical copies as synthetic without a marker', () => {
    const root = makeRoot();
    put(root, CACHE, FIX_CACHE);
    put(root, SNAP, FIX_SNAP);
    expect(classifyCacheCheck(root, {})).toBe('synthetic-snapshot');
  });

  it('keeps the workbook check for a fixture-identical cache beside a real snapshot and no marker (mixed checkout)', () => {
    const root = makeRoot();
    put(root, CACHE, FIX_CACHE);
    put(root, SNAP, '{"leases":[{"id":"real-1"}]}');
    expect(classifyCacheCheck(root, {})).toBe('workbook');
  });

  it('keeps the workbook check when the marker lists only the cache and the snapshot is real', () => {
    const root = makeRoot();
    put(root, CACHE, FIX_CACHE);
    put(root, SNAP, '{"leases":[{"id":"real-1"}]}');
    put(root, MARKER, JSON.stringify({ seeded: [CACHE] }));
    expect(classifyCacheCheck(root, {})).toBe('workbook');
  });

  it('skips a synthetic cache only when there is no snapshot at all', () => {
    const root = makeRoot();
    put(root, CACHE, FIX_CACHE);
    expect(classifyCacheCheck(root, {})).toBe('skip');
  });

  it('keeps the workbook check for a real cache', () => {
    const root = makeRoot();
    put(root, CACHE, '{"entries":{"real co":"real-1"}}');
    put(root, SNAP, FIX_SNAP);
    expect(classifyCacheCheck(root, {})).toBe('workbook');
  });

  it('keeps the workbook check when the seed marker or the manifest is unreadable', () => {
    const root = seededRoot();
    put(root, MARKER, '{not json');
    expect(classifyCacheCheck(root, {})).toBe('workbook');
    const bare = mkdtempSync(join(tmpdir(), 'cache-basis-'));
    roots.push(bare);
    put(bare, CACHE, FIX_CACHE);
    expect(classifyCacheCheck(bare, {})).toBe('workbook');
  });

  it('classifies the AR_MAPPING_CACHE file, matching in-repo spellings case- and slash-insensitively', () => {
    const root = seededRoot();
    expect(classifyCacheCheck(root, { AR_MAPPING_CACHE: CACHE })).toBe('synthetic-snapshot');
    expect(classifyCacheCheck(root, { AR_MAPPING_CACHE: './data//ar-mapping-cache.json' })).toBe('synthetic-snapshot');
    expect(classifyCacheCheck(root, { AR_MAPPING_CACHE: join(root, CACHE) })).toBe('synthetic-snapshot');
    expect(classifyCacheCheck(root, { AR_MAPPING_CACHE: 'DATA\\AR-Mapping-Cache.json' })).toBe('synthetic-snapshot');
  });

  it('keeps the workbook check for an override outside the repo, at the root, or at an in-repo path no manifest entry covers', () => {
    const root = seededRoot();
    const outside = mkdtempSync(join(tmpdir(), 'cache-basis-out-'));
    roots.push(outside);
    put(outside, 'cache.json', FIX_CACHE);
    expect(classifyCacheCheck(root, { AR_MAPPING_CACHE: join(outside, 'cache.json') })).toBe('workbook');
    expect(classifyCacheCheck(root, { AR_MAPPING_CACHE: '' })).toBe('workbook');
    expect(classifyCacheCheck(root, { AR_MAPPING_CACHE: '.' })).toBe('workbook');
    put(root, 'data/other-cache.json', FIX_CACHE);
    expect(classifyCacheCheck(root, { AR_MAPPING_CACHE: 'data/other-cache.json' })).toBe('workbook');
  });
});

describe('runCacheCheck', () => {
  it('checks against the workbook roster on the workbook basis, and counts a dangling entry as a failure', () => {
    const root = makeRoot();
    put(root, SNAP, '{"leases":[{"id":"lease-snap"}]}');
    const ok = runCacheCheck('workbook', ['lease-wb'], cache({ 'a co': 'lease-wb', 'b co': 'SKIP' }), root);
    expect(ok).toEqual({ failed: false, lines: [expect.stringMatching(/^✓ PASS {2}AR mapping cache resolves +0 dangling$/)] });
    const bad = runCacheCheck('workbook', ['lease-wb'], cache({ 'a co': 'lease-snap' }), root);
    expect(bad.failed).toBe(true);
    expect(bad.lines).toHaveLength(2);
    expect(bad.lines[0]).toMatch(/^✗ FAIL {2}AR mapping cache resolves +1 dangling$/);
    expect(bad.lines[1]).toContain('a co → lease-snap');
  });

  it('checks a stand-in cache against the synthetic snapshot roster, not the workbook, on the synthetic basis', () => {
    const root = makeRoot();
    // The committed stand-in roster has lease-a and lease-b; the snapshot in use has only lease-a.
    put(root, SNAP, '{"leases":[{"id":"lease-a"}]}');
    const ok = runCacheCheck('synthetic-snapshot', ['lease-wb'], cache({ 'a co': 'lease-a', 'z co': 'SKIP' }), root);
    expect(ok).toEqual({ failed: false, lines: [expect.stringMatching(/^✓ PASS {2}AR mapping cache resolves \(synthetic\) +0 dangling$/)] });
    const bad = runCacheCheck('synthetic-snapshot', ['lease-wb'], cache({ 'a co': 'lease-a', 'b co': 'lease-b' }), root);
    expect(bad.failed).toBe(true);
    expect(bad.lines[0]).toMatch(/^✗ FAIL {2}AR mapping cache resolves \(synthetic\) +1 dangling$/);
  });

  it('turns a missing or torn synthetic snapshot into a FAIL line instead of throwing', () => {
    const root = makeRoot();
    const missing = runCacheCheck('synthetic-snapshot', [], cache({}), root);
    expect(missing).toEqual({ failed: true, lines: [expect.stringMatching(/^✗ FAIL .*synthetic snapshot unreadable: /)] });
    put(root, SNAP, '{"leases": [');
    expect(runCacheCheck('synthetic-snapshot', [], cache({}), root).lines[0]).toMatch(/synthetic snapshot unreadable/);
    put(root, SNAP, '{"leases":[null]}');
    expect(runCacheCheck('synthetic-snapshot', [], cache({}), root).failed).toBe(true);
  });

  it('skips without failing on the skip basis only for a positively stand-in cache', () => {
    const root = makeRoot();
    expect(runCacheCheck('skip', ['lease-wb'], cache({ 'a co': 'lease-a', 'z co': 'SKIP' }), root)).toEqual({
      failed: false,
      lines: [expect.stringMatching(/^– SKIP {2}AR mapping cache resolves /)],
    });
    const notStandIn = runCacheCheck('skip', ['lease-wb'], cache({ 'a co': 'nowhere' }), root);
    expect(notStandIn.failed).toBe(true);
    expect(notStandIn.lines[0]).toMatch(/^✗ FAIL {2}AR mapping cache resolves +1 dangling$/);
  });

  it('falls back to the workbook check for any cache that is not positively the stand-in, whatever the basis says', () => {
    // Real files restored over a seeded worktree before the marker is moved away: the marker still
    // reads both as synthetic, but the cache holds real ids. A stale entry must fail as it does on the
    // workbook basis, not pass against the restored snapshot's roster — including when EVERY id is
    // stale (none the workbook knows), e.g. after a re-key.
    const root = makeRoot();
    put(root, SNAP, '{"leases":[{"id":"real-1"},{"id":"real-stale"},{"id":"real-gone"}]}');
    const oneStale = cache({ 'real co': 'real-1', 'old co': 'real-stale', 'gone co': 'SKIP' });
    const allStale = cache({ 'old co': 'real-stale', 'gone co': 'real-gone', 'skip co': 'SKIP' });
    for (const basis of ['synthetic-snapshot', 'skip'] as const) {
      const one = runCacheCheck(basis, ['real-1'], oneStale, root);
      expect(one.failed).toBe(true);
      expect(one.lines[0]).toMatch(/^✗ FAIL {2}AR mapping cache resolves +1 dangling$/);
      const all = runCacheCheck(basis, ['real-1'], allStale, root);
      expect(all.failed).toBe(true);
      expect(all.lines[0]).toMatch(/^✗ FAIL {2}AR mapping cache resolves +2 dangling$/);
    }
    // A cache mixing a stand-in id with a real one is not the stand-in either.
    expect(runCacheCheck('synthetic-snapshot', ['real-1'], cache({ 'a co': 'lease-a', 'real co': 'real-1' }), root).lines[0]).toMatch(
      /^✗ FAIL {2}AR mapping cache resolves +1 dangling$/,
    );
    expect(runCacheCheck('synthetic-snapshot', ['real-1'], cache({ 'real co': 'real-1' }), root)).toEqual({
      failed: false,
      lines: [expect.stringMatching(/^✓ PASS {2}AR mapping cache resolves +0 dangling$/)],
    });
  });

  it('keeps the workbook check when the committed stand-in roster is unreadable', () => {
    const root = makeRoot();
    put(root, SNAP, FIX_SNAP);
    put(root, `fixtures/synthetic/${SNAP}`, '{not json');
    const r = runCacheCheck('synthetic-snapshot', ['real-1'], cache({ 'a co': 'lease-a' }), root);
    expect(r.failed).toBe(true);
    expect(r.lines[0]).toMatch(/^✗ FAIL {2}AR mapping cache resolves +1 dangling$/);
  });

  it('fails, never throws and never skips, on a malformed cache on every basis', () => {
    const root = makeRoot();
    put(root, SNAP, FIX_SNAP);
    // { entries: ['lease-a'] } is an array of stand-in ids: it must still not count as the stand-in.
    const malformed = [null, {}, { entries: null }, { entries: [] }, { entries: ['lease-a'] }, { entries: 'x' }, { entries: { a: 5 } }];
    for (const bad of malformed) {
      for (const basis of ['workbook', 'synthetic-snapshot', 'skip'] as const) {
        const r = runCacheCheck(basis, ['lease-a'], bad as never, root);
        expect([JSON.stringify(bad), basis, r.failed]).toEqual([JSON.stringify(bad), basis, true]);
        expect(r.lines[0]).toMatch(/^✗ FAIL {2}AR mapping cache resolves +\d+ dangling$/);
      }
    }
  });
});

describe('checkMappingCache', () => {
  it('passes a seeded worktree against its synthetic snapshot', () => {
    const root = seededRoot();
    const r = checkMappingCache(root, ['real-1'], cache({ 'synthetic co': 'lease-a' }), {});
    expect(r).toEqual({ failed: false, lines: [expect.stringMatching(/^✓ PASS {2}AR mapping cache resolves \(synthetic\) +0 dangling$/)] });
  });

  it('fails a seeded worktree whose stand-in cache dangles against its synthetic snapshot', () => {
    const root = seededRoot();
    put(root, SNAP, '{"leases":[{"id":"lease-a"}]}');
    const r = checkMappingCache(root, ['real-1'], cache({ 'synthetic co': 'lease-a', 'other co': 'lease-b' }), {});
    expect(r.failed).toBe(true);
    expect(r.lines[0]).toMatch(/^✗ FAIL {2}AR mapping cache resolves \(synthetic\) +1 dangling$/);
  });

  it('classifies with the env it is given: an out-of-repo AR_MAPPING_CACHE on a seeded root keeps the workbook check', () => {
    const root = seededRoot();
    const outside = mkdtempSync(join(tmpdir(), 'cache-basis-out-'));
    roots.push(outside);
    put(outside, 'cache.json', FIX_CACHE);
    const env = { AR_MAPPING_CACHE: join(outside, 'cache.json') };
    const r = checkMappingCache(root, ['real-1'], cache({ 'x co': 'lease-a' }), env);
    expect(r.failed).toBe(true);
    expect(r.lines[0]).toMatch(/^✗ FAIL {2}AR mapping cache resolves +1 dangling$/);
    expect(checkMappingCache(root, ['real-1'], cache({ 'x co': 'lease-a' }), {}).failed).toBe(false);
  });

  it('reads process.env by default, as reconcile calls it (no env argument)', () => {
    const root = seededRoot();
    const outside = mkdtempSync(join(tmpdir(), 'cache-basis-out-'));
    roots.push(outside);
    put(outside, 'cache.json', FIX_CACHE);
    vi.stubEnv('AR_MAPPING_CACHE', join(outside, 'cache.json'));
    const r = checkMappingCache(root, ['real-1'], cache({ 'x co': 'lease-a' }));
    expect(r.failed).toBe(true);
    expect(r.lines[0]).toMatch(/^✗ FAIL {2}AR mapping cache resolves +1 dangling$/);
    vi.unstubAllEnvs();
    vi.stubEnv('AR_MAPPING_CACHE', undefined);
    expect(checkMappingCache(root, ['real-1'], cache({ 'x co': 'lease-a' })).failed).toBe(false);
  });

  it('fails a mixed checkout (stand-in cache, real snapshot, no marker) against the workbook', () => {
    const root = makeRoot();
    put(root, CACHE, FIX_CACHE);
    put(root, SNAP, '{"leases":[{"id":"real-1"}]}');
    const r = checkMappingCache(root, ['real-1'], cache({ 'synthetic co': 'lease-a' }), {});
    expect(r.failed).toBe(true);
    expect(r.lines[0]).toMatch(/^✗ FAIL {2}AR mapping cache resolves +1 dangling$/);
  });

  it('fails a restore in progress (real files, marker still present) on a stale real entry', () => {
    const root = seededRoot();
    put(root, CACHE, '{"entries":{"real co":"real-1","old co":"real-stale"}}');
    put(root, SNAP, '{"leases":[{"id":"real-1"},{"id":"real-stale"}]}');
    const r = checkMappingCache(root, ['real-1'], cache({ 'real co': 'real-1', 'old co': 'real-stale' }), {});
    expect(r.failed).toBe(true);
    expect(r.lines[0]).toMatch(/^✗ FAIL {2}AR mapping cache resolves +1 dangling$/);
  });

  it('fails a restore in progress whose real cache ids are ALL stale against the workbook', () => {
    const root = seededRoot();
    put(root, CACHE, '{"entries":{"gone co":"real-gone","skip co":"SKIP"}}');
    put(root, SNAP, '{"leases":[{"id":"real-gone"},{"id":"real-1"}]}');
    const r = checkMappingCache(root, ['real-1'], cache({ 'gone co': 'real-gone', 'skip co': 'SKIP' }), {});
    expect(r.failed).toBe(true);
    expect(r.lines[0]).toMatch(/^✗ FAIL {2}AR mapping cache resolves +1 dangling$/);
  });
});
