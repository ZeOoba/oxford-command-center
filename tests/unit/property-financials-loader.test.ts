// @vitest-environment node
//
// tests/unit/property-financials-loader.test.ts — read-only dataset loader (plan T4; pattern copied
// from tests/unit/edge-loader.test.ts). Fake fs deps for retry/memo/last-good; a real tmpdir copy for
// the no-write guarantees.
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  loadPropertyFinancials,
  resetPropertyFinancialsLoaderCache,
  type PfFsDeps,
} from '../../server/property-financials/loader';
import { loadCsvText, loadDatasetText } from './property-financials-helpers';

const DATA_DIR = resolve(__dirname, '..', '..', 'data', 'property-financials');
const DATASET_TEXT = loadDatasetText();
const CSV_TEXT = loadCsvText();
const NOW = new Date(2026, 9, 5, 12, 0, 0); // local 2026-10-05 noon
const LOADER_SRC = readFileSync(resolve(__dirname, '..', '..', 'server', 'property-financials', 'loader.ts'), 'utf8');
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

function errno(code: string): Error {
  return Object.assign(new Error(`${code}: simulated C:\\secret\\path`), { code });
}

interface FakeOpts {
  dataset?: () => string;
  csv?: () => string;
  stat?: (file: 'dataset.json' | 'monthly-long.csv') => { mtimeMs: number; size: number };
}

function fakeFs(opts: FakeOpts = {}) {
  const calls = { read: { 'dataset.json': 0, 'monthly-long.csv': 0 } as Record<string, number>, sleeps: [] as number[] };
  const text = (f: string) => (f === 'dataset.json' ? (opts.dataset ?? (() => DATASET_TEXT))() : (opts.csv ?? (() => CSV_TEXT))());
  const deps: PfFsDeps = {
    readFile: (path) => {
      const f = basename(path);
      calls.read[f] = (calls.read[f] ?? 0) + 1;
      return Buffer.from(text(f), 'utf8');
    },
    stat: (path) => {
      const f = basename(path) as 'dataset.json' | 'monthly-long.csv';
      if (opts.stat) return opts.stat(f);
      return { mtimeMs: 1, size: f === 'dataset.json' ? DATASET_TEXT.length : CSV_TEXT.length };
    },
    sleep: async (ms) => {
      calls.sleeps.push(ms);
    },
  };
  return { deps, calls };
}

beforeEach(() => resetPropertyFinancialsLoaderCache());

describe('loadPropertyFinancials — happy path', () => {
  it('parses the committed dataset and exposes the data-health meta block', async () => {
    const { deps } = fakeFs();
    const r = await loadPropertyFinancials('mem://happy', NOW, deps);
    expect(r.availability).toBe('ok');
    expect(r.readError).toBeNull();
    expect(r.issues).toEqual([]);
    expect(r.dataset?.meta.version).toBe('v03');
    expect(Object.keys(r.dataset!.properties)).toHaveLength(11);
    expect(r.meta).toEqual({
      version: 'v03',
      generated: '2026-10-05',
      as_of: '2026-09-30',
      basis: 'cash',
      sha256: sha(DATASET_TEXT),
      csvSha256: sha(CSV_TEXT),
      csvError: null,
      ageDays: 5,
      staleness: 'fresh',
      stalenessReason: null,
    });
    expect(r.lastGoodLoadedAt).toBe(NOW.toISOString());
  });

  it('staleness flips from fresh to stale after 45 days past as_of', async () => {
    const { deps } = fakeFs();
    const at45 = await loadPropertyFinancials('mem://stale', new Date(2026, 10, 14, 9), deps);
    expect(at45.meta).toMatchObject({ ageDays: 45, staleness: 'fresh' });
    const at46 = await loadPropertyFinancials('mem://stale', new Date(2026, 10, 15, 9), deps);
    expect(at46.meta).toMatchObject({ ageDays: 46, staleness: 'stale' });
  });

  it('F5: an as_of in the future is STALE with a reason, never fresh forever; one day ahead is clock slack', async () => {
    const { deps } = fakeFs();
    // as_of 2026-09-30; "now" 2026-09-28 -> ageDays -2
    const ahead2 = await loadPropertyFinancials('mem://future', new Date(2026, 8, 28, 9), deps);
    expect(ahead2.meta).toMatchObject({ ageDays: -2, staleness: 'stale', stalenessReason: 'as-of date is in the future' });
    const ahead1 = await loadPropertyFinancials('mem://future', new Date(2026, 8, 29, 9), deps);
    expect(ahead1.meta).toMatchObject({ ageDays: -1, staleness: 'fresh', stalenessReason: null });
    const old = await loadPropertyFinancials('mem://future', new Date(2026, 10, 15, 9), deps);
    expect(old.meta).toMatchObject({ ageDays: 46, staleness: 'stale', stalenessReason: 'as-of date is 46 days old (> 45)' });
  });

  it('a missing CSV is non-fatal: dataset served, csvSha256 null, sanitized csvError', async () => {
    const { deps } = fakeFs();
    const inner = deps.stat;
    deps.stat = (p) => {
      if (basename(p) === 'monthly-long.csv') throw errno('ENOENT');
      return inner(p);
    };
    const r = await loadPropertyFinancials('mem://nocsv', NOW, deps);
    expect(r.availability).toBe('ok');
    expect(r.meta).toMatchObject({ csvSha256: null, csvError: 'monthly-long.csv: stat failed (ENOENT)' });
    expect(JSON.stringify(r)).not.toContain('secret');
  });
});

