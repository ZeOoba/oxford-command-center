// tests/support/rct-loader.ts
//
// For vi.mock factories of server/warehouse/acquisition: a loadRatifiedRct whose NO-ARGUMENT call (the production
// callers' call) loads the committed synthetic stand-in instead of the local-only ratified table. A call with explicit
// arguments reaches the real loader unchanged. Deliberately imports nothing from the acquisition module, so a mock
// factory can use it without a cycle. tests/setup.ts applies it suite-wide; a test file that declares its own
// vi.mock of the acquisition module replaces that, so it must spread this in again.
import { join } from 'node:path';

export const SYNTHETIC_RCT_FIXTURE = join(process.cwd(), 'fixtures', 'synthetic', 'config', 'replacement-cost.v3.json');

type RctOpts = { allowSynthetic?: boolean; pinnedHmac?: string | null };
type Loader = (path?: string, opts?: RctOpts) => unknown;

export function syntheticRctLoader<L extends Loader>(actual: L): L {
  const wrapped = (path?: string, opts?: RctOpts): unknown =>
    path === undefined && opts === undefined ? actual(SYNTHETIC_RCT_FIXTURE, { allowSynthetic: true, pinnedHmac: null }) : actual(path, opts);
  return wrapped as L;
}
