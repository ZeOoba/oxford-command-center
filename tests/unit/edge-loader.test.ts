// @vitest-environment node
//
// tests/unit/edge-loader.test.ts — read-only loader (spec §4, §9 F5–F8, F14, §10).
// Fake fs deps for retry/memo/last-good; a real tmpdir copy for the no-write guarantees.
import { copyFileSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { EDGE_SERIES, SERIES_UNITS } from '@contracts/edge';
import { loadEdgeDataset, resetEdgeLoaderCache, type EdgeFsDeps, type EdgeLoadResult } from '../../server/edge/loader';

const FIXTURE_PATH = join(__dirname, '..', 'fixtures', 'edge', 'markets.slice.json');
const FIXTURE_TEXT = readFileSync(FIXTURE_PATH, 'utf8');
const NOW = new Date('2026-10-02T12:00:00.000Z');
const LOADER_SRC = readFileSync(resolve(__dirname, '..', '..', 'server', 'edge', 'loader.ts'), 'utf8');

function errno(code: string): Error {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

function fakeFs(opts: { text: () => string; stat?: () => { mtimeMs: number; size: number } }) {
  const calls = { read: 0, sleeps: [] as number[] };
  const deps: EdgeFsDeps = {
    readFile: () => {
      calls.read += 1;
      return opts.text();
    },
    stat: opts.stat ?? (() => ({ mtimeMs: Date.parse('2026-07-14T18:38:00Z'), size: FIXTURE_TEXT.length })),
    sleep: async (ms) => {
      calls.sleeps.push(ms);
    },
  };
  return { deps, calls };
}

const cov = (r: EdgeLoadResult, field: string) => r.coverage.find((c) => c.field === field);

beforeEach(() => resetEdgeLoaderCache());

describe('fixture (F14)', () => {
  it('is synthetic', () => {
    expect((JSON.parse(FIXTURE_TEXT) as { _synthetic?: unknown })._synthetic).toBe(true);
  });

  it('SERIES_UNITS and fieldMeta agree on the series key set', () => {
    const meta = (JSON.parse(FIXTURE_TEXT) as { meta: { fieldMeta: Record<string, unknown> } }).meta;
    expect(Object.keys(meta.fieldMeta).sort()).toEqual(Object.keys(SERIES_UNITS).sort());
    expect(Object.keys(meta.fieldMeta).sort()).toEqual([...EDGE_SERIES].sort());
  });
});

describe('loadEdgeDataset — happy path', () => {
  it('parses the fixture into the reshaped output contract', async () => {
    const { deps } = fakeFs({ text: () => FIXTURE_TEXT });
    const r = await loadEdgeDataset('mem://happy', NOW, deps);
    expect(r.availability).toBe('ok');
    expect(r.marketCount).toBe(4);
    expect(r.markets.map((m) => m.id)).toEqual(['columbus', 'indianapolis_south', 'cedar_rapids', 'richmond']);
    const columbus = r.markets[0]!;
    expect(columbus.series.vac).toEqual({ values: [5.0, 4.5, 4.0, 3.5, 3.0], status: ['actual', 'actual', 'actual', 'actual', 'actual'] });
    expect(r.markets[2]!.subs).toEqual([]);
    expect(r.fieldMeta.hvacPermits).toEqual({
      trueLabel: 'Residential building permits authorized, growth (Census BPS)', isProxy: true, unit: 'pct_yoy',
    });
    expect(r.freshness).toMatchObject({ asOf: '2026-07-14', ageDays: 80, stale: true });
    expect(r.readError).toBeNull();
    expect(r.rejectedMarkets).toEqual([]);
  });

  it('pins coverage against the fixture counts', async () => {
    const { deps } = fakeFs({ text: () => FIXTURE_TEXT });
    const r = await loadEdgeDataset('mem://coverage', NOW, deps);
    expect(cov(r, 'truck')).toMatchObject({ filled: 5, total: 20, byYear: [1, 1, 1, 1, 1], allPlaceholder: false });
    expect(cov(r, 'storage')).toMatchObject({ filled: 0, allPlaceholder: true });
    expect(cov(r, 'trades')!.statusCounts.estimated).toBe(1);
    expect(cov(r, 'inc')).toMatchObject({ filled: 12, byYear: [0, 4, 4, 4, 0] });
    expect(cov(r, 'migration')).toMatchObject({ filled: 12, byYear: [4, 4, 4, 0, 0] });
  });
});

describe('loadEdgeDataset — missing / unreadable / invalid (F5, F6, F7)', () => {
  it('nonexistent dir → missing, never throws', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'edge-missing-')), 'nope');
    const r = await loadEdgeDataset(dir, NOW);
    expect(r).toMatchObject({ availability: 'missing', dir, markets: [], marketCount: 0, freshness: null });
  });

  it('EBUSY twice then OK → succeeds after two 250 ms backoffs', async () => {
    let n = 0;
    const { deps, calls } = fakeFs({
      text: () => {
        n += 1;
        if (n <= 2) throw errno('EBUSY');
        return FIXTURE_TEXT;
      },
    });
    const r = await loadEdgeDataset('mem://ebusy', NOW, deps);
    expect(r.availability).toBe('ok');
    expect(calls.sleeps).toEqual([250, 250]);
  });

  it('EBUSY on every attempt with no last-good → unreadable with the error in issues', async () => {
    const { deps, calls } = fakeFs({ text: () => { throw errno('EBUSY'); } });
    const r = await loadEdgeDataset('mem://ebusy-cold', NOW, deps);
    expect(r.availability).toBe('unreadable');
    expect(r.issues[0]).toContain('EBUSY');
    expect(calls.read).toBe(3);
  });

  it('truncated JSON cold → unreadable', async () => {
    const { deps } = fakeFs({ text: () => FIXTURE_TEXT.slice(0, 500) });
    const r = await loadEdgeDataset('mem://trunc-cold', NOW, deps);
    expect(r.availability).toBe('unreadable');
    expect(r.issues[0]).toContain('not valid JSON');
  });

  it('truncated JSON after a good load → last-good served with readError', async () => {
    let mtime = 1;
    let text = FIXTURE_TEXT;
    const { deps } = fakeFs({ text: () => text, stat: () => ({ mtimeMs: mtime, size: text.length }) });
    const first = await loadEdgeDataset('mem://trunc-warm', NOW, deps);
    expect(first.availability).toBe('ok');
    mtime = 2;
    text = FIXTURE_TEXT.slice(0, 500);
    const r = await loadEdgeDataset('mem://trunc-warm', new Date('2026-10-02T13:00:00Z'), deps);
    expect(r.availability).toBe('ok');
    expect(r.marketCount).toBe(4);
    expect(r.readError).toContain('not valid JSON');
    expect(r.lastGoodLoadedAt).toBe(NOW.toISOString());
  });

  it('meta missing fieldMeta → invalid with at most 5 issues', async () => {
    const broken = JSON.parse(FIXTURE_TEXT) as { meta: Record<string, unknown> };
    delete broken.meta.fieldMeta;
    const { deps } = fakeFs({ text: () => JSON.stringify(broken) });
    const r = await loadEdgeDataset('mem://invalid', NOW, deps);
    expect(r.availability).toBe('invalid');
    expect(r.markets).toEqual([]);
    expect(r.issues.length).toBeGreaterThan(0);
    expect(r.issues.length).toBeLessThanOrEqual(5);
    expect(r.issues.join(' ')).toContain('fieldMeta');
  });

  it('a malformed market is quarantined; the rest are served', async () => {
    const f = JSON.parse(FIXTURE_TEXT) as { markets: unknown[] };
    f.markets.push({ id: 'broken', name: 'Broken' });
    const { deps } = fakeFs({ text: () => JSON.stringify(f) });
    const r = await loadEdgeDataset('mem://quarantine', NOW, deps);
    expect(r.marketCount).toBe(4);
    expect(r.rejectedMarkets).toHaveLength(1);
    expect(r.rejectedMarkets[0]!.id).toBe('broken');
  });

  it('a market whose series length differs from years.length is quarantined', async () => {
    const f = JSON.parse(FIXTURE_TEXT) as { markets: Array<Record<string, unknown>> };
    f.markets.push({ ...f.markets[0]!, id: 'short_years', pop: [1, 2, 3, 4] });
    const { deps } = fakeFs({ text: () => JSON.stringify(f) });
    const r = await loadEdgeDataset('mem://years', NOW, deps);
    expect(r.rejectedMarkets.map((x) => x.id)).toEqual(['short_years']);
    expect(r.rejectedMarkets[0]!.reason).toContain('pop');
  });
});

