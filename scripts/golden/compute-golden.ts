// scripts/golden/compute-golden.ts
//
// The value-level regression lock (refute run 2026-11-11, "golden lock"). Real firm data is
// local-only (ruling 2026-11-10), so the per-entity NOI table and the cost-seg totals that used to be
// pinned as literals in tracked tests now live in gitignored golden files next to the data:
//   data/property-financials/golden.local.json   (per-entity FY and latest-period NOI, same-store YTD
//                                                 changes, point locks for otherwise-circular checks)
//   data/cost-seg/golden.local.json              (study totals and classes, calibration variances)
// They are written ONLY by `npm run golden:ratify` (scripts/ratify-golden.ts) from the data in place,
// and the tests assert exact values against them. In CI the committed synthetic copies (written by
// scripts/fixtures/build-synthetic-data.ts from the synthetic data) stand in, like every other
// manifest file. A builder / mapping / regeneration change that moves a figure fails until a human
// re-ratifies on purpose.
import { SAME_STORE } from '../../src/contracts/property-financials';
import { pctChange } from '../../src/analytics/property-financials/metrics';
import { pct } from '../../src/analytics/property-financials/format';
import { ratio, variancePct } from '../../src/analytics/calibration-ledger';
import { computeLevers } from '../../src/analytics/property-financials/levers';
import type { PfDataset } from '../../src/contracts/property-financials';
import { projectLeaseRun, DEFAULT_LEASE_RUN_ASSUMPTIONS } from '../../server/warehouse/lease-run';
import type { LeaseTerm } from '../../src/contracts/lease-run';

type Obj = Record<string, unknown>;

export const GOLDEN_PF = 'data/property-financials/golden.local.json';
export const GOLDEN_COST = 'data/cost-seg/golden.local.json';

export interface PfGolden {
  note: string;
  noi: Record<string, { FY2024: number; FY2025: number }>;
  sameStoreYtd: { baseRent: string; opexExTax: string; noi: string };
  /** TTM26 management fees / revenue per monthly entity (raw ratio, not the 2-dp dataset field). */
  mgmtFeeTtm26: Record<string, number>;
  /** Latest-period NOI per entity, rounded dollars: the YTD26 period (monthly entities) or the partial
   *  2026 period (annual entities), for every entity; it also locks the card figure of an entity
   *  whose latest period is not a full year. */
  latestNoi: Record<string, { period: string; noi: number }>;
  /** Point locks for checks that otherwise read the very figure they assert from the dataset in place
   *  (circular). Money at full precision, counts exact. */
  locks: PfLocks;
  /** Lease-run engine output per property of the operator lease-term roster at default assumptions
   *  (config/local/lease-term-seeds.json), cents. A snapshot of engine output: golden:ratify checks it
   *  against the pre-untrack Excel-model figures read from git history (./leaserun-baseline.ts). */
  leaseRun: Record<
    string,
    {
      stabilizedNoi: number | null;
      indicativeValue: number | null;
      noiByYear: Record<string, number>;
      /** Per lease year: base rent, EGR (base rent less vacancy) and the two opex lines, cents. */
      periods: Record<string, { baseRent: number; egr: number; managementFee: number; reserve: number }>;
    }
  >;
}

export interface PfLocks {
  /** Persisted rent-step events across the monthly entities (sum of history[id].ev.length). */
  rentStepEvents: number;
  /** 1100 Rarig: calendar 2025 operating expense (history) and FY2025 base rent (period). */
  rarigOpex2025: number;
  rarigBaseRentFy2025: number;
  /** 1100 Rarig Q3 base-rent run-rate pair behind the run-rate growth. */
  rarigRunRateQ3: { q3_2025: number; q3_2026: number };
  /** Net-credit opex cells the explorer tests use: 9620 Jan-Sep 2026 RE tax, 3540 calendar 2024 grounds. */
  credit9620ReTaxS26: number;
  credit3540Grounds2024: number;
  /** 3034 Westerville lease: monthly rent of the 2026-04-01 (current) and 2027-04-01 (next) steps. */
  westervilleRent: { current: number | null; next: number | null };
  /** recovery9620 lever (+10 points of the 9620 TTM26 cost pool) and 10 points of the 29000 FY2025 pool. */
  recovery9620Lever: number;
  pool29000TenPoints: number;
  /** REV-09 annual impact as shipped in dataset.json, and the mgmtFee (EXP-07) lever value. */
  rev09Impact: number | null;
  exp07Lever: number;
}

