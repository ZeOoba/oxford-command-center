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

/** Local view of the fields this drift check compares -- named distinctly from
 *  server/ar/match-tenant.ts's own LeaseLite (different shape) to avoid a same-name mixup. */
interface DriftLeaseView { id: string; tenantName: string; company: string | null; leaseEnd: string | null; annualRent: number; }

function loadPrevious(): DriftLeaseView[] {
  if (!existsSync(SNAPSHOT_PATH)) return [];
  try {
    const parsed = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'));
    if (!Array.isArray(parsed?.leases)) {
      console.warn(`⚠ ${SNAPSHOT_PATH} parsed but has no "leases" array — treating previous snapshot as empty (will report every current lease as new).`);
      return [];
    }
    return parsed.leases;
  } catch (err) {
    // A truncated/corrupt snapshot (a known OneDrive-sync hazard here) must not permanently block
    // the refresh this script exists to perform on every subsequent scheduled run.
    console.warn(`⚠ failed to parse ${SNAPSHOT_PATH} (${(err as Error).message}) — treating previous snapshot as empty (will report every current lease as new).`);
    return [];
  }
}

async function main() {
  const previous = loadPrevious();
  const prevById = new Map(previous.map((l) => [l.id, l]));

  const { snapshot } = await parseWorkbook(workbookPath());
  // No cast: Lease already structurally satisfies DriftLeaseView. Keeping this a plain
  // assignment (not `as unknown as`) means a future Lease shape change that breaks the
  // assumption fails typecheck here instead of silently disabling the check.
  const current: DriftLeaseView[] = snapshot.leases;

  const currentIds = new Set(current.map((l) => l.id));
  const removedIds = previous.filter((l) => !currentIds.has(l.id));

  const newIds = current.filter((l) => !prevById.has(l.id));
  const changedDates = current.filter((l) => {
    const prev = prevById.get(l.id);
    return prev && prev.leaseEnd !== l.leaseEnd;
  });

  mkdirSync(dirname(SNAPSHOT_PATH), { recursive: true });
  writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2));

  if (newIds.length === 0 && changedDates.length === 0 && removedIds.length === 0) {
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
  if (removedIds.length) {
    console.log(`\nRemoved leases (${removedIds.length}):`);
    for (const l of removedIds) console.log(`  ${l.id} | ${l.company ?? l.tenantName} | was end: ${l.leaseEnd}`);
  }
}

main().catch((err) => {
  console.error('drift check failed:', err);
  process.exit(1);
});
