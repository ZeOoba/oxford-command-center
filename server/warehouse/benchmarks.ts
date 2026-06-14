// server/warehouse/benchmarks.ts
// Portfolio-context benchmarking + PM scorecards over PeriodMetrics[]. Pure functions
// (pmScorecards reads property_master.property_manager from the db, otherwise db-free).
// Quantiles use linear interpolation between ranks; every aggregate is null-safe over
// empty / all-null inputs (no NaN/Infinity leaks into the score engine downstream).
import type { WarehouseDb } from './db';
import { growthSeries } from './growth';
import { isOperatingRealEstate, latestFullYearPeriod } from './metrics';
import type { PeriodMetrics } from './metrics';

// Numeric PeriodMetrics keys eligible for benchmarking (number | null fields).
export type NumericMetricKey =
  | 'revenue' | 'opex' | 'noi' | 'oxfordNoi'
  | 'noiMargin' | 'expenseRatio'
  | 'revenuePerSf' | 'noiPerSf' | 'expensePerSf'
  | 'taxesPerSf' | 'insurancePerSf' | 'repairsPerSf';

export interface MetricBenchmark {
  period: string;
  metric: NumericMetricKey;
  avg: number | null;
  median: number | null;
  p25: number | null;
  p75: number | null;
  n: number;
  // Cross-basis discipline: the distinct accounting bases of the properties that contributed a
  // value to this cohort, and whether they are mixed. A benchmark drawn across cash + accrual (or
  // unknown) NOI is not a like-for-like comparison; consumers must surface mixedBasis, never compare
  // silently. 'unknown' counts as its own basis (conservative).
  bases: string[];
  mixedBasis: boolean;
}

export interface PropertyRank {
  propertyId: string;
  value: number;
  rank: number;      // 1 = highest value
  quartile: 1 | 2 | 3 | 4 | null; // 1 = top quartile; null = low-confidence singleton cohort (n<2)
}

export interface PmScorecard {
  propertyManager: string;
  propertyCount: number;
  smallSample: boolean;       // propertyCount < 3 — interpret cautiously
  avgNoiPerSf: number | null; // latest-full-year averages across the PM's properties (spec §9)
  avgNoiGrowth: number | null;
  avgExpenseGrowth: number | null;
}

/** Linear-interpolation quantile over a copy-sorted numeric array; null on empty. */
export function quantile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0]!;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const frac = pos - lo;
  const vLo = sorted[lo]!;
  const vHi = sorted[hi]!;
  return vLo + (vHi - vLo) * frac;
}

const mean = (values: number[]): number | null =>
  values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;

/** Non-null values of a numeric metric key for a given period. SF-less non-real-estate entities
 *  (e.g. a rooftop-solar PPA royalty: rentableSf null) are excluded from all cohort aggregations —
 *  their revenue/expense profiles are not comparable to building operations. Per-SF keys already
 *  self-exclude via the null perSf() value; this guard covers the revenue-ratio keys (expenseRatio,
 *  noiMargin) that stay finite for SF-less entities and would otherwise skew portfolio benchmarks. */
function metricValues(metrics: PeriodMetrics[], period: string, key: NumericMetricKey): number[] {
  const out: number[] = [];
  for (const m of metrics) {
    if (m.period !== period) continue;
    if (!isOperatingRealEstate(m)) continue;
    const v = m[key];
    if (typeof v === 'number' && Number.isFinite(v)) out.push(v);
  }
  return out;
}

/** Distinct accounting bases (sorted) of the properties that contribute a finite value to a cohort.
 *  SF-less entities are excluded (mirrors the metricValues guard) so their basis does not register
 *  as a cohort participant and cannot trigger a spurious mixedBasis flag. */
export function cohortBases(metrics: PeriodMetrics[], period: string, key: NumericMetricKey): string[] {
  const set = new Set<string>();
  for (const m of metrics) {
    if (m.period !== period) continue;
    if (!isOperatingRealEstate(m)) continue;
    const v = m[key];
    if (typeof v === 'number' && Number.isFinite(v)) set.add(m.basis ?? 'unknown');
  }
  return [...set].sort();
}

/** Portfolio average / median / p25 / p75 / n for one metric in one period. */
export function benchmarkMetric(metrics: PeriodMetrics[], period: string, key: NumericMetricKey): MetricBenchmark {
  const values = metricValues(metrics, period, key);
  const bases = cohortBases(metrics, period, key);
  return {
    period,
    metric: key,
    avg: mean(values),
    median: quantile(values, 0.5),
    p25: quantile(values, 0.25),
    p75: quantile(values, 0.75),
    n: values.length,
    bases,
    mixedBasis: bases.length > 1,
  };
}