/** Fixture parsed fresh (clone-safe) with its markets replaced by `n` structurally broken ones. */
function withBrokenMarkets(good: number, broken: number): string {
  const f = JSON.parse(FIXTURE_TEXT) as { markets: unknown[] };
  const goodOnes = f.markets.slice(0, good);
  const bad = Array.from({ length: broken }, (_, i) => ({ id: `broken_${i}`, name: 'Broken' }));
  return JSON.stringify({ ...f, markets: [...goodOnes, ...bad] });
}

describe('loadEdgeDataset — degraded loads fail closed', () => {
  it('all markets quarantined, no last-good → invalid with rejected notes in issues', async () => {
    const { deps } = fakeFs({ text: () => withBrokenMarkets(0, 3) });
    const r = await loadEdgeDataset('mem://allbad-cold', NOW, deps);
    expect(r.availability).toBe('invalid');
    expect(r.markets).toEqual([]);
    expect(r.issues.length).toBeGreaterThan(0);
    expect(r.issues.join(' ')).toContain('broken_0');
  });

  it('all markets quarantined WITH last-good → last-good served, readError set, cache not overwritten', async () => {
    let mtime = 1;
    let text = FIXTURE_TEXT;
    const { deps } = fakeFs({ text: () => text, stat: () => ({ mtimeMs: mtime, size: text.length }) });
    await loadEdgeDataset('mem://allbad-warm', NOW, deps);
    mtime = 2;
    text = withBrokenMarkets(0, 3);
    const later = new Date('2026-10-02T13:00:00Z');
    const r = await loadEdgeDataset('mem://allbad-warm', later, deps);
    expect(r.availability).toBe('ok');
    expect(r.marketCount).toBe(4);
    expect(r.readError).not.toBeNull();
    expect(r.lastGoodLoadedAt).toBe(NOW.toISOString());
    // cache untouched: still serves the good set on a repeat degraded read
    const again = await loadEdgeDataset('mem://allbad-warm', later, deps);
    expect(again.marketCount).toBe(4);
    expect(again.lastGoodLoadedAt).toBe(NOW.toISOString());
    // and a following good load works
    mtime = 3;
    text = FIXTURE_TEXT;
    const good = await loadEdgeDataset('mem://allbad-warm', later, deps);
    expect(good.marketCount).toBe(4);
    expect(good.readError).toBeNull();
    expect(good.lastGoodLoadedAt).toBe(later.toISOString());
  });

  it('more than 50% quarantined → invalid', async () => {
    const { deps } = fakeFs({ text: () => withBrokenMarkets(4, 5) });
    const r = await loadEdgeDataset('mem://majority-bad', NOW, deps);
    expect(r.availability).toBe('invalid');
    expect(r.marketCount).toBe(0);
  });

  it('exactly 50% quarantined → ok with rejectedMarkets', async () => {
    const { deps } = fakeFs({ text: () => withBrokenMarkets(4, 4) });
    const r = await loadEdgeDataset('mem://half-bad', NOW, deps);
    expect(r.availability).toBe('ok');
    expect(r.marketCount).toBe(4);
    expect(r.rejectedMarkets).toHaveLength(4);
  });
});

