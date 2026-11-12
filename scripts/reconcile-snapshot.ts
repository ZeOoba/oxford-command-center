// scripts/reconcile-snapshot.ts
//
// CI-safe counterpart to scripts/reconcile.ts. That script re-reads the canonical workbook (a
// local OneDrive file) TWICE as an independent from-scratch cross-check -- see its own header --
// which is exactly why it cannot run on GitHub-hosted CI (.github/workflows/ci.yml says so
// explicitly) and previously ran only via full-gate-selfhosted.yml, which is workflow_dispatch
// ONLY (never automatic). That gap is how the 2026-08-03 phantom-vacancy-lease corruption
// (server/workbook/parse.ts:476, fixed in PR #250; +10 leases, a six-figure annualized-rent overstatement) shipped
// to the committed snapshot under "Data-quality flags: 0" with nothing blocking it.
//
// This script closes that gap WITHOUT touching the workbook: it runs checkSnapshot()
// (server/reconcile-runtime.ts -- already the in-process check every brain.refresh() call runs,
// already unit-tested in tests/unit/reconcile-runtime.test.ts) against data/snapshots/portfolio.json
// (local-only real data on the live machine; in CI and on a fresh clone the synthetic stand-in from
// fixtures/synthetic/, ruling 2026-11-10). Zero workbook I/O, so it runs on every PR via gate:ci, not just
// on the self-hosted runner. It is deliberately a SUBSET of the full workbook-backed reconcile --
// it can only catch what's already inconsistent within the snapshot itself (e.g. Σ lease
// annualRent vs the workbook's own declared total, captured into the snapshot at parse time), not
// a snapshot that is internally consistent but wrong relative to a workbook change nobody
// re-baked. Both checks stay in the pipeline; neither replaces the other.
//
// A WARN-severity flag does not fail the gate -- checkSnapshot uses 'warn' for conditions that
// are informational (e.g. a handful of dangling relationship edges), matching its own severity
// model. Only 'error' flags are gate-blocking, same threshold `server/brain.ts` uses to decide
// whether to degrade the live snapshot's provenance.
//
// Usage: npx tsx scripts/reconcile-snapshot.ts
import { readFileSync } from 'node:fs';
import { SNAPSHOT_PATH } from '../server/config';
import { PortfolioSnapshot } from '../src/contracts/index';
import { checkSnapshot } from '../server/reconcile-runtime';
import { syntheticNotice } from '../server/real-data-status';
import type { DataQualityFlag } from '../src/contracts/common';

export function evaluateFlags(flags: DataQualityFlag[]): { ok: boolean; errorCount: number; warnCount: number } {
  const errorCount = flags.filter((f) => f.severity === 'error').length;
  const warnCount = flags.filter((f) => f.severity === 'warn').length;
  return { ok: errorCount === 0, errorCount, warnCount };
}

function main() {
  // In CI the snapshot is the synthetic stand-in by design; anywhere else say so loudly.
  const synthetic = syntheticNotice('reconcile:snapshot');
  if (synthetic) console.error(synthetic);
  const raw = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'));
  // Zod parse, not a bare cast: a schema-shape drift (a renamed/removed field) should fail this
  // check loudly rather than let checkSnapshot silently read `undefined` off a field that no
  // longer exists and pass by accident.
  const snapshot = PortfolioSnapshot.parse(raw);

  const flags = checkSnapshot(snapshot);
  const { ok, errorCount, warnCount } = evaluateFlags(flags);

  console.log(`── SNAPSHOT RECONCILIATION (${SNAPSHOT_PATH}) ──────────────`);
  if (flags.length === 0) {
    console.log('✓ No flags.');
  }
  for (const f of flags) {
    const mark = f.severity === 'error' ? '✗ ERROR' : '⚠ WARN ';
    console.log(`${mark}  ${f.entity}.${f.field}: ${f.issue}`);
  }
  console.log('──────────────────────────────────────────────────────────');
  console.log(`${ok ? '✓' : '✗'} ${errorCount} error(s), ${warnCount} warn(s).`);

  if (!ok) {
    console.error(
      `✗ Snapshot reconciliation FAILED. This is the CI-safe subset of \`npm run reconcile\` -- ` +
        `run the full workbook-backed check locally before re-baking: npm run reconcile`,
    );
    process.exit(1);
  }
}

// Run the CLI only when invoked directly. Importing this module for tests (evaluateFlags, from
// tests/unit/reconcile-snapshot.test.ts) previously ran main() as an import side effect: it read the
// live SNAPSHOT_PATH and could process.exit(1) the vitest worker mid-file on any error-severity flag
// in the committed snapshot. Same guard, and same rationale, as every sibling script here
// (lease-snapshot-drift-check.ts, calibration-snapshot.ts, debt-scores-snapshot.ts, ...).
// `npm run reconcile:snapshot` is `tsx scripts/reconcile-snapshot.ts`, so argv[1] still matches and
// the CLI behaves exactly as before.
if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/reconcile-snapshot.ts')) {
  main();
}
