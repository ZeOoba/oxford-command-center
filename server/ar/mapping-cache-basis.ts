// server/ar/mapping-cache-basis.ts
//
// Which lease roster scripts/reconcile.ts checks the AR mapping cache against. The workbook it parses
// is always the real one, but a test-seeded worktree (scripts/ensure-local-data.ts) holds the synthetic
// stand-in cache, whose lease ids are pseudonyms of the synthetic snapshot: checked against the real
// workbook it can only fail, saying nothing about either file. So a synthetic cache is checked against
// the synthetic snapshot instead (which still catches a build-synthetic-data regression that leaves the
// stand-in's links dangling), and skipped only when no synthetic snapshot is there to check it against.
// Every reading other than a positive 'synthetic' keeps the real-workbook check (the strict side).
import { isAbsolute, relative, resolve } from 'node:path';
import { fileState, type FileState } from '../real-data-status';

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
