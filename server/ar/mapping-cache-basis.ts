// server/ar/mapping-cache-basis.ts
//
// Which lease roster scripts/reconcile.ts checks the AR mapping cache against. The workbook it parses
// is always the real one, but a test-seeded worktree (scripts/ensure-local-data.ts) holds the synthetic
// stand-in cache, whose lease ids are pseudonyms of the synthetic snapshot: checked against the real
// workbook it can only fail, saying nothing about either file. So a synthetic cache is checked against
// the synthetic snapshot instead (which still catches a build-synthetic-data regression that leaves the
// stand-in's links dangling), and skipped only when no synthetic snapshot is there to check it against.
// Every reading other than a positive 'synthetic' keeps the real-workbook check (the strict side).
import { readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileState, type FileState } from '../real-data-status';
import { validateMappingCache, type MappingCache } from './mapping-cache';

export const CACHE_REL = 'data/ar-mapping-cache.json';
export const SNAPSHOT_REL = 'data/snapshots/portfolio.json';

export type ReadState = FileState | 'unknown';
export type CacheCheckBasis = 'workbook' | 'synthetic-snapshot' | 'skip';

/** fileState with a throw (unreadable manifest or seed marker) read as 'unknown'. */
export function readState(root: string, rel: string): ReadState {
  try {
    return fileState(root, rel);
  } catch {
    return 'unknown';
  }
}

/** The state of the cache file loadCache() actually reads: AR_MAPPING_CACHE when set (as
 *  mapping-cache.ts's cachePath does), else <root>/data/ar-mapping-cache.json. A path outside the
 *  repo can't be matched to a stand-in, so it reads as 'real' and keeps the workbook check. */
export function cacheFileState(root: string, env: NodeJS.ProcessEnv = process.env): ReadState {
  const override = env['AR_MAPPING_CACHE'];
  if (override === undefined) return readState(root, CACHE_REL);
  const rel = relative(resolve(root), resolve(root, override));
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return 'real';
  return readState(root, rel);
}

/** Only a positive synthetic cache leaves the real-workbook check. */
export function cacheCheckBasis(cache: ReadState, snapshot: ReadState): CacheCheckBasis {
  if (cache !== 'synthetic') return 'workbook';
  return snapshot === 'synthetic' ? 'synthetic-snapshot' : 'skip';
}

export interface CacheCheckResult {
  /** Printed lines: the status line, then one per dangling entry. */
  lines: string[];
  /** True when the check counts as a reconcile failure. */
  failed: boolean;
}

const LABEL = 'AR mapping cache resolves';

/** The whole reconcile check for one basis. Never throws: the synthetic snapshot is re-read here,
 *  after classification, so a restore or regen that moves or tears it in between becomes a FAIL line
 *  naming the read error and the remaining reconcile checks still run. */
export function runCacheCheck(
  basis: CacheCheckBasis,
  workbookLeaseIds: readonly string[],
  cache: MappingCache,
  root: string,
): CacheCheckResult {
  if (basis === 'skip') {
    return { lines: [`– SKIP  ${LABEL.padEnd(42)} synthetic stand-in cache, no synthetic snapshot to check it against`], failed: false };
  }
  const label = basis === 'workbook' ? LABEL : `${LABEL} (synthetic)`;
  let roster: readonly string[];
  if (basis === 'workbook') {
    roster = workbookLeaseIds;
  } else {
    try {
      const snap = JSON.parse(readFileSync(join(root, SNAPSHOT_REL), 'utf8')) as { leases?: Array<{ id?: unknown }> };
      roster = (snap.leases ?? []).map((l) => String(l.id));
    } catch (e) {
      return { lines: [`✗ FAIL  ${label.padEnd(42)} synthetic snapshot unreadable: ${(e as Error).message}`], failed: true };
    }
  }
  const flags = validateMappingCache(cache, new Set(roster));
  const ok = flags.length === 0;
  return {
    lines: [`${ok ? '✓ PASS' : '✗ FAIL'}  ${label.padEnd(42)} ${flags.length} dangling`, ...flags.map((f) => `         ${f.field} → ${f.rawValue}: ${f.issue}`)],
    failed: !ok,
  };
}
