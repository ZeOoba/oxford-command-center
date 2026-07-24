// scripts/lease-snapshot-drift-check.ts
//
// Regenerates data/snapshots/portfolio.json from the live workbook (same as `npm run extract`),
// then diffs the NEW lease set against what was there immediately before, reporting any lease
// whose id or leaseEnd changed. Run on a schedule so portfolio.json never goes stale for longer
// than the schedule's own interval, independent of whether the interactive dev/prod server is
// running (which is the actual root cause of the staleness this script exists to close --
// see docs/superpowers/plans/2026-07-24-lease-id-integrity-fix-plan.md).
//
// Usage: npx tsx scripts/lease-snapshot-drift-check.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseWorkbook } from '../server/workbook/parse';
import { loadEnvFile } from '../server/load-env';
import { workbookPath, SNAPSHOT_PATH } from '../server/config';

loadEnvFile();

interface LeaseLite { id: string; tenantName: string; company: string | null; leaseEnd: string | null; annualRent: number; }

async function main() {
  const previous: LeaseLite[] = existsSync(SNAPSHOT_PATH)
    ? JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')).leases
    : [];
  const prevById = new Map(previous.map((l) => [l.id, l]));

  const { snapshot } = await parseWorkbook(workbookPath());
  const current = snapshot.leases as unknown as LeaseLite[];

  const newIds = current.filter((l) => !prevById.has(l.id));
  const changedDates = current.filter((l) => {
    const prev = prevById.get(l.id);
    return prev && prev.leaseEnd !== l.leaseEnd;
  });

  mkdirSync(dirname(SNAPSHOT_PATH), { recursive: true });
  writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2));

  if (newIds.length === 0 && changedDates.length === 0) {
    console.log(`✓ No lease drift. portfolio.json regenerated (${current.length} leases).`);
    return;
  }

  console.log(`⚠ Lease drift detected — portfolio.json regenerated (${current.length} leases).`);
  if (newIds.length) {
    console.log(`\nNew/changed-id leases (${newIds.length}):`);
    for (const l of newIds) console.log(`  ${l.id} | ${l.company ?? l.tenantName} | end: ${l.leaseEnd}`);
  }
  if (changedDates.length) {
    console.log(`\nLease end date changes (${changedDates.length}):`);
    for (const l of changedDates) {
      const prev = prevById.get(l.id)!;
      console.log(`  ${l.id} | ${l.company ?? l.tenantName} | ${prev.leaseEnd} -> ${l.leaseEnd}`);
    }
  }
}

main().catch((err) => {
  console.error('drift check failed:', err);
  process.exit(1);
});
