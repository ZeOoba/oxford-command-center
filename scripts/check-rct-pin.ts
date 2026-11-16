// scripts/check-rct-pin.ts
//
// Mirror-build gate for the local-only Replacement-Cost Table (docs/ops/rct-runtime-config.md). The drawer (Vite) and
// the edge scoring Function (wrangler) BUNDLE config/replacement-cost.v3.json, and neither can hold the pin key at
// runtime, so the keyed-HMAC pin is checked here, against the very file about to be bundled, before `vite build`.
// Runs in `build:mirror` (the only build that is deployed). Exits 1, with a reason that names no figure, when the file
// is missing, malformed, the synthetic stand-in, implausible, unratified, or not the pinned table, or RCT_PIN_KEY is
// absent. `npm run build` (CI) does not run it: a CI bundle carries the synthetic stand-in, which the production drawer
// and the edge Function refuse at runtime.
//
//   npm run check:rct-pin               verify (reads RCT_PIN_KEY from the environment, else the repo .env)
//   npm run check:rct-pin -- --print    print the HMAC of the local table under the key (re-ratification: paste it
//                                       into RATIFIED_RCT_HMAC in server/warehouse/rct-pin.ts, in a PR)
import { loadEnvFile } from '../server/load-env';
import { loadRatifiedRct, loadReplacementCostTable, REPLACEMENT_COST_TABLE_PATH } from '../server/warehouse/acquisition';
import { PIN_KEY_MIN_LENGTH, RCT_PIN_KEY_ENV, rctTableHmac } from '../server/warehouse/rct-pin';

export function main(argv: string[] = process.argv.slice(2)): number {
  loadEnvFile();
  try {
    if (argv.includes('--print')) {
      const key = process.env[RCT_PIN_KEY_ENV]?.trim() ?? '';
      if (key.length < PIN_KEY_MIN_LENGTH) throw new Error(`${RCT_PIN_KEY_ENV} is not set (or shorter than ${PIN_KEY_MIN_LENGTH} chars)`);
      console.log(rctTableHmac(loadReplacementCostTable(REPLACEMENT_COST_TABLE_PATH), key));
      return 0;
    }
    const rct = loadRatifiedRct(REPLACEMENT_COST_TABLE_PATH);
    console.log(`[check-rct-pin] OK: ${REPLACEMENT_COST_TABLE_PATH} is the pinned ratified table (${rct.rctVersion})`);
    return 0;
  } catch (e) {
    console.error(`[check-rct-pin] FAIL: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

const invoked = process.argv[1] !== undefined && /check-rct-pin\.ts$/.test(process.argv[1].replace(/\\/g, '/'));
if (invoked) process.exit(main());
