import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseWorkbook } from '../server/workbook/parse';
import { loadEnvFile } from '../server/load-env';
import { workbookPath, SNAPSHOT_PATH } from '../server/config';
import { loadOverlay, applyOverlay, overlayPath, evaluateOverlayPrecondition } from '../server/overlay';
import { computeDrift, evaluateAnomalyFloor, evaluateReconciliationGate, formatDriftReport, loadPrevious, requireLiveDealsSource, type DriftLeaseView } from './lease-snapshot-drift-check';
import { resolveQuickbooks } from '../server/sources/quickbooks';

loadEnvFile();

// 2026-07-26: this raw regen path had NO anomaly floor and NO drift reporting at all -- a manual
// `npm run extract` run (outside any registered schedule; no scheduled task's cron fires on the day
// it happened) wrote corrupted lease-end dates for two Sepich Portfolio tenants straight through,
// unvalidated and unreported (see the 2026-07-26 orphaned-task-forensics finding in event_log.md).
// This script now shares BOTH the refusal decision (evaluateAnomalyFloor) AND the drift report
// (formatDriftReport) with scripts/lease-snapshot-drift-check.ts (the protected weekday path).
// The floor alone was not enough to close the incident: the anomaly floor is count-based
// (0-lease / >25%-removed) and would NOT have caught these two tenants, since neither was added or
// removed -- only their leaseEnd values changed. Only the drift report's "Lease end date changes"
// section catches that class of corruption, and it REPORTS rather than REFUSES (a legitimate lease
// renewal changes leaseEnd too; refusing on every date change would block real, wanted edits).
// Exit codes now match lease-snapshot-drift-check.ts's convention: 0 = clean, 1 = refused
// (portfolio.json unchanged), 2 = wrote successfully but found drift worth a look.
async function main() {
  const force = process.argv.includes('--force');
  const previousResult = loadPrevious();
  if (previousResult.corrupt) {
    // Same unconditional, leave-the-file-in-place refusal as lease-snapshot-drift-check.ts -- see
    // that file's loadPrevious()/main() comments for why the corrupt file must never be moved aside.
    console.error(`✗ ${SNAPSHOT_PATH} is corrupt — refusing to write. portfolio.json was NOT modified. Investigate/fix/restore it, then re-run.`);
    process.exit(1);
  }
  const previous = previousResult.leases;

  console.log(`→ Reading workbook: ${workbookPath()}`);
  const { snapshot, flags } = await parseWorkbook(workbookPath());

  // Round-3 REFUTE finding: loadOverlay() fails OPEN to an empty overlay on corrupt/unparseable
  // JSON — a defensible default for a UI-driven mutation, but this script is an UNATTENDED
  // scheduled/manual writer: silently enriching with an empty overlay would zero real
  // tenantArrears/renewalStages/marketRents/noiBudgets data in the written snapshot with no
  // warning. Mirrors the identical guard in scripts/ar-import-headless.ts (same hazard class).
  // Pre-flight overlay check. loadOverlay() fails OPEN to EMPTY_OVERLAY on anything unreadable — a
  // defensible default for a UI-driven mutation, but this script is an UNATTENDED writer, and
  // enriching with an empty overlay would ZERO real tenantArrears/arBalances/renewalStages/
  // dealComps/marketRents/noiBudgets in the written snapshot with no warning. The shared evaluator
  // in server/overlay.ts covers missing, unparseable AND wrong-top-level-shape overlays; it lives
  // there, tested once, precisely so these three writers can no longer drift out of sync (the
  // missing-file case was absent from all three simultaneously until 2026-09-05).
  const rawOverlayPath = overlayPath();
  // expectEnriched: this writer MERGES the overlay onto a parsed snapshot, so a present-but-empty
  // overlay zeroes enrichment just as surely as a missing one. ar-import does not pass it.
  const overlayCheck = evaluateOverlayPrecondition(rawOverlayPath, { expectEnriched: true });
  if (overlayCheck.refuse) {
    console.error(`✗ ${overlayCheck.reason}`);
    process.exit(1);
  }
  // portfolio.json's canonical content is the OVERLAY-ENRICHED snapshot (see server/brain.ts's
  // refresh(), which persists applyOverlay(snapshot, overlay)), not the raw parse -- writing the
  // raw parse here would silently zero out real tenantArrears/renewalStages/marketRents/noiBudgets
  // data. Same fix as scripts/lease-snapshot-drift-check.ts (its header comment claims this script
  // regenerates "the same as `npm run extract`" -- that was false until this fix; keep both
  // regeneration tools in sync going forward, since whichever one runs last against
  // data/snapshots/portfolio.json wins).
  const overlay = loadOverlay();
  const merged = applyOverlay(snapshot, overlay);
  // quickbooks is SERVER-ATTACHED (server/brain.ts calls loadQuickbooks() itself; parseWorkbook/
  // applyOverlay never touch it), and the contract defaults it to null. Without this step this CLI
  // writer would silently NULL OUT whatever the server path had previously written -- the
  // 2026-08-17 incident (see resolveQuickbooks's doc comment in server/sources/quickbooks.ts).
  // Attached here, before the reconciliation gate below, so that gate sees the same object shape
  // server/brain.ts's checkSnapshot(withQb) does.
  const { quickbooks, preservedFrom } = resolveQuickbooks(merged.properties, SNAPSHOT_PATH);
  if (preservedFrom) console.log(`ℹ quickbooks: no fresh QUICKBOOKS_CSV parse — carried forward the previous snapshot's block (parsedAt ${quickbooks!.parsedAt}) instead of nulling it.`);
  const enriched = { ...merged, quickbooks };
  const current: DriftLeaseView[] = enriched.leases;

  const drift = computeDrift(previous, current);
  const floor = evaluateAnomalyFloor(previous, current, drift.removedIds, SNAPSHOT_PATH, force);
  if (floor.refuse) {
    console.error(`✗ ${floor.reason}`);
    process.exit(1);
  } else if (floor.warning) {
    console.warn(`⚠ ${floor.warning}`);
  }

  // Dollar-exact reconciliation, separate from and in addition to the count-based floor above --
  // see evaluateReconciliationGate's doc comment (scripts/lease-snapshot-drift-check.ts) for why
  // the floor alone missed the 2026-08-03 phantom-lease incident (rows only ADDED, nothing
  // removed). Checked against `enriched`, the actual object about to be written.
  const reconciliation = evaluateReconciliationGate(enriched, SNAPSHOT_PATH, force);
  if (reconciliation.refuse) {
    console.error(`✗ ${reconciliation.reason}`);
    process.exit(1);
  } else if (reconciliation.warning) {
    console.warn(`⚠ ${reconciliation.warning}`);
  }

  // Config-regression guard, complementing the flag-based gate above -- see its doc comment. This
  // path is the manual `npm run extract` one, historically the LESS guarded of the two writers.
  const dealsSource = requireLiveDealsSource(SNAPSHOT_PATH, force);
  if (dealsSource.refuse) {
    console.error(`✗ ${dealsSource.reason}`);
    process.exit(1);
  } else if (dealsSource.warning) {
    console.warn(`⚠ ${dealsSource.warning}`);
  }

  mkdirSync(dirname(SNAPSHOT_PATH), { recursive: true });
  // Atomic write (temp file + rename), same pattern as lease-snapshot-drift-check.ts and
  // scripts/ar-import-headless.ts's patchSnapshot(): a crash mid-write must not leave
  // portfolio.json truncated for the next reader.
  const tmp = `${SNAPSHOT_PATH}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(enriched, null, 2));
  renameSync(tmp, SNAPSHOT_PATH);

  const p = snapshot.properties;
  const noiTotal = p.reduce((s, x) => s + x.noi, 0);
  const sfTotal = p.reduce((s, x) => s + x.sf, 0);
  const valTotal = p.reduce((s, x) => s + x.oxfordValue, 0);
  const annualRent = snapshot.leases.reduce((s, l) => s + l.annualRent, 0);
  const balloons = snapshot.loans.filter((l) => l.balloon).map((l) => l.name);

  console.log(`✓ Snapshot written: ${SNAPSHOT_PATH}\n`);
  console.log('── RECONCILIATION SUMMARY ─────────────────────────────');
  console.log(`Properties:        ${p.length}`);
  console.log(`  Total SF:        ${sfTotal.toLocaleString()}`);
  console.log(`  Oxford value:    $${Math.round(valTotal).toLocaleString()}`);
  console.log(`  NOI (Oxford):    $${Math.round(noiTotal).toLocaleString()}`);
  console.log(`Leases:            ${snapshot.leases.length}`);
  console.log(`  Annual rent:     $${Math.round(annualRent).toLocaleString()}`);
  console.log(`Loans:             ${snapshot.loans.length} (${balloons.length} balloon: ${balloons.join(', ') || '—'})`);
  console.log(`Cash entities:     ${snapshot.cash.entities.length}`);
  console.log(`  Total cash:      $${Math.round(snapshot.cash.totalCash).toLocaleString()}`);
  console.log(`  History points:  ${snapshot.cash.history.length}`);
  console.log(`Insurance:         ${snapshot.insurance.length}`);
  console.log(`Deals:             ${snapshot.deals.length}`);
  console.log(`Scenario:          ${snapshot.assumptions.activeScenario}`);
  console.log(`Data-quality flags:${flags.length}`);
  if (flags.length) {
    for (const f of flags.slice(0, 12)) console.log(`   ⚠ ${f.entity} · ${f.field}: ${f.issue}`);
  }
  console.log('───────────────────────────────────────────────────────');

  const report = formatDriftReport(drift, previous, current);
  console.log();
  for (const line of report.lines) console.log(line);
  if (report.hasDrift) process.exit(2);
}

// Entrypoint guard — matches lease-snapshot-drift-check.ts / ar-import-headless.ts / migrate-lease
// -overlay-ids.ts. Without it, merely IMPORTING this module runs main(): it parses the live workbook
// and can process.exit() the caller. tests/setup.ts points OVERLAY_PATH at a sandbox path that is
// never created, so since 2026-09-05 the first test to import this file would hit the overlay
// refusal and kill its vitest worker. No test imports it today; this keeps that true by accident
// rather than by luck.
if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/extract-workbook.ts')) {
  main().catch((err) => {
  // Exit 3, not 1: now that this script shares lease-snapshot-drift-check.ts's exit-code
  // convention (0 clean / 1 refused, portfolio.json unchanged / 2 wrote with drift), an unattended
  // caller reading exit 1 as "refused, nothing written, benign" must not conflate that with an
  // unexpected crash that could have failed mid-write. Matches drift-check's own main().catch().
  console.error('✗ Extraction failed:', err);
  process.exit(3);
});
}
