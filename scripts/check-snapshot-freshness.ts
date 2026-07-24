// scripts/check-snapshot-freshness.ts
//
// Fails loudly (non-zero exit) if data/snapshots/portfolio.json is older than the staleness
// threshold. Intended for any script/scheduled task that reads SNAPSHOT_PATH directly rather
// than through the live server's /api/snapshot (which is always freshly parsed, never stale).
//
// Usage: npx tsx scripts/check-snapshot-freshness.ts
import { readFileSync } from 'node:fs';
import { SNAPSHOT_PATH, isSnapshotStale, snapshotAgeMs } from '../server/config';

function main() {
  const raw = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'));
  const generatedAt: string | undefined = raw?.meta?.generatedAt;
  if (!generatedAt) {
    console.error(`✗ ${SNAPSHOT_PATH} has no meta.generatedAt — cannot verify freshness.`);
    process.exit(1);
  }
  const now = Date.now();
  const ageHours = (snapshotAgeMs(now, generatedAt) / (60 * 60 * 1000)).toFixed(1);
  if (isSnapshotStale(now, generatedAt)) {
    console.error(`✗ STALE: ${SNAPSHOT_PATH} is ${ageHours}h old (generatedAt ${generatedAt}).`);
    process.exit(1);
  }
  console.log(`✓ FRESH: ${SNAPSHOT_PATH} is ${ageHours}h old (generatedAt ${generatedAt}).`);
}

main();