describe('loadPropertyFinancials — missing / unreadable / invalid', () => {
  it('nonexistent dir → missing, never throws', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'pf-missing-')), 'nope');
    const r = await loadPropertyFinancials(dir, NOW);
    expect(r).toMatchObject({ availability: 'missing', dataset: null, meta: null });
  });

  it('EBUSY twice then OK → succeeds after two 250 ms backoffs', async () => {
    let n = 0;
    const { deps, calls } = fakeFs({
      dataset: () => {
        n += 1;
        if (n <= 2) throw errno('EBUSY');
        return DATASET_TEXT;
      },
    });
    const r = await loadPropertyFinancials('mem://ebusy', NOW, deps);
    expect(r.availability).toBe('ok');
    expect(calls.sleeps).toEqual([250, 250]);
  });

  it('EBUSY on every attempt with no last-good → unreadable; errno code only, no raw message', async () => {
    const { deps, calls } = fakeFs({ dataset: () => { throw errno('EBUSY'); } });
    const r = await loadPropertyFinancials('mem://ebusy-cold', NOW, deps);
    expect(r.availability).toBe('unreadable');
    expect(r.issues[0]).toBe('read failed (EBUSY)');
    expect(calls.read['dataset.json']).toBe(3);
    expect(JSON.stringify(r)).not.toMatch(/simulated|secret/);
  });

  it('truncated JSON cold → unreadable with a fixed message', async () => {
    const { deps } = fakeFs({ dataset: () => DATASET_TEXT.slice(0, 500) });
    const r = await loadPropertyFinancials('mem://trunc', NOW, deps);
    expect(r.availability).toBe('unreadable');
    expect(r.issues).toEqual(['dataset.json is not valid JSON']);
  });

  it('schema drift cold → invalid; issues carry Zod path+code, never the offending value', async () => {
    const bad = JSON.parse(DATASET_TEXT) as { meta: Record<string, unknown> };
    bad.meta.version = 'SECRET-VALUE-123';
    const { deps } = fakeFs({ dataset: () => JSON.stringify(bad) });
    const r = await loadPropertyFinancials('mem://invalid', NOW, deps);
    expect(r.availability).toBe('invalid');
    expect(r.dataset).toBeNull();
    expect(r.issues.join(' ')).toContain('meta.version');
    expect(JSON.stringify(r)).not.toContain('SECRET-VALUE-123');
  });

  it('invalid after a good load → last-good served with a sanitized readError', async () => {
    let mtime = 1;
    let text = DATASET_TEXT;
    const { deps } = fakeFs({
      dataset: () => text,
      stat: (f) => ({ mtimeMs: mtime, size: f === 'dataset.json' ? text.length : CSV_TEXT.length }),
    });
    const first = await loadPropertyFinancials('mem://warm', NOW, deps);
    expect(first.availability).toBe('ok');
    mtime = 2;
    text = JSON.stringify({ ...JSON.parse(DATASET_TEXT), extra: 1 });
    const r = await loadPropertyFinancials('mem://warm', new Date(2026, 9, 5, 13), deps);
    expect(r.availability).toBe('ok');
    expect(r.dataset?.meta.version).toBe('v03');
    expect(r.readError).toContain('failed schema validation');
    expect(r.readError).toContain('unrecognized_keys');
    expect(r.lastGoodLoadedAt).toBe(NOW.toISOString());
  });

  it('ENOENT after a good load → last-good served (OneDrive replace-on-sync)', async () => {
    let gone = false;
    const { deps } = fakeFs();
    const inner = deps.stat;
    deps.stat = (p) => {
      if (gone) throw errno('ENOENT');
      return inner(p);
    };
    await loadPropertyFinancials('mem://gone', NOW, deps);
    gone = true;
    const r = await loadPropertyFinancials('mem://gone', NOW, deps);
    expect(r.availability).toBe('ok');
    expect(r.readError).toBe('stat failed (ENOENT)');
  });

  it('a file replaced mid-read on every cycle → unreadable, never a mismatched (content, key) pair', async () => {
    let tick = 0;
    const { deps } = fakeFs({ stat: (f) => ({ mtimeMs: ++tick, size: f === 'dataset.json' ? DATASET_TEXT.length : 1 }) });
    const r = await loadPropertyFinancials('mem://churn', NOW, deps);
    expect(r.availability).toBe('unreadable');
    expect(r.issues).toEqual(['dataset.json changed while being read']);
  });
});

