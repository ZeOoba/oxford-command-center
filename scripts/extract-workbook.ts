import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseWorkbook } from '../server/workbook/parse';
import { loadEnvFile } from '../server/load-env';
import { workbookPath, SNAPSHOT_PATH } from '../server/config';
import { loadOverlay, applyOverlay } from '../server/overlay';

loadEnvFile();

async function main() {
  console.log(`→ Reading workbook: ${workbookPath()}`);
  const { snapshot, flags } = await parseWorkbook(workbookPath());

  // portfolio.json's canonical content is the OVERLAY-ENRICHED snapshot (see server/brain.ts's
  // refresh(), which persists applyOverlay(snapshot, overlay)), not the raw parse -- writing the
  // raw parse here would silently zero out real tenantArrears/renewalStages/marketRents/noiBudgets
  // data. Same fix as scripts/lease-snapshot-drift-check.ts (its header comment claims this script
  // regenerates "the same as `npm run extract`" -- that was false until this fix; keep both
  // regeneration tools in sync going forward, since whichever one runs last against
  // data/snapshots/portfolio.json wins).
  const overlay = loadOverlay();
  const enriched = applyOverlay(snapshot, overlay);

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