export interface CostGolden {
  note: string;
  studies: Record<string, { total: number; alloc: Record<string, number> }>;
  /** Every calibration ledger row, keyed by obs_id. */
  calibration: Record<string, { property: string; variancePct: number | null; ratio: number | null }>;
}

const NOTE = 'Value lock: written only by `npm run golden:ratify` from the data in place. Never edit by hand.';

export function computePfGolden(dataset: Obj, leaseSeeds: readonly LeaseTerm[]): PfGolden {
  const props = (dataset['properties'] ?? {}) as Record<string, Obj>;
  const noi: PfGolden['noi'] = {};
  for (const [id, p] of Object.entries(props)) {
    const per = (p['periods'] ?? {}) as Record<string, Obj>;
    const fy24 = per['FY2024']?.['noi'];
    const fy25 = per['FY2025']?.['noi'];
    if (typeof fy24 === 'number' && typeof fy25 === 'number') noi[id] = { FY2024: Math.round(fy24), FY2025: Math.round(fy25) };
  }
  const sum = (period: 'YTD25' | 'YTD26', f: (x: Obj) => number): number =>
    SAME_STORE.reduce((a, id) => a + f(((props[id]?.['periods'] ?? {}) as Record<string, Obj>)[period] ?? {}), 0);
  const tax = (x: Obj): number => Number(((x['opex_by'] ?? {}) as Obj)['Real estate & property tax'] ?? 0);
  const mgmtFeeTtm26: Record<string, number> = {};
  for (const [id, p] of Object.entries(props)) {
    const t = ((p['periods'] ?? {}) as Record<string, Obj>)['TTM26'];
    const fee = Number(((t?.['opex_by'] ?? {}) as Obj)['Management fees'] ?? NaN);
    const rev = Number(t?.['revenue'] ?? NaN);
    if (p['kind'] === 'monthly' && Number.isFinite(fee) && rev) mgmtFeeTtm26[id] = fee / rev;
  }
  const latestNoi: PfGolden['latestNoi'] = {};
  for (const [id, p] of Object.entries(props)) {
    const per = (p['periods'] ?? {}) as Record<string, Obj>;
    const keys = Object.keys(per).filter((k) => k === 'YTD26' || k.startsWith('YTD26_partial'));
    if (keys.length > 1) throw new Error(`golden: ${id} has ${keys.length} periods matching the latest-period rule (${keys.join(', ')})`);
    const key = keys[0];
    const v = key ? per[key]?.['noi'] : undefined;
    if (key && typeof v === 'number') latestNoi[id] = { period: key, noi: Math.round(v) };
  }
  return {
    note: NOTE,
    noi,
    mgmtFeeTtm26,
    latestNoi,
    locks: computeLocks(dataset),
    leaseRun: computeLeaseRunGolden(leaseSeeds),
    sameStoreYtd: {
      baseRent: pct(pctChange(sum('YTD25', (x) => Number(x['base_rent'] ?? 0)), sum('YTD26', (x) => Number(x['base_rent'] ?? 0))).value),
      opexExTax: pct(pctChange(sum('YTD25', (x) => Number(x['opex'] ?? 0) - tax(x)), sum('YTD26', (x) => Number(x['opex'] ?? 0) - tax(x))).value),
      noi: pct(pctChange(sum('YTD25', (x) => Number(x['noi'] ?? 0)), sum('YTD26', (x) => Number(x['noi'] ?? 0))).value),
    },
  };
}

// Full precision (not rounded to cents), so a toBeCloseTo(x, 2) against the lock never sits on a half cent.
const cents = (x: unknown): number => Number(x);

