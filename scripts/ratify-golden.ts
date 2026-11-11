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
  const writes: Array<[string, unknown]> = [
    [GOLDEN_PF, computePfGolden(read('data/property-financials/dataset.json'), loadLeaseTermSeeds(ROOT))],
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