/** Properties ranked descending by a metric for a period; quartile 1 = top performer. */
export function rankProperties(metrics: PeriodMetrics[], period: string, key: NumericMetricKey): PropertyRank[] {
  const rows: Array<{ propertyId: string; value: number }> = [];
  for (const m of metrics) {
    if (m.period !== period) continue;
    const v = m[key];
    if (typeof v === 'number' && Number.isFinite(v)) rows.push({ propertyId: m.propertyId, value: v });
  }
  // Descending by value; ties keep input order (stable) and tie-break on propertyId for determinism.
  rows.sort((a, b) => b.value - a.value || a.propertyId.localeCompare(b.propertyId));
  const values = rows.map((r) => r.value);
  // Singleton-cohort guard (spec §9): a quartile drawn from <2 non-null values is meaningless — a
  // lone property would self-rank to the top (quartile 1). Return quartile null (low-confidence)
  // so downstream consumers fall back to a neutral position instead of a bogus top quartile.
  const lowConfidence = values.length < 2;
  const p75 = quantile(values, 0.75);
  const median = quantile(values, 0.5);
  const p25 = quantile(values, 0.25);
  return rows.map((r, i) => ({
    propertyId: r.propertyId,
    value: r.value,
    rank: i + 1,
    quartile: lowConfidence ? null : quartileFor(r.value, p75, median, p25),
  }));
}

/** Quartile by value vs portfolio cutoffs: >=p75 top (1), >=median (2), >=p25 (3), else bottom (4). */
function quartileFor(value: number, p75: number | null, median: number | null, p25: number | null): 1 | 2 | 3 | 4 {
  if (p75 !== null && value >= p75) return 1;
  if (median !== null && value >= median) return 2;
  if (p25 !== null && value >= p25) return 3;
  return 4;
}

interface PmRow { propertyId: string; propertyManager: string | null }

/** PM scorecards: group properties by property_master.property_manager, aggregate each property's
 *  latest FULL-YEAR avg NOI/SF + latest comparable (same-grain) NOI/expense growth across the PM's
 *  properties with ledger data — never a trailing YTD level or a cross-grain null growth (spec §9). */
export function pmScorecards(db: WarehouseDb, metrics: PeriodMetrics[]): PmScorecard[] {
  const pmRows = db.prepare(
    `SELECT id AS propertyId, property_manager AS propertyManager FROM property_master`,
  ).all() as PmRow[];
  const pmByProperty = new Map<string, string | null>();
  for (const r of pmRows) pmByProperty.set(r.propertyId, r.propertyManager);

  // Group metrics by property, then derive each property's latest-period NOI/SF + growths.
  const byProperty = new Map<string, PeriodMetrics[]>();
  for (const m of metrics) {
    const arr = byProperty.get(m.propertyId) ?? [];
    arr.push(m);
    byProperty.set(m.propertyId, arr);
  }

  interface PropertyLatest { noiPerSf: number | null; noiGrowth: number | null; expenseGrowth: number | null }
  const latestByProperty = new Map<string, PropertyLatest>();
  for (const [propertyId, series] of byProperty) {
    const sorted = [...series].sort((a, b) => a.period.localeCompare(b.period));
    // LEVEL (spec §9): use the property's latest FULL-YEAR period for avgNoiPerSf so a trailing
    // YTD partial isn't blended with full-year peers. Fall back to the raw latest only when the
    // property has no full-year period at all (YTD-only coverage).
    const fyPeriod = latestFullYearPeriod(sorted);
    const levelRow = fyPeriod !== null
      ? sorted.find((m) => m.period === fyPeriod)!
      : sorted[sorted.length - 1]!;
    // GROWTH (spec §9): pick the latest COMPARABLE (same-grain, non-null) growth point — never the
    // cross-grain year→YTD point whose growths are null by construction. growthSeries already nulls
    // and flags those as comparable:false.
    const growth = growthSeries(sorted);
    const latestComparable = [...growth].reverse().find((g) => g.comparable) ?? null;
    latestByProperty.set(propertyId, {
      noiPerSf: levelRow.noiPerSf,
      noiGrowth: latestComparable?.noiGrowth ?? null,
      expenseGrowth: latestComparable?.expenseGrowth ?? null,
    });
  }

  // Group properties-with-data by PM.
  const byPm = new Map<string, PropertyLatest[]>();
  for (const [propertyId, latest] of latestByProperty) {
    const pm = pmByProperty.get(propertyId);
    if (!pm) continue; // no manager assigned — excluded from scorecards
    const arr = byPm.get(pm) ?? [];
    arr.push(latest);
    byPm.set(pm, arr);
  }

  const avgNonNull = (values: Array<number | null>): number | null => {
    const present = values.filter((v): v is number => v !== null && Number.isFinite(v));
    return present.length === 0 ? null : present.reduce((a, b) => a + b, 0) / present.length;
  };

  const cards: PmScorecard[] = [];
  for (const [propertyManager, list] of byPm) {
    cards.push({
      propertyManager,
      propertyCount: list.length,
      smallSample: list.length < 3,
      avgNoiPerSf: avgNonNull(list.map((p) => p.noiPerSf)),
      avgNoiGrowth: avgNonNull(list.map((p) => p.noiGrowth)),
      avgExpenseGrowth: avgNonNull(list.map((p) => p.expenseGrowth)),
    });
  }
  return cards.sort((a, b) => a.propertyManager.localeCompare(b.propertyManager));
}
