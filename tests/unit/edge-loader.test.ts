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

describe('loadEdgeDataset — empty list, id sanitizing, last-good edge cases (fix wave)', () => {
  const emptyText = () => {
    const f = JSON.parse(FIXTURE_TEXT) as Record<string, unknown>;
    return JSON.stringify({ ...f, markets: [] });
  };

  it('empty market list with no last-good → invalid, never cached as ok', async () => {
    const { deps } = fakeFs({ text: emptyText });
    const r = await loadEdgeDataset('mem://empty-cold', NOW, deps);
    expect(r.availability).toBe('invalid');
    expect(r.marketCount).toBe(0);
    expect(r.rejectedMarkets).toEqual([]);
    expect(r.issues.length).toBeGreaterThan(0);
  });

  it('empty market list WITH last-good → last-good served, sanitized readError, cache not overwritten', async () => {
    let mtime = 1;
    let text = FIXTURE_TEXT;
    const { deps } = fakeFs({ text: () => text, stat: () => ({ mtimeMs: mtime, size: text.length }) });
    await loadEdgeDataset('mem://empty-warm', NOW, deps);
    mtime = 2;
    text = emptyText();
    const later = new Date('2026-10-02T13:00:00Z');
    const r = await loadEdgeDataset('mem://empty-warm', later, deps);
    expect(r.availability).toBe('ok');
    expect(r.marketCount).toBe(4);
    expect(r.readError).toMatch(/^markets\.json degraded/);
    expect(r.lastGoodLoadedAt).toBe(NOW.toISOString());
    // memo not advanced: a repeat read of the same empty file is still served from last-good
    const again = await loadEdgeDataset('mem://empty-warm', later, deps);
    expect(again.marketCount).toBe(4);
    expect(again.lastGoodLoadedAt).toBe(NOW.toISOString());
  });

  it('echoed market ids are truncated to 64 chars and stripped of non-printables', async () => {
    const f = JSON.parse(FIXTURE_TEXT) as { markets: unknown[] };
    const nasty = `bad\u0000\u001b[31m${'x'.repeat(200)}`;
    f.markets = [{ id: nasty, name: 'Broken' }];
    const { deps } = fakeFs({ text: () => JSON.stringify(f) });
    const r = await loadEdgeDataset('mem://id-sanitize', NOW, deps);
    const id = r.issues.join(' ');
    expect([...id].every((ch) => ch.charCodeAt(0) >= 0x20)).toBe(true);
    const echoed = /market (\S+):/.exec(id)![1]!;
    expect(echoed.length).toBeLessThanOrEqual(64);
  });

  it('last-good + <=50% rejection replaces last-good with the new (partial) set', async () => {
    let mtime = 1;
    let text = FIXTURE_TEXT;
    const { deps } = fakeFs({ text: () => text, stat: () => ({ mtimeMs: mtime, size: text.length }) });
    await loadEdgeDataset('mem://partial-replace', NOW, deps);
    mtime = 2;
    text = withBrokenMarkets(2, 1);
    const later = new Date('2026-10-02T13:00:00Z');
    const r = await loadEdgeDataset('mem://partial-replace', later, deps);
    expect(r.availability).toBe('ok');
    expect(r.marketCount).toBe(2);
    expect(r.rejectedMarkets).toHaveLength(1);
    expect(r.readError).toBeNull();
    expect(r.lastGoodLoadedAt).toBe(later.toISOString());
  });

  it('freshness is recomputed against the new clock when ENOENT serves last-good', async () => {
    let gone = false;
    const { deps } = fakeFs({
      text: () => FIXTURE_TEXT,
      stat: () => {
        if (gone) throw errno('ENOENT');
        return { mtimeMs: Date.parse('2026-07-14T18:38:00Z'), size: FIXTURE_TEXT.length };
      },
    });
    const first = await loadEdgeDataset('mem://enoent-fresh', NOW, deps);
    gone = true;
    const later = new Date('2026-10-12T12:00:00.000Z');
    const r = await loadEdgeDataset('mem://enoent-fresh', later, deps);
    expect(r.readError).toBe('stat failed (ENOENT)');
    expect(r.freshness!.ageDays).toBe(first.freshness!.ageDays + 10);
  });
});

