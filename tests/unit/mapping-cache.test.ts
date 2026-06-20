import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadCache, saveCache, cacheKey, type MappingCache } from '../../server/ar/mapping-cache';

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ora-cache-'));
  process.env.AR_MAPPING_CACHE = join(tmpDir, 'mapping-cache.json');
});
afterEach(() => {
  delete process.env.AR_MAPPING_CACHE;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('cacheKey', () => {
  it('normalizes to the same key as the matcher (lowercased, entity-suffix-stripped)', () => {
    expect(cacheKey('Acme Industrial, LLC')).toBe('acme industrial');
    expect(cacheKey('FOXWELL, LOUIS W.')).toBe('louis w foxwell');
  });
  it('is stable across case/whitespace variations of the same name', () => {
    expect(cacheKey('Building Bridges Therapy')).toBe(cacheKey('building bridges therapy'));
  });
});

describe('loadCache', () => {
  it('returns an empty cache when no file exists', () => {
    const c = loadCache();
    expect(c.entries).toEqual({});
  });
  it('reads previously written entries', () => {
    const data: MappingCache = { entries: { 'acme industrial': 'l-acme-001' }, savedAt: '2026-06-20T00:00:00Z' };
    writeFileSync(process.env.AR_MAPPING_CACHE!, JSON.stringify(data));
    expect(loadCache().entries['acme industrial']).toBe('l-acme-001');
  });
  it('returns empty on corrupt file (never throws)', () => {
    writeFileSync(process.env.AR_MAPPING_CACHE!, 'not json {{{{');
    expect(loadCache().entries).toEqual({});
  });
});

describe('saveCache', () => {
  it('persists entries and updates savedAt', async () => {
    const cache: MappingCache = { entries: { 'bravo tenant': 'l-bravo' }, savedAt: '' };
    await saveCache(cache);
    const reloaded = loadCache();
    expect(reloaded.entries['bravo tenant']).toBe('l-bravo');
    expect(reloaded.savedAt).toBeTruthy();
  });
  it('round-trips SKIP entries', async () => {
    const cache: MappingCache = { entries: { 'echo credit': 'SKIP' }, savedAt: '' };
    await saveCache(cache);
    expect(loadCache().entries['echo credit']).toBe('SKIP');
  });
});
