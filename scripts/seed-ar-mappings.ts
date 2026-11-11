/**
 * scripts/seed-ar-mappings.ts
 *
 * One-shot: seed the AR mapping cache with the tenant -> lease mappings confirmed by hand on
 * 2026-08-16, after the P4 Phase 0 Task 1 dry run put them in the review queue.
 *
 * The confirmed table names real tenants and contacts, so it lives in the gitignored local file
 * config/local/ar-seed-mappings.json (real firm data is never tracked, ruling 2026-11-10; the
 * committed copy under fixtures/synthetic/ is a synthetic stand-in). Behavior on the real table is
 * unchanged.
 *
 * Uses the REAL cacheKey()/saveCache() so the keys match exactly what partition-confidence.ts will
 * look up. Hand-normalising the names here would risk an entry that silently never matches.
 *
 * Only mappings corroborated on PROPERTY are seeded — a name match alone is never sufficient. The
 * deliberately-not-seeded cases (a cross-property false match on a shared token, departed tenants
 * reported as uncollected-balance findings, rows held for a closer look) are recorded with the
 * ruling in the local table's notes, not here.
 *
 * Run:  npx tsx scripts/seed-ar-mappings.ts
 */
import { readFileSync } from 'node:fs';
import { loadCache, saveCache, cacheKey } from '../server/ar/mapping-cache';

interface Confirmed {
  /** PM export name, exactly as the export spells it. */
  name: string;
  leaseId: string;
  /** Why it is safe (the property corroboration). */
  why: string;
}

/** [PM export name, Lease.id, why it is safe], from the local table. */
const CONFIRMED: ReadonlyArray<readonly [string, string, string]> = (
  JSON.parse(readFileSync(new URL('../config/local/ar-seed-mappings.json', import.meta.url), 'utf8')) as { confirmed: Confirmed[] }
).confirmed.map((c) => [c.name, c.leaseId, c.why] as const);

async function main(): Promise<void> {
  const cache = loadCache();
  for (const [name, leaseId, why] of CONFIRMED) {
    const key = cacheKey(name);
    // Object.hasOwn guard (2026-08-24, PR #302 review): CONFIRMED above is hardcoded, not untrusted
    // input, so this is defense-in-depth rather than a live gap — but it keeps every cacheEntries
    // lookup site in the AR subsystem consistent with the same guard.
    const prior = Object.hasOwn(cache.entries, key) ? cache.entries[key] : undefined;
    if (prior !== undefined && prior !== leaseId) {
      throw new Error(
        `refusing to overwrite an existing mapping: ${key} -> ${prior} (wanted ${leaseId})`,
      );
    }
    cache.entries[key] = leaseId;
    console.log(`  ${name}\n    key:   ${key}\n    lease: ${leaseId}\n    why:   ${why}`);
  }
  await saveCache(cache);
  console.log(`\nseeded ${CONFIRMED.length} mapping(s); cache now holds ${Object.keys(cache.entries).length}`);
}

void main();
