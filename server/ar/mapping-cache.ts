// server/ar/mapping-cache.ts
//
// Persistent cache for confirmed tenant-name → Lease.id mappings (review-then-write flow).
// Once a name is confirmed (or manually corrected) in the import review, it is stored here
// so subsequent imports of the same PM export don't re-prompt for the same name.
// Cache is keyed by normalized(tenantName) so minor whitespace/case variations still hit.
//
// Storage: data/ar-mapping-cache.json. CORRECTED 2026-08-24 (PR #302 review): this file is
// git-tracked, not gitignored — local operational state that happens to be committed (a durable
// SKIP ruling belongs in version control the same way any other human decision does; see the
// 2026-08-24 integrity-sweep incident this repo's own history records for what an un-persisted
// ruling costs). Never written unless the import script explicitly calls save() after a confirmed
// session, or a session hand-edits it to add a durable SKIP outside a normal import run.

import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { DataQualityFlag } from '../../src/contracts/common';

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

/**
 * Referential integrity of the cache against a lease roster (2026-09-22 weekly sweep, finding 6).
 *
 * Every non-'SKIP' value must be a lease id that exists in `knownLeaseIds` — the FULL snapshot
 * `leases` array, Expired included, i.e. the same wider roster `allLeaseIds` that validates a
 * manually-typed id (a human ruling may deliberately target a dead lease; see
 * parse-snapshot-for-import.ts). A dangling target means a name that USED to auto-attribute now
 * silently cannot: partition-confidence.ts routes the hit to review at import time, but nothing
 * checked the committed file itself, and this file is git-tracked and hand-edited.
 *
 * Pure and non-throwing by contract: it FLAGS (DataQualityFlag, the repo's channel for a bad source
 * value) and never blocks a load — loadCache() stays a bare read so its callers (ar-import.ts,
 * ar-import-headless.ts, seed-ar-mappings.ts) keep working on a stale cache exactly as before.
 * A companion function rather than a widened loadCache() return: saveCache spreads the cache back
 * to disk, so a flags field on MappingCache would be persisted into the JSON. Consumed by
 * scripts/reconcile.ts (gate) — wire it into the importers' logs as a follow-up.
 */
export function validateMappingCache(cache: MappingCache, knownLeaseIds: ReadonlySet<string>): DataQualityFlag[] {
  const entries: unknown = cache?.entries;
  if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) {
    return [
      {
        entity: 'ar-mapping-cache',
        field: 'entries',
        issue: `entries is ${entries === null ? 'null' : Array.isArray(entries) ? 'an array' : typeof entries}, expected an object map — every cache lookup will fail`,
        rawValue: String(entries),
        severity: 'error',
      },
    ];
  }
  const flags: DataQualityFlag[] = [];
  // Own keys only — same Object.hasOwn discipline every lookup site in the AR subsystem applies.
  for (const [key, leaseId] of Object.entries(entries as Record<string, unknown>)) {
    if (leaseId === 'SKIP') continue;
    if (typeof leaseId === 'string' && knownLeaseIds.has(leaseId)) continue;
    flags.push({
      entity: 'ar-mapping-cache',
      field: key,
      issue: `maps to lease id '${String(leaseId)}' which is not in the lease roster — the cached attribution is dangling (lease removed/renamed?) and will route to review instead of writing`,
      rawValue: String(leaseId),
      severity: 'warn',
    });
  }
  return flags;
}

export async function saveCache(cache: MappingCache): Promise<void> {
  const updated: MappingCache = { ...cache, savedAt: new Date().toISOString() };
  await mkdir(dirname(cachePath()), { recursive: true });
  await writeFile(cachePath(), JSON.stringify(updated, null, 2));
}
