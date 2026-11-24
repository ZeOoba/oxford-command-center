// server/ar/mapping-cache-basis.ts
//
// Which lease roster scripts/reconcile.ts checks the AR mapping cache against. The workbook it parses
// is always the real one, but a test-seeded worktree (scripts/ensure-local-data.ts) holds the synthetic
// stand-in cache, whose lease ids are pseudonyms of the synthetic snapshot: checked against the real
// workbook it can only fail, saying nothing about either file. So a synthetic cache is checked against
// the synthetic snapshot instead (which still catches a build-synthetic-data regression that leaves the
// stand-in's links dangling), and skipped only when there is no snapshot at all to check it against.
// Every other reading keeps the real-workbook check (the strict side).
import { readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileState, normPath, realDataStatus, type FileState, type PathStatus } from '../real-data-status';
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

/** The repo-relative path of the cache file loadCache() actually reads: AR_MAPPING_CACHE when set
 *  (as mapping-cache.ts's cachePath does), else data/ar-mapping-cache.json. Null for a path outside
 *  the repo, which can't be matched to a stand-in and so reads as 'real'. */
function cacheRel(root: string, env: NodeJS.ProcessEnv): string | null {
  const override = env['AR_MAPPING_CACHE'];
  if (override === undefined) return CACHE_REL;
  const rel = relative(resolve(root), resolve(root, override));
  return rel === '' || rel.startsWith('..') || isAbsolute(rel) ? null : rel;
}

/** The state of the cache file loadCache() actually reads (see cacheRel). */
export function cacheFileState(root: string, env: NodeJS.ProcessEnv = process.env): ReadState {
  const rel = cacheRel(root, env);
  return rel === null ? 'real' : readState(root, rel);
}

/** Only a positive synthetic cache leaves the real-workbook check, and only when the snapshot is
 *  synthetic too (checked against it) or absent (nothing to check against: skip). A synthetic cache
 *  beside a real or unreadable snapshot is a mixed checkout, e.g. a real cache overwritten by the
 *  stand-in with no seed marker: that keeps the real-workbook check, which fails loudly. */
export function cacheCheckBasis(cache: ReadState, snapshot: ReadState): CacheCheckBasis {
  if (cache !== 'synthetic') return 'workbook';
  if (snapshot === 'synthetic') return 'synthetic-snapshot';
  return snapshot === 'absent' ? 'skip' : 'workbook';
}

/** The basis reconcile uses, from ONE realDataStatus scan, so the cache and the snapshot are read
 *  against the same seed-marker state (a marker moved between two scans can't mismatch them). An
 *  unreadable manifest or marker keeps the real-workbook check. */
export function classifyCacheCheck(root: string, env: NodeJS.ProcessEnv = process.env): CacheCheckBasis {
  let statuses: PathStatus[];
  try {
    statuses = realDataStatus(root);
  } catch {
    return 'workbook';
  }
  const stateOf = (rel: string): FileState => statuses.find((s) => normPath(s.rel) === normPath(rel))?.state ?? 'absent';
  const rel = cacheRel(root, env);
  return cacheCheckBasis(rel === null ? 'real' : stateOf(rel), stateOf(SNAPSHOT_REL));
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