describe('loadPropertyFinancials — memo', () => {
  it('re-reads only when either file’s mtime or size changes', async () => {
    let dsM = 1;
    let csvM = 1;
    const { deps, calls } = fakeFs({
      stat: (f) => (f === 'dataset.json' ? { mtimeMs: dsM, size: DATASET_TEXT.length } : { mtimeMs: csvM, size: CSV_TEXT.length }),
    });
    await loadPropertyFinancials('mem://memo', NOW, deps);
    await loadPropertyFinancials('mem://memo', NOW, deps);
    expect(calls.read['dataset.json']).toBe(1);
    expect(calls.read['monthly-long.csv']).toBe(1);
    csvM = 2;
    await loadPropertyFinancials('mem://memo', NOW, deps);
    expect(calls.read['monthly-long.csv']).toBe(2);
    dsM = 2;
    await loadPropertyFinancials('mem://memo', NOW, deps);
    expect(calls.read['dataset.json']).toBe(2);
  });

  it('ageDays/staleness are recomputed on a memo hit (clock moves, file does not)', async () => {
    const { deps } = fakeFs();
    await loadPropertyFinancials('mem://clock', NOW, deps);
    const later = await loadPropertyFinancials('mem://clock', new Date(2026, 11, 31, 9), deps);
    expect(later.meta).toMatchObject({ ageDays: 92, staleness: 'stale' });
  });
});

describe('no-write guarantees', () => {
  it('imports only readFileSync/statSync from node:fs and calls no write API', () => {
    expect(LOADER_SRC).toContain("import { readFileSync, statSync } from 'node:fs';");
    expect(LOADER_SRC.match(/from ['"](node:)?fs(\/promises)?['"]/g)).toHaveLength(1);
    expect(LOADER_SRC).not.toMatch(
      /\b(writeFile|writeFileSync|appendFile|appendFileSync|rename|renameSync|unlink|unlinkSync|copyFile|copyFileSync|rmSync|mkdir|mkdirSync|createWriteStream|truncate|truncateSync|openSync)\s*\(/,
    );
  });

  it('leaves dataset.json and monthly-long.csv bytes and mtimes unchanged after a real load', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-nowrite-'));
    for (const f of ['dataset.json', 'monthly-long.csv']) copyFileSync(join(DATA_DIR, f), join(dir, f));
    const before = ['dataset.json', 'monthly-long.csv'].map((f) => statSync(join(dir, f)));
    const r = await loadPropertyFinancials(dir, NOW);
    expect(r.availability).toBe('ok');
    expect(r.meta?.sha256).toBe(sha(readFileSync(join(DATA_DIR, 'dataset.json'))));
    ['dataset.json', 'monthly-long.csv'].forEach((f, i) => {
      const after = statSync(join(dir, f));
      expect(after.mtimeMs).toBe(before[i]!.mtimeMs);
      expect(after.size).toBe(before[i]!.size);
    });
  });
});
