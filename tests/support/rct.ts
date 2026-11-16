// tests/support/rct.ts
//
// The ratified Replacement-Cost Table is local-only (docs/ops/rct-runtime-config.md). Tests ALWAYS run on the committed
// synthetic stand-in, whose figures are invented, whether or not this checkout holds the real table: the bundled imports
// are aliased to it in vitest.config.ts, and server-side loads go through here. Never point a test at the real table
// except tests/unit/rct-public-leak.test.ts, which only compares and never prints a figure.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ReplacementCostTable } from '../../src/contracts/acquisition';
import { loadRatifiedRct } from '../../server/warehouse/acquisition';

export const SYNTHETIC_RCT_PATH = resolve(process.cwd(), 'fixtures/synthetic/config/replacement-cost.v3.json');

/** The synthetic stand-in, parsed and asserted exactly as production does, minus the synthetic refusal and the pin. */
export function loadTestRct(): ReplacementCostTable {
  return loadRatifiedRct(SYNTHETIC_RCT_PATH, { allowSynthetic: true, pinnedHmac: null });
}

/** The synthetic stand-in's raw JSON (a fresh object per call). */
export function syntheticRctRaw(): Record<string, unknown> {
  return JSON.parse(readFileSync(SYNTHETIC_RCT_PATH, 'utf8')) as Record<string, unknown>;
}
