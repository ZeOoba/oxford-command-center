// scripts/golden/compute-golden.ts
//
// The value-level regression lock (refute run 2026-11-11, "golden lock"). Real firm data is
// local-only (ruling 2026-11-10), so the per-entity NOI table and the cost-seg totals that used to be
// pinned as literals in tracked tests now live in gitignored golden files next to the data:
//   data/property-financials/golden.local.json   (per-entity FY NOI, same-store YTD changes)
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

type Obj = Record<string, unknown>;

export const GOLDEN_PF = 'data/property-financials/golden.local.json';
export const GOLDEN_COST = 'data/cost-seg/golden.local.json';

export interface PfGolden {
  note: string;
  noi: Record<string, { FY2024: number; FY2025: number }>;
  sameStoreYtd: { baseRent: string; opexExTax: string; noi: string };
  /** TTM26 management fees / revenue per monthly entity (raw ratio, not the 2-dp dataset field). */
  mgmtFeeTtm26: Record<string, number>;
}

export interface CostGolden {
  note: string;
  studies: Record<string, { total: number; alloc: Record<string, number> }>;
  calibration: Record<string, { variancePct: number | null; ratio: number | null }>;
}

const NOTE = 'Value lock: written only by `npm run golden:ratify` from the data in place. Never edit by hand.';

export function computePfGolden(dataset: Obj): PfGolden {
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
  return {
    note: NOTE,
    noi,
    mgmtFeeTtm26,
    sameStoreYtd: {
      baseRent: pct(pctChange(sum('YTD25', (x) => Number(x['base_rent'] ?? 0)), sum('YTD26', (x) => Number(x['base_rent'] ?? 0))).value),
      opexExTax: pct(pctChange(sum('YTD25', (x) => Number(x['opex'] ?? 0) - tax(x)), sum('YTD26', (x) => Number(x['opex'] ?? 0) - tax(x))).value),
      noi: pct(pctChange(sum('YTD25', (x) => Number(x['noi'] ?? 0)), sum('YTD26', (x) => Number(x['noi'] ?? 0))).value),
    },
  };
}

export function computeCostGolden(costSeg: Obj, observations: unknown): CostGolden {
  const studies: CostGolden['studies'] = {};
  for (const [id, s] of Object.entries((costSeg['studies'] ?? {}) as Record<string, Obj>)) {
    studies[id] = { total: Number(s['total']), alloc: { ...((s['alloc'] ?? {}) as Record<string, number>) } };
  }
  const calibration: CostGolden['calibration'] = {};
  for (const o of (Array.isArray(observations) ? observations : []) as Array<Obj & { pca_unit_cost: number | null; contractor_unit_cost: number | null }>) {
    const key = String(o['property']);
    if (!(key in calibration)) calibration[key] = { variancePct: variancePct(o), ratio: ratio(o) };
  }
  return { note: NOTE, studies, calibration };
}
