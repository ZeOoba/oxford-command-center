// tests/unit/lease-run-fixtures.ts
//
// The lease-run engine tests run on the committed SYNTHETIC lease-term roster
// (fixtures/synthetic/config/local/lease-term-seeds.json): the real roster is local-only operator data
// (config/local/lease-term-seeds.json, ruling 2026-11-10). The synthetic rows keep the real structure
// (SF, statuses, dates, a flat-then-step contractual schedule with option_assumed tail and stale floors;
// a 2%/yr fixed schedule with exercised renewal and option_contractual tail); every rent is invented.
// On the REAL roster the engine output is locked by the ratified golden (a snapshot of engine output,
// checked at ratify time against the pre-untrack Excel-model figures from git history).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LeaseTerm } from '../../src/contracts/lease-run';

const rows = JSON.parse(readFileSync(join(__dirname, '../../fixtures/synthetic/config/local/lease-term-seeds.json'), 'utf8')) as unknown[];

export const SYNTHETIC_LEASE_TERM_SEEDS: LeaseTerm[] = rows.map((r) => LeaseTerm.parse(r));
/** 5,130 SF absolute NNN: LY'27–28 $70,000, LY'29–33 $80,000, LY'34–43 option_assumed. */
export const SUNBURST_LIKE: LeaseTerm = SYNTHETIC_LEASE_TERM_SEEDS.find((t) => t.propertyId === '401-sunburst-hwy-cambridge-md')!;
/** 24,000 SF NNN: LY'26 $90,000 then +2%/yr; LY'27–31 renewal_exercised, LY'32–36 option_contractual. */
export const FISHEL_LIKE: LeaseTerm = SYNTHETIC_LEASE_TERM_SEEDS.find((t) => t.propertyId === '7658-fishel-dr-n-dublin-oh')!;
