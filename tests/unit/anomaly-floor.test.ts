import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateAnomalyFloor, loadPreviousLeaseIds } from '../../server/anomaly-floor';

/**
 * Pure unit tests for the lease-count anomaly floor shared by Brain.refresh() (server/brain.ts)
 * and, once fix/extract-workbook-anomaly-floor merges, the CLI regen scripts. Mirrors the
 * thresholds already reviewed there (0-lease unconditional refuse; >25% removed refuse) minus
 * the CLI's --force parameter, which has no live-server equivalent.
 */
describe('evaluateAnomalyFloor', () => {
  it('refuses a 0-lease parse even when the previous count was also 0 (no realistic all-zero portfolio)', () => {
    const result = evaluateAnomalyFloor(0, 0, 0);
    expect(result.refuse).toBe(true);
  });

  it('refuses a 0-lease parse when the previous snapshot had leases', () => {
    const result = evaluateAnomalyFloor(140, 0, 140);
    expect(result.refuse).toBe(true);
    if (result.refuse) {
      expect(result.reason).toContain('0-lease');
      expect(result.reason).toContain('140');
    }
  });

  it('refuses when more than 25% of the previous set would be removed', () => {
    const result = evaluateAnomalyFloor(4, 1, 3); // 75% removed
    expect(result.refuse).toBe(true);
    if (result.refuse) expect(result.reason).toContain('75.0%');
  });

  it('does NOT refuse at exactly the 25% boundary', () => {
    const result = evaluateAnomalyFloor(4, 3, 1); // exactly 25% removed
    expect(result.refuse).toBe(false);
  });

  it('does NOT refuse a normal parse (leases added, none removed)', () => {
    const result = evaluateAnomalyFloor(140, 141, 0);
    expect(result.refuse).toBe(false);
  });

  it('does NOT refuse when there was no previous baseline at all (fresh deployment)', () => {
    const result = evaluateAnomalyFloor(0, 5, 0);
    expect(result.refuse).toBe(false);
  });
});

describe('loadPreviousLeaseIds', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('returns an empty, non-corrupt baseline when the file does not exist (normal first run)', () => {
    dir = mkdtempSync(join(tmpdir(), 'anomaly-floor-test-'));
    const result = loadPreviousLeaseIds(join(dir, 'nope.json'));
    expect(result.ids.size).toBe(0);
    expect(result.corrupt).toBe(false);
  });

  it('returns an empty set AND flags corrupt when the file is corrupt JSON (never throws)', () => {
    dir = mkdtempSync(join(tmpdir(), 'anomaly-floor-test-'));
    const path = join(dir, 'portfolio.json');
    writeFileSync(path, '{ this is not valid json');
    const result = loadPreviousLeaseIds(path);
    expect(result.ids.size).toBe(0);
    expect(result.corrupt).toBe(true);
  });

  it('returns an empty set AND flags corrupt when the file parses but has no leases array', () => {
    dir = mkdtempSync(join(tmpdir(), 'anomaly-floor-test-'));
    const path = join(dir, 'portfolio.json');
    writeFileSync(path, JSON.stringify({ deals: [] }));
    const result = loadPreviousLeaseIds(path);
    expect(result.ids.size).toBe(0);
    expect(result.corrupt).toBe(true);
  });

  it('reads lease ids from a valid snapshot file (not corrupt)', () => {
    dir = mkdtempSync(join(tmpdir(), 'anomaly-floor-test-'));
    const path = join(dir, 'portfolio.json');
    writeFileSync(path, JSON.stringify({ leases: [{ id: 'l1' }, { id: 'l2' }] }));
    const result = loadPreviousLeaseIds(path);
    expect(result.ids).toEqual(new Set(['l1', 'l2']));
    expect(result.corrupt).toBe(false);
  });

  it('ignores lease entries with a non-string id', () => {
    dir = mkdtempSync(join(tmpdir(), 'anomaly-floor-test-'));
    const path = join(dir, 'portfolio.json');
    writeFileSync(path, JSON.stringify({ leases: [{ id: 'l1' }, { id: 42 }, {}] }));
    const result = loadPreviousLeaseIds(path);
    expect(result.ids).toEqual(new Set(['l1']));
    expect(result.corrupt).toBe(false);
  });
});
