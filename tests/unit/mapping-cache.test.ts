import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadCache,
  saveCache,
  cacheKey,
  validateMappingCache,
  type MappingCache,
} from '../../server/ar/mapping-cache';

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
  it('lowercases and normalizes punctuation but keeps entity suffixes', () => {
    // Suffixes are NOT stripped — 'Apex LLC' and 'Apex Inc' must stay distinct.
    expect(cacheKey('Acme Industrial, LLC')).toBe('acme industrial llc');
    expect(cacheKey('FOXWELL, LOUIS W.')).toBe('foxwell louis w');
  });
  it('is stable across case/whitespace variations of the same name', () => {
    expect(cacheKey('Building Bridges Therapy')).toBe(cacheKey('building bridges therapy'));
  });
  it('gives distinct keys for entity-suffix-only-distinct names (no cross-run mis-attribution)', () => {
    expect(cacheKey('Apex, LLC')).not.toBe(cacheKey('Apex Inc'));
    expect(cacheKey('Apex, LLC')).not.toBe(cacheKey('Apex Co'));
    expect(cacheKey('Apex Inc')).not.toBe(cacheKey('Apex Co'));
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

// 2026-09-22 (weekly sweep, finding 6): the cache is git-tracked and hand-editable, and a cache hit
// bypasses name matching entirely — so a non-SKIP entry whose lease id no longer exists in the roster
// is a silent write-to-nowhere waiting to happen (the headless feed routes it to review at import
// time, but nothing checked the committed file itself). validateMappingCache is the pure referential
// check: it FLAGS, it never throws, and it never blocks a load — the flag is a DataQualityFlag so
// scripts/reconcile.ts and any caller can surface it through the existing data-quality channel.
describe('validateMappingCache', () => {
  const roster = new Set(['l-acme-001', 'l-bravo', 'l-expired-007']);

  it('returns no flags when every non-SKIP entry resolves to a lease id in the roster', () => {
    const cache: MappingCache = {
      entries: { 'acme industrial': 'l-acme-001', 'bravo tenant': 'l-bravo', 'echo credit': 'SKIP' },
      savedAt: '',
    };
    expect(validateMappingCache(cache, roster)).toEqual([]);
  });

  it('flags a dangling lease-id target as a warn-severity DataQualityFlag, never throws', () => {
    const cache: MappingCache = {
      entries: { 'acme industrial': 'l-acme-001', 'ghost tenant': 'l-vacated-999' },
      savedAt: '',
    };
    const flags = validateMappingCache(cache, roster);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({
      entity: 'ar-mapping-cache',
      field: 'ghost tenant',
      rawValue: 'l-vacated-999',
      severity: 'warn',
      issue: expect.stringMatching(/l-vacated-999/),
    });
  });

  it('never flags SKIP — a durable human ruling is not a lease id', () => {
    const cache: MappingCache = { entries: { 'echo credit': 'SKIP' }, savedAt: '' };
    expect(validateMappingCache(cache, new Set())).toEqual([]);
  });

  it('accepts an Expired lease id — the roster is the FULL leases array, matching allLeaseIds', () => {
    const cache: MappingCache = { entries: { 'old tenant': 'l-expired-007' }, savedAt: '' };
    expect(validateMappingCache(cache, roster)).toEqual([]);
  });

  it('flags every dangling entry, one flag per entry, in cache order', () => {
    const cache: MappingCache = {
      entries: { a: 'l-dead-1', b: 'l-bravo', c: 'l-dead-2' },
      savedAt: '',
    };
    expect(validateMappingCache(cache, roster).map((f) => f.field)).toEqual(['a', 'c']);
  });

  it('checks own entries only — an inherited key is not a cache mapping', () => {
    const entries = Object.create({ inherited: 'l-dead-proto' }) as Record<string, string>;
    entries['acme industrial'] = 'l-acme-001';
    expect(validateMappingCache({ entries, savedAt: '' }, roster)).toEqual([]);
  });

  it('flags a malformed entries shape instead of throwing (loadCache only guards unparseable JSON)', () => {
    const malformed = { entries: null, savedAt: '' } as unknown as MappingCache;
    const flags = validateMappingCache(malformed, roster);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ entity: 'ar-mapping-cache', field: 'entries', severity: 'error' });
  });
});