describe('gate-fix F1 — non-finite numbers are quarantined', () => {
  const withLat = (lat: string): string => {
    const f = JSON.parse(FIXTURE_TEXT) as { markets: Array<{ lat: number }> };
    const text = JSON.stringify(f);
    return text.replace(`"lat":${JSON.stringify(f.markets[0]!.lat)}`, `"lat":${lat}`);
  };

  it('lat 1e999 quarantines that market only, with a sanitized reason', async () => {
    const { deps } = fakeFs({ text: () => withLat('1e999') });
    const r = await loadEdgeDataset('mem://inf-lat', NOW, deps);
    expect(r.availability).toBe('ok');
    expect(r.marketCount).toBe(3);
    expect(r.rejectedMarkets).toHaveLength(1);
    expect(r.rejectedMarkets[0]!.id).toBe('columbus');
    expect(r.rejectedMarkets[0]!.reason).toMatch(/^lat: /);
    expect(r.rejectedMarkets[0]!.reason).not.toContain('Infinity');
  });

  it('a series value 1e999 quarantines the market', async () => {
    const f = JSON.parse(FIXTURE_TEXT) as { markets: Array<{ vac: Array<number | null> }> };
    f.markets[0]!.vac[f.markets[0]!.vac.length - 1] = 7777.5;
    const text = JSON.stringify(f).replace('7777.5', '1e999');
    const { deps } = fakeFs({ text: () => text });
    const r = await loadEdgeDataset('mem://inf-series', NOW, deps);
    expect(r.marketCount).toBe(3);
    expect(r.rejectedMarkets.map((x) => x.id)).toEqual(['columbus']);
    expect(r.rejectedMarkets[0]!.reason).toMatch(/^vac\./);
  });
});

describe('gate-fix F2 — duplicate market ids', () => {
  it('first occurrence wins; later duplicate is rejected and not double-counted', async () => {
    const f = JSON.parse(FIXTURE_TEXT) as { markets: unknown[] };
    f.markets.push(f.markets[0]);
    const { deps } = fakeFs({ text: () => JSON.stringify(f) });
    const r = await loadEdgeDataset('mem://dup', NOW, deps);
    expect(r.marketCount).toBe(4);
    expect(r.markets.map((m) => m.id)).toEqual(['columbus', 'indianapolis_south', 'cedar_rapids', 'richmond']);
    expect(r.rejectedMarkets).toEqual([{ id: 'columbus', reason: 'duplicate id' }]);
  });
});

describe('gate-fix F3 — stat/read TOCTOU', () => {
  it('file replaced between the pre-read stat and the read: keyed and timed by the post-read stat', async () => {
    const M1 = Date.parse('2026-09-01T12:00:00Z');
    const M2 = Date.parse('2026-09-30T12:00:00Z');
    const f1 = FIXTURE_TEXT;
    const f2 = FIXTURE_TEXT + '  ';
    let cur = { text: f1, mtimeMs: M1 };
    let reads = 0;
    const deps: EdgeFsDeps = {
      stat: () => ({ mtimeMs: cur.mtimeMs, size: cur.text.length }),
      readFile: () => {
        reads += 1;
        if (reads === 1) {
          cur = { text: f2, mtimeMs: M2 }; // replaced mid-flight
          throw errno('EBUSY');
        }
        return cur.text;
      },
      sleep: async () => {},
    };
    const r = await loadEdgeDataset('mem://toctou', NOW, deps);
    expect(r.freshness?.fileMtime).toBe(new Date(M2).toISOString());
    const before = reads;
    const again = await loadEdgeDataset('mem://toctou', NOW, deps);
    expect(reads).toBe(before); // memo hit under the NEW (mtime,size)
    expect(again.freshness?.fileMtime).toBe(new Date(M2).toISOString());
  });
});