function computeLocks(dataset: Obj): PfLocks {
  const props = (dataset['properties'] ?? {}) as Record<string, Obj>;
  const history = (dataset['history'] ?? {}) as Record<string, Obj>;
  const period = (id: string, per: string): Obj => (((props[id]?.['periods'] ?? {}) as Record<string, Obj>)[per] ?? {}) as Obj;
  const hist = (id: string, block: 'yr' | 'ytd', y: string): Obj => (((history[id]?.[block] ?? {}) as Record<string, Obj>)[y] ?? {}) as Obj;
  const cat = (row: Obj, c: string): number => cents(((row['cats'] ?? {}) as Obj)[c]);
  let rentStepEvents = 0;
  for (const [id, p] of Object.entries(props)) {
    if (p['kind'] === 'monthly') rentStepEvents += ((history[id]?.['ev'] ?? []) as unknown[]).length;
  }
  const runRate = (props['1100 Rarig']?.['base_rent_runrate_q3'] ?? {}) as Obj;
  const lease = ((dataset['leases'] ?? []) as Obj[]).find((l) => l['property'] === '3034 Westerville');
  const rows = ((lease?.['rent_schedule_monthly'] ?? []) as Array<[string, string | null, number]>);
  const step = (from: string): number | null => {
    const r = rows.find((x) => x[0] === from);
    return r ? cents(r[2]) : null;
  };
  const levers = computeLevers(dataset as unknown as PfDataset);
  const lever = (id: string): number => cents(levers.find((l) => l.id === id)?.value.value ?? NaN);
  const rev09 = ((dataset['insights'] ?? []) as Obj[]).find((i) => i['id'] === 'REV-09')?.['annual_impact_usd'];
  return {
    rentStepEvents,
    rarigOpex2025: cents(hist('1100 Rarig', 'yr', '2025')['opex']),
    rarigBaseRentFy2025: cents(period('1100 Rarig', 'FY2025')['base_rent']),
    rarigRunRateQ3: { q3_2025: cents(runRate['q3_2025']), q3_2026: cents(runRate['q3_2026']) },
    credit9620ReTaxS26: cat(hist('9620 State 350', 'ytd', '2026'), 'Real estate & property tax'),
    credit3540Grounds2024: cat(hist('3540 E 5th', 'yr', '2024'), 'Grounds / snow / lot'),
    westervilleRent: { current: step('2026-04-01'), next: step('2027-04-01') },
    recovery9620Lever: lever('recovery9620'),
    pool29000TenPoints: cents(Number(period('29000 Info Lane', 'FY2025')['pool']) * 0.1),
    rev09Impact: typeof rev09 === 'number' ? rev09 : null,
    exp07Lever: lever('mgmtFee'),
  };
}

const toCents = (v: number): number => Math.round(v * 100) / 100;

export function computeLeaseRunGolden(seeds: readonly LeaseTerm[]): PfGolden['leaseRun'] {
  const out: PfGolden['leaseRun'] = {};
  for (const t of seeds) {
    const p = projectLeaseRun(t, DEFAULT_LEASE_RUN_ASSUMPTIONS);
    out[t.propertyId] = {
      stabilizedNoi: p.stabilizedNoi === null ? null : toCents(p.stabilizedNoi),
      indicativeValue: p.indicativeValue === null ? null : toCents(p.indicativeValue),
      noiByYear: Object.fromEntries(p.periods.map((x) => [x.leaseYearLabel, toCents(x.noi)])),
      periods: Object.fromEntries(
        p.periods.map((x) => [x.leaseYearLabel, { baseRent: toCents(x.baseRent), egr: toCents(x.egr), managementFee: toCents(x.managementFee), reserve: toCents(x.reserve) }]),
      ),
    };
  }
  return out;
}

export function computeCostGolden(costSeg: Obj, observations: unknown): CostGolden {
  const studies: CostGolden['studies'] = {};
  for (const [id, s] of Object.entries((costSeg['studies'] ?? {}) as Record<string, Obj>)) {
    studies[id] = { total: Number(s['total']), alloc: { ...((s['alloc'] ?? {}) as Record<string, number>) } };
  }
  // Every ledger row is locked, keyed by obs_id (refute round 3 F4: keying by property locked only the
  // first observation of each property).
  const calibration: CostGolden['calibration'] = {};
  for (const o of (Array.isArray(observations) ? observations : []) as Array<Obj & { pca_unit_cost: number | null; contractor_unit_cost: number | null }>) {
    const key = String(o['obs_id']);
    if (key in calibration) throw new Error(`golden: duplicate calibration obs_id ${key}`);
    calibration[key] = { property: String(o['property']), variancePct: variancePct(o), ratio: ratio(o) };
  }
  return { note: NOTE, studies, calibration };
}
