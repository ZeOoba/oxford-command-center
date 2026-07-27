// scripts/reconcile-noi-crosscheck.ts — wires the PFI Phase 1c A↔B NOI reconciliation
// (server/warehouse/reconcile-noi.ts) into an actual gate check. The classifier and its DB
// wrapper (reconcileNoiABFromDb) were built and unit-tested but had zero callers outside their
// own test file — this script is that missing caller.
//
// Reads the live workbook (Spine A) and the live warehouse DB (Spine B), reconciles Property.noi
// against warehouse oxfordNoi per property at the latest full-year period, prints one row per
// property, and fails (exit 1) if any row is 'error' severity (large-drift — the spines
// materially disagree on NOI). 'warn' rows (in-band drift, missing-from-one-side, low-confidence
// basis) are printed but do not fail the gate — the classifier already encodes which states are
// structurally expected (e.g. a newly-acquired property pre-ingest) vs. a real integrity break.
//
// Local-only gate (wired into `npm run gate`, NOT gate:ci — CI runners have no live workbook or
// warehouse DB), matching the existing reconcile / warehouse:verify / warehouse:drift pattern.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnvFile } from '../server/load-env';
import { workbookPath } from '../server/config';
import { parseWorkbook } from '../server/workbook/parse';
import { openWarehouse } from '../server/warehouse/db';
import { reconcileNoiABFromDb, DEFAULT_TOLERANCE, type NoiReconciliationRow } from '../server/warehouse/reconcile-noi';

loadEnvFile();

function formatUsd(n: number | null): string {
  if (n === null) return 'n/a';
  return (n < 0 ? '-' : '') + '$' + Math.round(Math.abs(n)).toLocaleString();
}

function printRow(r: NoiReconciliationRow): void {
  const icon = r.severity === 'error' ? '✗ ERROR' : r.severity === 'warn' ? '⚠ WARN ' : '✓ INFO ';
  const label = `${r.propertyName ?? r.propertyId} (${r.propertyId})`.padEnd(48);
  const wb = formatUsd(r.workbookOxfordNoi);
  const wh = formatUsd(r.warehouseOxfordNoi);
  console.log(`${icon}  ${label} wb ${wb} · wh ${wh} · ${r.status} — ${r.reason}`);
}

async function main() {
  const warehousePath = process.env['WAREHOUSE_DB'] ?? join(process.cwd(), 'data', 'warehouse', 'finance.sqlite');

  if (!existsSync(warehousePath)) {
    console.warn(
      `reconcile:noi-crosscheck — skipped: no warehouse DB at ${warehousePath}. ` +
        `Run 'npm run warehouse:backfill' first, or this is a fresh worktree with no local warehouse yet.`,
    );
    return;
  }

  console.log(`→ Reading workbook: ${workbookPath()}`);
  const { snapshot } = await parseWorkbook(workbookPath());

  const db = openWarehouse(warehousePath);
  let rows: NoiReconciliationRow[];
  try {
    rows = reconcileNoiABFromDb(db, snapshot, DEFAULT_TOLERANCE);
  } finally {
    db.close();
  }

  console.log('── NOI CROSS-CHECK: Spine A (workbook) ↔ Spine B (warehouse) ───────────');
  for (const r of rows) printRow(r);

  const errors = rows.filter((r) => r.severity === 'error');
  const warnings = rows.filter((r) => r.severity === 'warn');
  console.log('──────────────────────────────────────────────────────────────────────');
  console.log(
    `${rows.length} propert${rows.length === 1 ? 'y' : 'ies'} checked · ${errors.length} error(s) · ${warnings.length} warning(s)`,
  );

  if (errors.length > 0) {
    console.error(
      `✗ NOI cross-check FAILED: ${errors.length} propert${errors.length === 1 ? 'y' : 'ies'} in large-drift ` +
        `(spines disagree by ≥${(DEFAULT_TOLERANCE.largeDriftPct * 100).toFixed(0)}%). ` +
        `See rows above marked ERROR.`,
    );
    process.exit(1);
  }
  console.log('✓ NOI cross-check passed — no large-drift disagreements between Spine A and Spine B.');
}

main().catch((err) => {
  console.error('✗ NOI cross-check error:', err);
  process.exit(1);
});
