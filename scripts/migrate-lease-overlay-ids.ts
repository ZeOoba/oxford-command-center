// scripts/migrate-lease-overlay-ids.ts
//
// One-time migration: server/workbook/parse.ts's lease.id scheme changed from
// `slug-slug-{rowNumber}` to a stable `slug-slug` (disambiguated only on genuine collision).
// Any data/overlay.json entry keyed by a lease id under the OLD scheme is now orphaned.
// This script re-parses the live workbook (new scheme), strips any trailing `-{digits}` from
// each OLD overlay key, and remaps it to the live lease whose id starts with that stripped
// base — printing what it would change. Run with --apply to write data/overlay.json.
//
// Usage: npx tsx scripts/migrate-lease-overlay-ids.ts [--apply]
import { parseWorkbook } from '../server/workbook/parse';
import { loadEnvFile } from '../server/load-env';
import { workbookPath } from '../server/config';
import { loadOverlay, saveOverlay } from '../server/overlay';

loadEnvFile();

/**
 * Resolve one old-scheme key's stripped base against the live id set.
 *  - Exact match wins outright, even if some OTHER live id also happens to start with
 *    `${strippedBase}-` (Bug C1: a single `find(id === x || id.startsWith(...))` let Set
 *    iteration order decide whether a prefix match could beat an exact match).
 *  - Only when there is NO exact match do we fall back to prefix matches; more than one
 *    candidate there is a genuine ambiguity, not a match.
 */
export function resolveLiveId(
  strippedBase: string,
  liveIds: ReadonlySet<string>,
): { kind: 'exact' | 'prefix'; id: string } | { kind: 'none' } | { kind: 'ambiguous'; candidates: string[] } {
  if (liveIds.has(strippedBase)) return { kind: 'exact', id: strippedBase };
  const prefixMatches = [...liveIds].filter((id) => id.startsWith(`${strippedBase}-`));
  if (prefixMatches.length === 0) return { kind: 'none' };
  if (prefixMatches.length === 1) return { kind: 'prefix', id: prefixMatches[0]! };
  return { kind: 'ambiguous', candidates: prefixMatches };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const { snapshot } = await parseWorkbook(workbookPath());
  const liveIds = new Set(snapshot.leases.map((l) => l.id));

  const overlay = loadOverlay();
  let changed = false;

  // marketRents is leaseId-keyed too (with precedence over propertyKey — see server/overlay.ts /
  // src/analytics/lease-forecast.ts) — an old-scheme entry there orphans silently if omitted here.
  for (const domain of ['renewalStages', 'tenantArrears', 'marketRents'] as const) {
    const map = overlay[domain] as Record<string, unknown>;
    // Claimed within THIS migration run only — two different old-scheme keys resolving to the
    // same live id (Bug C2: e.g. a tenant with two leases at one property, exactly the collision
    // case disambiguateLeaseIds exists for) must not silently overwrite one another.
    const claimed = new Map<string, string>(); // newKey -> the oldKey that claimed it
    for (const oldKey of Object.keys(map)) {
      if (liveIds.has(oldKey)) continue; // already a valid live id, nothing to do
      const strippedBase = oldKey.replace(/-\d+$/, '');
      const resolved = resolveLiveId(strippedBase, liveIds);
      if (resolved.kind === 'none') {
        console.warn(`[${domain}] no live lease matches old key "${oldKey}" (stripped base "${strippedBase}") — left as-is, needs manual review`);
        continue;
      }
      if (resolved.kind === 'ambiguous') {
        console.warn(`[${domain}] old key "${oldKey}" (stripped base "${strippedBase}") matches multiple live leases [${resolved.candidates.join(', ')}] — ambiguous, left as-is, needs manual review`);
        continue;
      }
      const newKey = resolved.id;
      const priorClaimant = claimed.get(newKey);
      if (priorClaimant) {
        console.warn(`[${domain}] old key "${oldKey}" also resolves to "${newKey}", already claimed by old key "${priorClaimant}" in this run — ambiguous, left as-is, needs manual review`);
        continue;
      }
      claimed.set(newKey, oldKey);
      console.log(`[${domain}] "${oldKey}" -> "${newKey}"`);
      if (apply) {
        map[newKey] = map[oldKey];
        delete map[oldKey];
        changed = true;
      }
    }
  }

  if (apply && changed) {
    const ok = await saveOverlay(overlay);
    if (!ok) {
      console.error('✗ overlay.json write FAILED — see server/overlay.ts saveOverlay for the swallowed error detail. Migration NOT applied; re-run after resolving the write failure.');
      process.exit(1);
    }
    console.log('overlay.json updated.');
  } else if (!apply) {
    console.log('\nDry run only — re-run with --apply to write changes.');
  } else {
    console.log('No changes needed.');
  }
}

main().catch((err) => {
  console.error('migration failed:', err);
  process.exit(1);
});