describe('loadEdgeDataset — sanitized error text', () => {
  const PATHY = 'EBUSY: resource busy, open \'C:\\Users\\Owner\\OneDrive\\markets.json\'';

  it('fs read failure emits errno code + fixed text, never the raw message', async () => {
    const { deps } = fakeFs({ text: () => { throw Object.assign(new Error(PATHY), { code: 'EBUSY' }); } });
    const r = await loadEdgeDataset('mem://san-read', NOW, deps);
    expect(r.availability).toBe('unreadable');
    expect(r.issues).toEqual(['read failed (EBUSY)']);
  });

  it('fs stat failure emits errno code + fixed text', async () => {
    const { deps } = fakeFs({
      text: () => FIXTURE_TEXT,
      stat: () => { throw Object.assign(new Error(PATHY), { code: 'EIO' }); },
    });
    const r = await loadEdgeDataset('mem://san-stat', NOW, deps);
    expect(r.issues).toEqual(['stat failed (EIO)']);
    expect(r.issues.join(' ')).not.toContain('C:');
  });

  it('fs error without a code gets a generic fixed message', async () => {
    const { deps } = fakeFs({ text: () => { throw new Error(PATHY); } });
    const r = await loadEdgeDataset('mem://san-nocode', NOW, deps);
    expect(r.issues.join(' ')).not.toContain('C:');
    expect(r.issues.join(' ')).not.toContain('Owner');
  });

  it('JSON parse failure emits fixed text with no V8 message or file content', async () => {
    const { deps } = fakeFs({ text: () => '{"secret_note":"C:\\\\Users\\\\Owner" oops}' });
    const r = await loadEdgeDataset('mem://san-json', NOW, deps);
    expect(r.availability).toBe('unreadable');
    expect(r.issues).toEqual(['markets.json is not valid JSON']);
    const all = r.issues.join(' ');
    expect(all).not.toContain('Unexpected token');
    expect(all).not.toContain('secret_note');
    expect(all).not.toContain('C:');
    expect(all).not.toContain('"');
  });

  it('JSON parse failure readError (warm) is the fixed text', async () => {
    let mtime = 1;
    let text = FIXTURE_TEXT;
    const { deps } = fakeFs({ text: () => text, stat: () => ({ mtimeMs: mtime, size: text.length }) });
    await loadEdgeDataset('mem://san-json-warm', NOW, deps);
    mtime = 2;
    text = '{"secret_note": oops}';
    const r = await loadEdgeDataset('mem://san-json-warm', NOW, deps);
    expect(r.readError).toBe('markets.json is not valid JSON');
  });

  it('zod issues never echo input values', async () => {
    const f = JSON.parse(FIXTURE_TEXT) as { markets: Array<Record<string, unknown>> };
    f.markets.push({ ...f.markets[0]!, id: 'enumbad', type: 'LEAKY_VALUE_XYZ' });
    const { deps } = fakeFs({ text: () => JSON.stringify(f) });
    const r = await loadEdgeDataset('mem://san-zod', NOW, deps);
    expect(r.rejectedMarkets).toHaveLength(1);
    expect(r.rejectedMarkets[0]!.reason).toContain('type');
    expect(r.rejectedMarkets[0]!.reason).not.toContain('LEAKY_VALUE_XYZ');
  });
});

