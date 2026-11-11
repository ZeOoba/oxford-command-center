// tests/unit/golden-helpers.ts
//
// Value-lock helpers (scripts/golden/compute-golden.ts). Real firm data is local-only (ruling
// 2026-11-10): exact expected figures live in the gitignored golden files next to the data, written
// only by `npm run golden:ratify`; in CI the committed synthetic copies are seeded in their place.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { realDataStatus } from '../../server/real-data-status';
import type { CostGolden, PfGolden } from '../../scripts/golden/compute-golden';

function load<T>(rel: string): T {
  const abs = join(process.cwd(), rel);
  if (!existsSync(abs)) {
    throw new Error(`${rel} is missing: the value lock for the real data has not been ratified on this machine. Run \`npm run golden:ratify\` after checking the data.`);
  }
  return JSON.parse(readFileSync(abs, 'utf8')) as T;
}

export const pfGolden = (): PfGolden => load<PfGolden>('data/property-financials/golden.local.json');
export const costGolden = (): CostGolden => load<CostGolden>('data/cost-seg/golden.local.json');

/** True when the runtime file is the committed synthetic stand-in (byte-identical to the fixture). */
export function isSynthetic(rel: string): boolean {
  return realDataStatus(process.cwd()).some((s) => s.rel === rel && s.state === 'synthetic');
}
