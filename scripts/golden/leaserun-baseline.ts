// scripts/golden/leaserun-baseline.ts
//
// The `leaseRun` value lock is a SNAPSHOT of the engine's output on the operator lease-term roster:
// golden:ratify writes whatever the engine computes. Before this branch, tests/unit/lease-run.test.ts
// pinned independently computed figures (from the v1.0 Excel models) for the two seeded leases. Those
// figures are real firm data, so they are not committed again; instead golden:ratify reads them from
// git history at run time (the pre-untrack test file) and refuses to write a leaseRun lock that
// disagrees, so a ratify can never bless a lease-run regression introduced after the untrack.
import { execFileSync } from 'node:child_process';
import type { PfGolden } from './compute-golden';

/** The commit whose tests/unit/lease-run.test.ts still pins the Excel-model figures (origin/main
 *  before the real-data untrack). Override with ORA_LEASERUN_BASELINE_REF. */
export const DEFAULT_BASELINE_REF = '7009bd26';
const BASELINE_PATH = 'tests/unit/lease-run.test.ts';

/** The describe-block title that opens each pinned lease, mapped to its property id. */
const BLOCKS: Array<[string, string]> = [
  ['401 Sunburst', '401-sunburst-hwy-cambridge-md'],
  ['7658 Fishel', '7658-fishel-dr-n-dublin-oh'],
];

export interface PinnedLeaseRun {
  noiByYear: Record<string, number>;
  stabilizedNoi: number | null;
  indicativeValue: number | null;
}

/** Parse the pinned figures out of the pre-untrack test source (pure; exported for tests). */
export function parsePinnedLeaseRun(source: string): Record<string, PinnedLeaseRun> {
  const out: Record<string, PinnedLeaseRun> = {};
  const starts = BLOCKS.map(([title, id]) => ({ id, at: source.indexOf(`describe('projectLeaseRun — ${title}`) })).filter((b) => b.at >= 0);
  starts.sort((a, b) => a.at - b.at);
  starts.forEach((b, i) => {
    const end = i + 1 < starts.length ? starts[i + 1]!.at : source.indexOf("describe('engine math invariants'", b.at);
    const block = source.slice(b.at, end > b.at ? end : undefined);
    const pin: PinnedLeaseRun = { noiByYear: {}, stabilizedNoi: null, indicativeValue: null };
    for (const m of block.matchAll(/noiOf\(proj\.periods, "([^"]+)"\)\)\.toBeCloseTo\((-?[\d.]+), 2\)/g)) pin.noiByYear[m[1]!] = Number(m[2]);
    const s = /proj\.stabilizedNoi\)\.toBeCloseTo\((-?[\d.]+), 2\)/.exec(block);
    const v = /proj\.indicativeValue\)\.toBeCloseTo\((-?[\d.]+), 2\)/.exec(block);
    if (s) pin.stabilizedNoi = Number(s[1]);
    if (v) pin.indicativeValue = Number(v[1]);
    out[b.id] = pin;
  });
  return out;
}

/** Every pinned figure must match the lock to the cent. Returns the mismatches (empty = agrees). */
export function compareToPinned(leaseRun: PfGolden['leaseRun'], pinned: Record<string, PinnedLeaseRun>): string[] {
  const bad: string[] = [];
  const near = (a: number | null | undefined, b: number | null): boolean => a != null && b != null && Math.abs(a - b) < 0.005;
  for (const [id, p] of Object.entries(pinned)) {
    const g = leaseRun[id];
    if (!g) {
      bad.push(`${id}: no leaseRun lock`);
      continue;
    }
    for (const [ly, noi] of Object.entries(p.noiByYear)) if (!near(g.noiByYear[ly], noi)) bad.push(`${id} ${ly} NOI`);
    if (p.stabilizedNoi !== null && !near(g.stabilizedNoi, p.stabilizedNoi)) bad.push(`${id} stabilized NOI`);
    if (p.indicativeValue !== null && !near(g.indicativeValue, p.indicativeValue)) bad.push(`${id} indicative value`);
  }
  return bad;
}

/** Read the pinned figures from history. null when the baseline ref is not in this clone (logged). */
export function loadPinnedFromHistory(root: string, ref = process.env['ORA_LEASERUN_BASELINE_REF'] ?? DEFAULT_BASELINE_REF): Record<string, PinnedLeaseRun> | null {
  try {
    const src = execFileSync('git', ['show', `${ref}:${BASELINE_PATH}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return parsePinnedLeaseRun(src);
  } catch {
    return null;
  }
}