describe('gate-fix F1 — non-finite sub numbers', () => {
  it('a sub with vac 1e999 quarantines the market', async () => {
    const f = JSON.parse(FIXTURE_TEXT) as { markets: Array<{ subs: Array<{ vac: number }> }> };
    const m = f.markets.find((x) => x.subs.length > 0)!;
    m.subs[0]!.vac = 4242.5;
    const { deps } = fakeFs({ text: () => JSON.stringify(f).replace('4242.5', '1e999') });
    const r = await loadEdgeDataset('mem://inf-sub', NOW, deps);
    expect(r.rejectedMarkets).toHaveLength(1);
    expect(r.rejectedMarkets[0]!.reason).toMatch(/^subs\./);
  });
});

describe('fix-pass 3 — A1 last-good is looked up at failure time', () => {
  it('a slow request that started against an older cache serves the NEWER cached set when it fails', async () => {
    const dir = 'mem://a1-interleave';
    let mtime = 1;
    let text = FIXTURE_TEXT;
    let failNextRead = false;
    let releaseSleep: () => void = () => {};
    const gate = new Promise<void>((r) => { releaseSleep = r; });
    let sleepingResolve: () => void = () => {};
    const sleeping = new Promise<void>((r) => { sleepingResolve = r; });
    const deps: EdgeFsDeps = {
      stat: () => ({ mtimeMs: mtime, size: 1000 + mtime }), // size keyed on mtime only: text swaps never look like a replace
      readFile: () => {
        if (failNextRead) {
          failNextRead = false;
          throw errno('EBUSY');
        }
        return text;
      },
      sleep: async () => {
        sleepingResolve();
        await gate;
      },
    };
    // cache = the "09-01" dataset (4 markets)
    const first = await loadEdgeDataset(dir, NOW, deps);
    expect(first.marketCount).toBe(4);

    // request A starts against mtime 2, blocks on EBUSY backoff
    mtime = 2;
    text = withBrokenMarkets(2, 1); // the "09-20" dataset: 2 good markets
    failNextRead = true;
    const a = loadEdgeDataset(dir, NOW, deps);
    await sleeping;

    // request B loads and caches the 09-20 dataset while A sleeps
    const b = await loadEdgeDataset(dir, NOW, deps);
    expect(b.marketCount).toBe(2);

    // the file turns invalid, A wakes and fails
    text = '{ not json';
    releaseSleep();
    const r = await a;
    expect(r.availability).toBe('ok');
    expect(r.marketCount).toBe(2); // the newer cached set, not the 4-market one A started with
    expect(r.readError).toBe('markets.json is not valid JSON');
  });
});

