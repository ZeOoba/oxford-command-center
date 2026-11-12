// scripts/ratify-golden.ts — `npm run golden:ratify`
//
// Writes the gitignored value locks (scripts/golden/compute-golden.ts) from the REAL data in place:
//   data/property-financials/golden.local.json and data/cost-seg/golden.local.json.
// This is the only writer. Run it on purpose after a reviewed, intended change to the dataset, cost
// seg or calibration ledger (it prints the old -> new differences), never to make a failing test pass
// unexamined. Refuses on synthetic stand-in data (the synthetic goldens are written by
// scripts/fixtures/build-synthetic-data.ts).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { GOLDEN_COST, GOLDEN_PF, computeCostGolden, computePfGolden } from './golden/compute-golden';
import { LOCAL_BASELINE_REL, compareToPinned, loadPinned } from './golden/leaserun-baseline';
import { loadLeaseTermSeeds } from '../server/warehouse/lease-terms';
import { syntheticInUse } from '../server/real-data-status';

const ROOT = resolve(process.cwd());
const read = (rel: string): Record<string, unknown> => JSON.parse(readFileSync(join(ROOT, rel), 'utf8')) as Record<string, unknown>;

function diff(prefix: string, a: unknown, b: unknown, out: string[]): void {
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of new Set([...Object.keys(a as object), ...Object.keys(b as object)])) diff(`${prefix}.${k}`, (a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], out);
  } else if (JSON.stringify(a) !== JSON.stringify(b)) out.push(`${prefix}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
}

function main(): void {
  const synthetic = syntheticInUse(ROOT).filter((f) => /dataset\.json|cost-seg\.json|observations\.json|lease-term-seeds\.json/.test(f));
  if (synthetic.length) throw new Error(`golden:ratify refuses on synthetic stand-in data: ${synthetic.join(', ')}`);
  const pf = computePfGolden(read('data/property-financials/dataset.json'), loadLeaseTermSeeds(ROOT));
  // The leaseRun lock is a snapshot of engine output. Check it against the independently computed
  // Excel-model figures the pre-untrack lease-run test pinned: the local copy (config/local, written
  // once before the history purge) or git history. Fail closed when neither is available, when the
  // baseline is incomplete, or when the lock disagrees (refute round 4 F1/F4/F5).
  const accept = process.env['ORA_ACCEPT_LEASERUN_CHANGE'] === '1';
  const base = loadPinned(ROOT);
  if (base === null) {
    if (!accept) {
      throw new Error(
        `golden:ratify refuses: no leaseRun baseline (${LOCAL_BASELINE_REL} is missing and the pre-untrack lease-run test is not ` +
          'in this clone). Write it with `npx tsx scripts/golden/leaserun-baseline.ts --write-local` on a clone that still has the ' +
          'history, or set ORA_ACCEPT_LEASERUN_CHANGE=1 for a reviewed, intended change.',
      );
    }
    console.log('[golden:ratify] leaseRun baseline: none available; ACCEPTED by ORA_ACCEPT_LEASERUN_CHANGE');
  } else {
    const bad = compareToPinned(pf.leaseRun, base.pinned);
    if (bad.length && !accept) {
      throw new Error(
        `golden:ratify refuses: the leaseRun lock disagrees with the pre-untrack Excel-model figures from the ${base.source} (${bad.join('; ')}). ` +
          'Fix the engine or the lease-term roster; set ORA_ACCEPT_LEASERUN_CHANGE=1 only for a reviewed, intended change.',
      );
    }
    console.log(`[golden:ratify] leaseRun baseline (${base.source}): ${bad.length ? `${bad.length} difference(s) ACCEPTED by ORA_ACCEPT_LEASERUN_CHANGE` : 'matches the pre-untrack Excel-model figures'}`);
  }
  const writes: Array<[string, unknown]> = [
    [GOLDEN_PF, pf],
    [GOLDEN_COST, computeCostGolden(read('data/cost-seg/cost-seg.json'), read('data/calibration/observations.json'))],
  ];
  for (const [rel, golden] of writes) {
    const abs = join(ROOT, rel);
    const changes: string[] = [];
    if (existsSync(abs)) diff('', JSON.parse(readFileSync(abs, 'utf8')), golden, changes);
    writeFileSync(abs, JSON.stringify(golden, null, 2) + '\n');
    console.log(`[golden:ratify] wrote ${rel}${existsSync(abs) && changes.length ? ` (${changes.length} change(s))` : ''}`);
    for (const c of changes.filter((x) => !x.startsWith('.note'))) console.log(`  ${c}`);
  }
}

try {
  main();
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
