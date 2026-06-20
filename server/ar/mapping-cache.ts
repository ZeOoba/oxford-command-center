// server/ar/mapping-cache.ts
//
// Persistent cache for confirmed tenant-name → Lease.id mappings (review-then-write flow).
// Once a name is confirmed (or manually corrected) in the import review, it is stored here
// so subsequent imports of the same PM export don't re-prompt for the same name.
// Cache is keyed by normalized(tenantName) so minor whitespace/case variations still hit.
//
// Storage: data/ar-mapping-cache.json (gitignored — local operational state, not source).
// Never written unless the import script explicitly calls save() after a confirmed session.

import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const DEFAULT_PATH = join(process.cwd(), 'data', 'ar-mapping-cache.json');

function cachePath(): string {
  return process.env.AR_MAPPING_CACHE ?? DEFAULT_PATH;
}

/** Stable cache key: lowercased + punctuation-normalized but entity suffixes KEPT.
 *  normalizeTokens() strips 'llc'/'inc' etc., which collapses 'Apex LLC' and 'Apex Inc' to the
 *  same key — the cache-hit branch skips review entirely, so a collision silently mis-attributes
 *  one tenant's delinquency to another's lease across import runs. */
export function cacheKey(rawName: string): string {
  return rawName.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').trim().replace(/\s+/g, ' ');
}

export interface MappingCache {
  /** normalizedName → leaseId. 'SKIP' means user explicitly chose to omit this tenant. */
  entries: Record<string, string>;
  /** ISO timestamp of last save, for staleness awareness. */
  savedAt: string;
}

export function loadCache(): MappingCache {
  try {
    if (existsSync(cachePath())) {
      return JSON.parse(readFileSync(cachePath(), 'utf8')) as MappingCache;
    }
  } catch {
    /* corrupt or missing → start fresh */
  }
  return { entries: {}, savedAt: new Date().toISOString() };
}

export async function saveCache(cache: MappingCache): Promise<void> {
  const updated: MappingCache = { ...cache, savedAt: new Date().toISOString() };
  await mkdir(dirname(cachePath()), { recursive: true });
  await writeFile(cachePath(), JSON.stringify(updated, null, 2));
}
