// tests/unit/edge-test-helpers.ts
//
// Synthetic Oxford Edge builders for unit tests. Every value here is MADE UP (spec F14): never
// paste real markets.json numbers into tests. The trueLabels are the file's field descriptions,
// which are not licensed data.
import {
  EDGE_SERIES, SERIES_UNITS,
  type EdgeMarket, type EdgeMarketsResponse, type EdgeSeriesCell, type EdgeSeriesKey,
} from '@contracts/edge';
import { computeCoverage } from '../../server/edge/coverage';

export const TEST_YEARS: readonly number[] = [2021, 2022, 2023, 2024, 2025];

const TRUE_LABELS: Record<EdgeSeriesKey, string> = {
  pop: 'Population growth (Census PEP)',
  job: 'Total nonfarm employment growth (BLS SAE)',
  inc: 'Median household income growth (ACS5)',
  incLevel: 'Median household income, $ level (ACS5)',
  trades: 'Specialty trade contractor employment growth, NAICS 238 (QCEW)',
  biz: 'Total business establishment count growth (Census CBP)',
  hvacPermits: 'Residential building permits authorized, growth (Census BPS)',
  per: 'Industrial (Flex) construction pipeline, kSF (CoStar)',
  loss: 'Demolished SF as % of prior-year inventory (CoStar)',
  truck: 'Truck AADT growth on primary corridors (state DOT)',
  storage: 'Self-storage asking rate growth',
  rent: 'Industrial (Flex) asking rent growth (CoStar)',
  vac: 'Industrial (Flex) vacancy rate (CoStar)',
  carriers: 'New motor-carrier registrations per 10k population (FMCSA)',
  mfgInvest: 'Announced manufacturing investment $',
  ios: 'IOS/contractor-yard listing signal',
  migration: 'Net domestic migration, persons (IRS SOI)',
  eGrocery: 'Courier/messenger establishment count growth, NAICS 492 (Census CBP)',
};
const PROXIES: ReadonlySet<EdgeSeriesKey> = new Set<EdgeSeriesKey>(['biz', 'hvacPermits', 'eGrocery']);

export const TEST_FIELD_META: EdgeMarketsResponse['fieldMeta'] = Object.fromEntries(
  EDGE_SERIES.map((k) => [k, { trueLabel: TRUE_LABELS[k], isProxy: PROXIES.has(k), unit: SERIES_UNITS[k] }]),
);

export function cell(values: Array<number | null>, status: EdgeSeriesCell['status']): EdgeSeriesCell {
  if (values.length !== status.length) {
    throw new Error(`cell(): values (${values.length}) and status (${status.length}) must have equal length`);
  }
  return { values, status };
}

/** Observed where non-null, "Not published" ('null' status) where null. */
export function obs(values: Array<number | null>): EdgeSeriesCell {
  // status is derived from values, so the lengths are equal by construction.
  return { values, status: values.map((v) => (v === null ? 'null' : 'actual')) };
}

/** A factory, never a shared constant: callers may mutate the cells they get. */
const placeholder = (): EdgeSeriesCell =>
  cell([null, null, null, null, null], ['guide_only', 'guide_only', 'guide_only', 'guide_only', 'guide_only']);

export function mkMarket(
  id: string,
  name: string,
  state: string,
  type: EdgeMarket['type'],
  overrides: Partial<Record<EdgeSeriesKey, EdgeSeriesCell>> = {},
  subs: EdgeMarket['subs'] = [],
): EdgeMarket {
  const series = Object.fromEntries(EDGE_SERIES.map((k) => [k, structuredClone(overrides[k] ?? placeholder())])) as EdgeMarket['series'];
  return { id, name, state, cbsa: '00000', lat: 0, lon: 0, type, trajectory: type === 'auto' ? 'a_growing' : null, subs, series };
}

/** 3 buy-box (columbus, indianapolis_south, richmond) + 1 auto (cedar_rapids, no subs). */
export function fourMarkets(): EdgeMarket[] {
  const base: Partial<Record<EdgeSeriesKey, EdgeSeriesCell>> = {
    pop: obs([0.6, 0.7, 0.8, 0.9, 1.0]),
    trades: obs([2.0, 2.5, 3.0, 3.5, 4.0]),
    per: obs([100, 120, 140, 160, 180]),
    rent: obs([1.0, 1.2, 1.4, 1.6, 1.8]),
    vac: obs([5.0, 4.5, 4.0, 3.5, 3.0]),
    migration: obs([1000, 1100, 1200, null, null]),
    hvacPermits: obs([5.0, -3.0, 4.0, 2.0, null]),
    biz: obs([null, null, 1.0, 1.1, null]),
    eGrocery: obs([null, null, 2.0, 2.2, null]),
  };
  return [
    mkMarket('columbus', 'Columbus', 'OH', 'named', base, [{ name: 'Synthetic Sub A', vac: 3.3, rentGrowth: 1.1, invKsf: 1000 }]),
    mkMarket('indianapolis_south', 'Indianapolis (South Metro)', 'IN', 'named_custom',
      { ...base, trades: obs([1.0, 1.5, 2.0, 2.5, 6.0]) },
      [{ name: 'Synthetic Sub B', vac: 2.0, rentGrowth: 0.5, invKsf: 500 }]),
    mkMarket('cedar_rapids', 'Cedar Rapids', 'IA', 'auto',
      { ...base, trades: cell([1, 1, 1, 1, 9.0], ['actual', 'actual', 'actual', 'actual', 'estimated']) }),
    mkMarket('richmond', 'Richmond', 'VA', 'named',
      { ...base, trades: obs([0.5, 0.5, 0.5, 0.5, 0.5]), truck: obs([1.5, 2.0, -0.5, 3.0, 2.2]) },
      [{ name: 'Synthetic Sub C', vac: 4.0, rentGrowth: 1.0, invKsf: 800 }]),
  ];
}

/**
 * `overrides` are spread last and win verbatim. Overriding `markets` does NOT recompute `coverage`
 * or `marketCount` (both stay derived from the `markets` argument); override those too when a test
 * needs them consistent with a different market list.
 */
export function mkMarketsResponse(markets: EdgeMarket[], overrides: Partial<EdgeMarketsResponse> = {}): EdgeMarketsResponse {
  return {
    availability: 'ok',
    dir: 'C:/synthetic/oxford-edge/output',
    freshness: {
      metaPulled: '2026-07-14', fileMtime: '2026-07-14T18:38:00.000Z', asOf: '2026-07-14',
      ageDays: 80, staleAfterDays: 7, stale: true,
    },
    readError: null,
    lastGoodLoadedAt: '2026-10-02T12:00:00.000Z',
    years: [...TEST_YEARS],
    fieldMeta: TEST_FIELD_META,
    sources: Object.fromEntries(EDGE_SERIES.map((k) => [k, [`SYNTH_${k.toUpperCase()}`]])),
    coverage: computeCoverage(markets, TEST_YEARS),
    markets,
    rejectedMarkets: [],
    marketCount: markets.length,
    issues: [],
    outsidePullScope: { truck: [], mfgInvest: [] },
    ...overrides,
  };
}