describe('fix-pass 3 — B2/B3 loader invariants', () => {
  it('B2: post-read stat differing from pre-read restarts the cycle even when the read succeeded', async () => {
    const M1 = Date.parse('2026-09-01T12:00:00Z');
    const M2 = Date.parse('2026-09-30T12:00:00Z');
    const f1 = FIXTURE_TEXT;
    const f2 = withBrokenMarkets(2, 0);
    let cur = { text: f1, mtimeMs: M1 };
    let statCalls = 0;
    let reads = 0;
    const deps: EdgeFsDeps = {
      // call 1 = pre-stat (f1), call 2 = post-stat (already f2's), then stable f2
      stat: () => {
        statCalls += 1;
        if (statCalls === 2) cur = { text: f2, mtimeMs: M2 };
        return { mtimeMs: cur.mtimeMs, size: cur.text.length };
      },
      readFile: () => {
        reads += 1;
        return cur.text; // first read returns f1 text successfully
      },
      sleep: async () => {},
    };
    const r = await loadEdgeDataset('mem://b2-recheck', NOW, deps);
    expect(reads).toBe(2); // the cycle restarted
    expect(r.marketCount).toBe(2); // f2 content, not f1's 4 markets
    expect(r.freshness?.fileMtime).toBe(new Date(M2).toISOString());
  });

  it('B3: a degraded load WITH survivors never overwrites last-good, even on a same-mtime reload', async () => {
    const dir = 'mem://b3-survivors';
    let mtime = 1;
    let text = FIXTURE_TEXT;
    const { deps } = fakeFs({ text: () => text, stat: () => ({ mtimeMs: mtime, size: text.length }) });
    const first = await loadEdgeDataset(dir, NOW, deps);
    expect(first.marketCount).toBe(4);
    mtime = 2;
    text = withBrokenMarkets(2, 3); // 60% rejected, 2 survivors
    const later = new Date('2026-10-02T13:00:00Z');
    const r = await loadEdgeDataset(dir, later, deps);
    expect(r.marketCount).toBe(4);
    expect(r.readError).toMatch(/^markets\.json degraded: 3 of 5/);
    // same mtime/size reload: must still be degraded, still the original last-good
    const again = await loadEdgeDataset(dir, later, deps);
    expect(again.readError).not.toBeNull();
    expect(again.marketCount).toBe(4);
    expect(again.lastGoodLoadedAt).toBe(NOW.toISOString());
  });
});

describe('fix-pass 3 — B7 loader gaps', () => {
  it.each(['EPERM', 'EACCES'])('%s on read is retried like EBUSY', async (code) => {
    let n = 0;
    const { deps, calls } = fakeFs({
      text: () => {
        n += 1;
        if (n === 1) throw errno(code);
        return FIXTURE_TEXT;
      },
    });
    const r = await loadEdgeDataset(`mem://retry-${code}`, NOW, deps);
    expect(r.availability).toBe('ok');
    expect(calls.sleeps).toEqual([250]);
  });

  it('memo key includes size: same mtime but different size re-reads', async () => {
    let size = 100;
    const { deps, calls } = fakeFs({ text: () => FIXTURE_TEXT, stat: () => ({ mtimeMs: 5, size }) });
    await loadEdgeDataset('mem://memo-size', NOW, deps);
    await loadEdgeDataset('mem://memo-size', NOW, deps);
    expect(calls.read).toBe(1);
    size = 101;
    await loadEdgeDataset('mem://memo-size', NOW, deps);
    expect(calls.read).toBe(2);
  });

  describe('strict meta', () => {
    const mutate = (fn: (f: { meta: Record<string, unknown> }) => void): string => {
      const f = JSON.parse(FIXTURE_TEXT) as { meta: Record<string, unknown> };
      fn(f);
      return JSON.stringify(f);
    };

    it('an unknown extra key in meta → invalid with a meta. issue', async () => {
      const { deps } = fakeFs({ text: () => mutate((f) => { f.meta.surprise = 1; }) });
      const r = await loadEdgeDataset('mem://strict-meta', NOW, deps);
      expect(r.availability).toBe('invalid');
      expect(r.issues[0]).toMatch(/^meta\./);
    });

    it('an unknown extra key in a fieldMeta entry → invalid with a meta. issue', async () => {
      const { deps } = fakeFs({
        text: () =>
          mutate((f) => {
            const fm = f.meta.fieldMeta as Record<string, Record<string, unknown>>;
            fm.vac!.surprise = true;
          }),
      });
      const r = await loadEdgeDataset('mem://strict-fieldmeta', NOW, deps);
      expect(r.availability).toBe('invalid');
      expect(r.issues[0]).toMatch(/^meta\./);
    });

    it('a malformed pulled string → invalid with a meta. issue', async () => {
      const { deps } = fakeFs({ text: () => mutate((f) => { f.meta.pulled = 'July 14th'; }) });
      const r = await loadEdgeDataset('mem://bad-pulled', NOW, deps);
      expect(r.availability).toBe('invalid');
      expect(r.issues.join(' ')).toMatch(/^meta\.pulled/);
    });
  });
});
