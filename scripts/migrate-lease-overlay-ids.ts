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

async function main() {
  const apply = process.argv.includes('--apply');
  const { snapshot } = await parseWorkbook(workbookPath());
  const liveIds = new Set(snapshot.leases.map((l) => l.id));

  const overlay = loadOverlay();
  let changed = false;

  for (const domain of ['renewalStages', 'tenantArrears'] as const) {
    const map = overlay[domain] as Record<string, unknown>;
    for (const oldKey of Object.keys(map)) {
      if (liveIds.has(oldKey)) continue; // already a valid live id, nothing to do
      const strippedBase = oldKey.replace(/-\d+$/, '');
      const newKey = [...liveIds].find((id) => id === strippedBase || id.startsWith(`${strippedBase}-`));
      if (!newKey) {
        console.warn(`[${domain}] no live lease matches old key "${oldKey}" (stripped base "${strippedBase}") — left as-is, needs manual review`);
        continue;
      }
      console.log(`[${domain}] "${oldKey}" -> "${newKey}"`);
      if (apply) {
        map[newKey] = map[oldKey];
        delete map[oldKey];
        changed = true;
      }
    }
  }

  if (apply && changed) {
    await saveOverlay(overlay);
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