describe('loadEdgeDataset — transient ENOENT', () => {
  it('ENOENT on read with last-good → last-good served with readError', async () => {
    let mtime = 1;
    let gone = false;
    const { deps } = fakeFs({
      text: () => { if (gone) throw errno('ENOENT'); return FIXTURE_TEXT; },
      stat: () => ({ mtimeMs: mtime, size: FIXTURE_TEXT.length }),
    });
    await loadEdgeDataset('mem://enoent-read-warm', NOW, deps);
    mtime = 2;
    gone = true;
    const r = await loadEdgeDataset('mem://enoent-read-warm', new Date('2026-10-02T13:00:00Z'), deps);
    expect(r.availability).toBe('ok');
    expect(r.marketCount).toBe(4);
    expect(r.readError).toBe('read failed (ENOENT)');
  });

  it('ENOENT on stat with last-good → last-good served with readError', async () => {
    let gone = false;
    const { deps } = fakeFs({
      text: () => FIXTURE_TEXT,
      stat: () => {
        if (gone) throw errno('ENOENT');
        return { mtimeMs: 1, size: FIXTURE_TEXT.length };
      },
    });
    await loadEdgeDataset('mem://enoent-stat-warm', NOW, deps);
    gone = true;
    const r = await loadEdgeDataset('mem://enoent-stat-warm', NOW, deps);
    expect(r.availability).toBe('ok');
    expect(r.marketCount).toBe(4);
    expect(r.readError).toBe('stat failed (ENOENT)');
  });

  it('ENOENT without last-good → missing', async () => {
    const { deps } = fakeFs({ text: () => { throw errno('ENOENT'); } });
    const r = await loadEdgeDataset('mem://enoent-cold-read', NOW, deps);
    expect(r.availability).toBe('missing');
    const { deps: d2 } = fakeFs({ text: () => FIXTURE_TEXT, stat: () => { throw errno('ENOENT'); } });
    const r2 = await loadEdgeDataset('mem://enoent-cold-stat', NOW, d2);
    expect(r2.availability).toBe('missing');
  });
});

describe('loadEdgeDataset — memo', () => {
  it('re-parses only when mtime or size changes', async () => {
    let mtime = 1;
    const { deps, calls } = fakeFs({ text: () => FIXTURE_TEXT, stat: () => ({ mtimeMs: mtime, size: FIXTURE_TEXT.length }) });
    await loadEdgeDataset('mem://memo', NOW, deps);
    await loadEdgeDataset('mem://memo', NOW, deps);
    expect(calls.read).toBe(1);
    mtime = 2;
    await loadEdgeDataset('mem://memo', NOW, deps);
    expect(calls.read).toBe(2);
  });
});

describe('no-write guarantees (F8)', () => {
  it('imports only readFileSync/statSync from node:fs and calls no write API', () => {
    expect(LOADER_SRC).toContain("import { readFileSync, statSync } from 'node:fs';");
    expect(LOADER_SRC.match(/from ['"](node:)?fs(\/promises)?['"]/g)).toHaveLength(1);
    expect(LOADER_SRC).not.toMatch(
      /\b(writeFile|writeFileSync|appendFile|appendFileSync|rename|renameSync|unlink|unlinkSync|copyFile|copyFileSync|rmSync|mkdir|mkdirSync|createWriteStream|truncate|truncateSync)\s*\(/,
    );
  });

  it('leaves markets.json mtime, size and bytes unchanged after a real load', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'edge-nowrite-'));
    const file = join(dir, 'markets.json');
    copyFileSync(FIXTURE_PATH, file);
    const before = statSync(file);
    const r = await loadEdgeDataset(dir, NOW);
    expect(r.availability).toBe('ok');
    const after = statSync(file);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.size).toBe(before.size);
    expect(readFileSync(file, 'utf8')).toBe(FIXTURE_TEXT);
  });
});
