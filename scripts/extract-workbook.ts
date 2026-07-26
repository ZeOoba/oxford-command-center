import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseWorkbook } from '../server/workbook/parse';
import { loadEnvFile } from '../server/load-env';
import { workbookPath, SNAPSHOT_PATH } from '../server/config';
import { loadOverlay, applyOverlay, overlayPath } from '../server/overlay';
import { computeDrift, evaluateAnomalyFloor, loadPrevious, type DriftLeaseView } from './lease-snapshot-drift-check';

loadEnvFile();

// 2026-07-26: this raw regen path had NO anomaly floor at all -- a manual `npm run extract` run
// (outside any registered schedule; no scheduled task's cron fires on the day it happened) wrote
// corrupted lease-end dates for two Sepich Portfolio tenants straight through, unvalidated (see the
// 2026-07-26 orphaned-task-forensics finding in event_log.md). This script now shares the exact
// same refusal decision as scripts/lease-snapshot-drift-check.ts (the protected weekday path) via
// evaluateAnomalyFloor -- both writers refuse on the same conditions instead of only one being
// protected. This does NOT add the drift-check script's verbose drift report (new/removed/re-keyed
// listing) -- that stays the protected path's job; this script's role stays "raw regen, now
// refusal-guarded," not "raw regen plus reporting."
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
  const rawOverlayPath = overlayPath();
  if (existsSync(rawOverlayPath)) {
    try {
      const parsedOverlay: unknown = JSON.parse(readFileSync(rawOverlayPath, 'utf8'));
      // Round-4 REFUTE: a JSON.parse THROW only catches malformed JSON syntax. Content that is
      // syntactically valid JSON but the wrong TOP-LEVEL shape (`null`, `[]`, `0`, `"some string"`)
      // parses successfully, passes a parse-only guard, but still causes loadOverlay() to fall back
      // to EMPTY_OVERLAY internally -- silently zeroing enrichment data exactly as before, just via
      // a different malformed-content shape than a parse error. Same fix as
      // scripts/lease-snapshot-drift-check.ts -- keep both in sync (see that file's header comment
      // on why, including the narrower residual gap this check does NOT close).
      if (!parsedOverlay || typeof parsedOverlay !== 'object' || Array.isArray(parsedOverlay)) {
        console.error(`✗ ${rawOverlayPath} is valid JSON but not a valid overlay object — refusing to regenerate portfolio.json (would zero enrichment data). Fix or restore it first.`);
        process.exit(1);
      }
    } catch (e) {
      console.error(`✗ ${rawOverlayPath} is corrupt/unparseable — refusing to regenerate portfolio.json (would zero enrichment data). Fix or restore it first. (${e instanceof Error ? e.message : String(e)})`);
      process.exit(1);
    }
  }
  // portfolio.json's canonical content is the OVERLAY-ENRICHED snapshot (see server/brain.ts's
  // refresh(), which persists applyOverlay(snapshot, overlay)), not the raw parse -- writing the
  // raw parse here would silently zero out real tenantArrears/renewalStages/marketRents/noiBudgets
  // data. Same fix as scripts/lease-snapshot-drift-check.ts (its header comment claims this script
  // regenerates "the same as `npm run extract`" -- that was false until this fix; keep both
  // regeneration tools in sync going forward, since whichever one runs last against
  // data/snapshots/portfolio.json wins).
  const overlay = loadOverlay();
  const enriched = applyOverlay(snapshot, overlay);
  const current: DriftLeaseView[] = enriched.leases;

  // Raw id-level removal set, same as lease-snapshot-drift-check.ts's main() -- the floor must see
  // this, not a business-key-paired count (see computeDrift's doc comment for why).
  const { removedIds } = computeDrift(previous, current);
  const floor = evaluateAnomalyFloor(previous, current, removedIds, SNAPSHOT_PATH, force);
  if (floor.warning) console.warn(`⚠ ${floor.warning}`);
  if (floor.refuse) {
    console.error(`✗ ${floor.reason}`);
    process.exit(1);
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
}

main().catch((err) => {
  console.error('✗ Extraction failed:', err);
  process.exit(1);
});
