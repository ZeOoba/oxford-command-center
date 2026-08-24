/**
 * scripts/seed-ar-mappings.ts
 *
 * One-shot: seed the AR mapping cache with tenant→lease mappings Gabriel
 * confirmed by hand on 2026-08-16, after the P4 Phase 0 Task 1 dry run put them
 * in the review queue.
 *
 * Uses the REAL cacheKey()/saveCache() so the keys match exactly what
 * partition-confidence.ts will look up. Hand-normalising the names here would
 * risk an entry that silently never matches.
 *
 * Only mappings corroborated on PROPERTY are seeded — a name match alone is
 * never sufficient. Deliberately NOT seeded:
 *   - Buckeyes Best Transport: proposed lease is 2207 Northwood MD while the AR
 *     row is 3034 Westerville OH. False match on the token "Best".
 *   - IMH LLC ($32,291.95), Columbus Suburan Construction ($20,457.24): no lease
 *     exists — departed tenants. Reported as uncollected-balance findings, not
 *     mapped (Gabriel's ruling 2026-08-16).
 *   - The Perez Company, Don's Local Garage Door: held for a closer look.
 *
 * Run:  npx tsx scripts/seed-ar-mappings.ts
 */
import { loadCache, saveCache, cacheKey } from '../server/ar/mapping-cache';

/** [PM export name, Lease.id, why it is safe] */
const CONFIRMED: ReadonlyArray<readonly [string, string, string]> = [
  [
    'Lamar Advantage GP Co.',
    '3034-westerville-road-billboard-lamar-advertising-columbus',
    'AR property 3034 Westerville Rd == lease property; billboard lease',
  ],
  [
    'GRANITETOPS AND MORE LLC.',
    'zettler-2000-2002-granite-tops-more',
    'AR property 2000 Zettler Rd == lease unit 2000-2002',
  ],
  [
    'Gyurcsik Construction Inc.',
    '1100-rarig-d-i-dig-ditches',
    'AR property 1100 Rarig Ave == lease property; lease contact of record IS Chris Gyurcsik',
  ],
];

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
