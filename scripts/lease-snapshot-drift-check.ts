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
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseWorkbook } from '../server/workbook/parse';
import { loadEnvFile } from '../server/load-env';
import { workbookPath, SNAPSHOT_PATH } from '../server/config';
import { loadOverlay, applyOverlay } from '../server/overlay';

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
  const force = process.argv.includes('--force');
  const previous = loadPrevious();
  const prevById = new Map(previous.map((l) => [l.id, l]));

  const { snapshot } = await parseWorkbook(workbookPath());
  // portfolio.json's canonical content is the OVERLAY-ENRICHED snapshot (see server/brain.ts's
  // refresh(), which persists applyOverlay(snapshot, overlay)), not the raw parse -- writing the
  // raw parse here would silently zero out real tenantArrears/renewalStages/marketRents/noiBudgets
  // data on every scheduled run (a mandatory adversarial review round caught this).
  const overlay = loadOverlay();
  const enriched = applyOverlay(snapshot, overlay);
  // No cast: Lease already structurally satisfies DriftLeaseView. Keeping this a plain
  // assignment (not `as unknown as`) means a future Lease shape change that breaks the
  // assumption fails typecheck here instead of silently disabling the check. enriched.leases is
  // identical to snapshot.leases (applyOverlay never touches .leases -- verified by reading its
  // implementation), so reading from `enriched` here is behavior-neutral for the diff itself; it's
  // used for consistency, so a future maintainer never has two "the current leases" variables to
  // pick between.
  const current: DriftLeaseView[] = enriched.leases;

  const currentIds = new Set(current.map((l) => l.id));
  const removedIds = previous.filter((l) => !currentIds.has(l.id));

  const newIds = current.filter((l) => !prevById.has(l.id));
  const changedDates = current.filter((l) => {
    const prev = prevById.get(l.id);
    return prev && prev.leaseEnd !== l.leaseEnd;
  });

  // Refuse to overwrite a known-good snapshot with a suspiciously small/empty one: a parse that
  // goes wrong for a reason OTHER than genuine lease removal (workbook read mid-save, a
  // renamed/missing worksheet section, a wrong WORKBOOK_PATH resolving to the wrong file) must not
  // silently replace real data, get a fresh meta.generatedAt stamp, and have this branch's OWN
  // staleness guard vouch for it as "fresh". Fraction is of the OLD (previous) set that vanished --
  // removedIds.length / previous.length -- not some other ratio.
  if (previous.length > 0) {
    const removedFraction = removedIds.length / previous.length;
    const anomalous = current.length === 0 || removedFraction > 0.25;
    if (anomalous && !force) {
      console.error(
        `✗ Refusing to write ${SNAPSHOT_PATH}: previous snapshot had ${previous.length} lease(s), this parse produced ${current.length}, ` +
          `${removedIds.length} (${(removedFraction * 100).toFixed(1)}%) would be removed -- this looks like a bad parse, not a genuine mass ` +
          `disposition. portfolio.json was NOT modified. Re-run with --force if this is a real, intentional mass-disposition event.`,
      );
      process.exit(1);
    }
    if (anomalous && force) {
      console.warn(
        `⚠ --force: proceeding despite ${removedIds.length}/${previous.length} (${(removedFraction * 100).toFixed(1)}%) leases removed (current count ${current.length}).`,
      );
    }
  }

  mkdirSync(dirname(SNAPSHOT_PATH), { recursive: true });
  // Atomic write (temp file + rename), same pattern as scripts/ar-import-headless.ts's
  // patchSnapshot(): a crash mid-write must not leave portfolio.json truncated for the next reader
  // (the daily brief's collections section, server/brain.ts's loadFallback() after a server restart).
  const tmp = `${SNAPSHOT_PATH}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(enriched, null, 2));
  renameSync(tmp, SNAPSHOT_PATH);

  if (newIds.length === 0 && changedDates.length === 0 && removedIds.length === 0) {
    console.log(`✓ No lease drift. portfolio.json regenerated (${current.length} leases).`);
    process.exit(0);
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
  // Distinguish "ran, found drift worth a look" (2) from "ran clean" (0) and "refused to write" (1)
  // above, so an unattended scheduler can tell these apart instead of every run exiting 0.
  process.exit(2);
}

main().catch((err) => {
  console.error('drift check failed:', err);
  process.exit(1);
});
