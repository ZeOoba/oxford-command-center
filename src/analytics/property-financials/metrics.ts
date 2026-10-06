// src/analytics/property-financials/metrics.ts
//
// Pure calculations over the Property Financials dataset shapes (src/contracts/property-financials.ts).
// Every ratio that can be undefined returns a MetricResult (periods.ts) rather than NaN / 0 so the UI
// renders "n/m" with a reason. Parity with the dataset's own derived blocks (recovery_ratio, pool,
// base_rent_runrate_q3, history[].ev, history[].drv[].nat) is pinned in
// tests/unit/property-financials-golden.test.ts and tests/unit/property-financials-reconcile.test.ts.
//
// Pure TypeScript: no React, no fs.
import type {
  OpexCategory,
  PfDriverNature,
  PfMonthlyProperty,
  PfOpexBy,
  PfRentStepEvent,
  PfSfEntry,
} from '@contracts/property-financials';
import { notMeaningful, ok, partialReason, type MetricResult } from './periods';
import { THRESHOLDS, type EvaluationTestId, type EvaluationThreshold } from './thresholds';

const RE_TAX: OpexCategory = 'Real estate & property tax';

// -------------------------------------------------------------------------------------------------
// Percent change / YoY
// -------------------------------------------------------------------------------------------------

/** current / prior - 1. Refuses a missing, non-finite, zero or negative base. */
export function pctChange(prior: number | null | undefined, current: number | null | undefined): MetricResult {
  if (prior === null || prior === undefined || !Number.isFinite(prior)) return notMeaningful('no prior-period value');
  if (current === null || current === undefined || !Number.isFinite(current)) return notMeaningful('no current-period value');
  if (prior <= 0) return notMeaningful('prior-period base is zero or negative');
  return ok(current / prior - 1);
}

/**
 * Compound annual growth from `first` to `last` over `years`. Refuses a non-positive base or end
 * (the growth rate is undefined there) and a non-positive span.
 */
export function cagr(first: number | null | undefined, last: number | null | undefined, years: number): MetricResult {
  if (first === null || first === undefined || !Number.isFinite(first) || first <= 0) return notMeaningful('starting base is zero or negative');
  if (last === null || last === undefined || !Number.isFinite(last) || last <= 0) return notMeaningful('ending value is zero or negative');
  if (!(years > 0) || !Number.isFinite(years)) return notMeaningful('no span of years');
  return ok(Math.pow(last / first, 1 / years) - 1);
}

/** num / den as a MetricResult; refuses a zero / negative / missing denominator. */
export function ratio(num: number | null | undefined, den: number | null | undefined, reason = 'no revenue in the period'): MetricResult {
  if (num === null || num === undefined || !Number.isFinite(num)) return notMeaningful('no amount');
  if (den === null || den === undefined || !Number.isFinite(den) || den <= 0) return notMeaningful(reason);
  return ok(num / den);
}

export interface PeriodWindow {
  readonly id: string;
  readonly n_months: number;
}

/** Year-over-year change. A partial period on EITHER side refuses before any arithmetic. */
export function yoy(args: {
  current: number | null | undefined;
  prior: number | null | undefined;
  currentPeriod: PeriodWindow;
  priorPeriod: PeriodWindow;
}): MetricResult {
  for (const side of [args.currentPeriod, args.priorPeriod]) {
    const reason = partialReason(side.id, side.n_months);
    if (reason !== null) return notMeaningful(`${side.id}: ${reason}`);
  }
  return pctChange(args.prior, args.current);
}

// -------------------------------------------------------------------------------------------------
// Per-SF
// -------------------------------------------------------------------------------------------------

/**
 * amount / CURRENT total SF. Never annualizes: a Jan-Sep amount yields a 9-month $/SF
 * (data-dictionary.md v03 "Rules").
 */
export function perSf(amount: number | null | undefined, totalSf: number | null | undefined): MetricResult {
  if (totalSf === null || totalSf === undefined || !Number.isFinite(totalSf) || totalSf <= 0) {
    return notMeaningful('no square footage on file');
  }
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return notMeaningful('no amount');
  return ok(amount / totalSf);
}

// -------------------------------------------------------------------------------------------------
// Recovery ratio
// -------------------------------------------------------------------------------------------------

export const RECOVERY_POOL_CATEGORIES: readonly OpexCategory[] = [
  'Real estate & property tax',
  'Insurance',
  'Utilities',
  'Grounds / snow / lot',
  'Repairs & maintenance',
];

/** Recoverable cost pool: tax + insurance + utilities + grounds + R&M. */
export function recoveryPool(opexBy: Readonly<Partial<Record<OpexCategory, number>>>): number {
  return RECOVERY_POOL_CATEGORIES.reduce((a, c) => a + (opexBy[c] ?? 0), 0);
}

export interface RecoveryInputs {
  readonly recoveries: number;
  readonly utility_reimb: number;
  readonly opex_by: Readonly<Partial<Record<OpexCategory, number>>>;
}

/**
 * (recoveries + utility reimbursements) / pool. The dataset carries no NNN flag, so single-tenant
 * NNN treatment is the caller's call via `singleTenantNnn` (those assets pay tax/insurance directly
 * and read low by design).
 */
export function recoveryRatio(fig: RecoveryInputs, opts: { singleTenantNnn?: boolean } = {}): MetricResult {
  if (opts.singleTenantNnn) return notMeaningful('not meaningful for a single-tenant NNN asset that pays taxes and insurance directly');
  const pool = recoveryPool(fig.opex_by);
  if (pool <= 0) return notMeaningful('no recoverable cost pool in the period');
  return ok((fig.recoveries + fig.utility_reimb) / pool);
}

// -------------------------------------------------------------------------------------------------
// Q3 base-rent run-rate
// -------------------------------------------------------------------------------------------------

type MonthlyBaseRent = Readonly<Record<string, { readonly base_rent: number }>>;

/** Average Jul-Sep base rent x 12 for `year`; null unless all three months exist. */
export function q3RunRate(monthly: MonthlyBaseRent, year: number): number | null {
  const keys = ['07', '08', '09'].map((m) => `${year}-${m}`);
  const vals = keys.map((k) => monthly[k]?.base_rent);
  if (vals.some((v) => v === undefined || !Number.isFinite(v))) return null;
  const sum = (vals as number[]).reduce((a, b) => a + b, 0);
  return (sum / 3) * 12;
}

export interface RunRateQ3Table {
  readonly q3_2024: number | null;
  readonly q3_2025: number | null;
  readonly q3_2026: number | null;
  readonly yoy_2025: MetricResult;
  readonly yoy_2026: MetricResult;
}

/** Q3 vs Q3 — the same table the dataset carries as base_rent_runrate_q3. */
export function runRateQ3Table(monthly: MonthlyBaseRent): RunRateQ3Table {
  const q3_2024 = q3RunRate(monthly, 2024);
  const q3_2025 = q3RunRate(monthly, 2025);
  const q3_2026 = q3RunRate(monthly, 2026);
  return {
    q3_2024,
    q3_2025,
    q3_2026,
    yoy_2025: q3_2024 === null || q3_2025 === null ? notMeaningful('needs a full Jul-Sep in both years') : pctChange(q3_2024, q3_2025),
    yoy_2026: q3_2025 === null || q3_2026 === null ? notMeaningful('needs a full Jul-Sep in both years') : pctChange(q3_2025, q3_2026),
  };
}

// -------------------------------------------------------------------------------------------------
// Same-store series
// -------------------------------------------------------------------------------------------------

/** Trailing average over `window` points; null until the window is full or when any point is null. */
export function trailingAverage(values: ReadonlyArray<number | null>, window = 3): Array<number | null> {
  return values.map((_, i) => {
    if (i < window - 1) return null;
    const slice = values.slice(i - window + 1, i + 1);
    if (slice.some((v) => v === null || !Number.isFinite(v))) return null;
    return (slice as number[]).reduce((a, b) => a + b, 0) / window;
  });
}

type MonthlyCubeLike = Readonly<Record<string, Readonly<Record<string, { readonly base_rent: number; readonly opex: number; readonly opex_by: Readonly<Partial<Record<OpexCategory, number>>> }>>>>;

export interface SameStoreSeries {
  readonly months: readonly string[];
  /** 3-month trailing average of summed base rent; null until the window fills or when a member lacks a month. */
  readonly baseRent: ReadonlyArray<number | null>;
  /** 3-month trailing average of summed opex EXCLUDING real estate tax (cash-timing lumps). */
  readonly opexExTax: ReadonlyArray<number | null>;
}

/** Monthly same-store base rent vs opex excl. RE tax, 3-month trailing. A missing export is null, never 0. */
export function sameStoreSeries(cube: MonthlyCubeLike, members: readonly string[], months: readonly string[]): SameStoreSeries {
  const sumOver = (f: (m: { base_rent: number; opex: number; opex_by: Readonly<Partial<Record<OpexCategory, number>>> }) => number) =>
    months.map((month) => {
      let total = 0;
      for (const id of members) {
        const cell = cube[id]?.[month];
        if (!cell) return null;
        total += f(cell);
      }
      return total;
    });
  return {
    months,
    baseRent: trailingAverage(sumOver((m) => m.base_rent)),
    opexExTax: trailingAverage(sumOver((m) => m.opex - (m.opex_by[RE_TAX] ?? 0))),
  };
}

// -------------------------------------------------------------------------------------------------
// Driver nature
// -------------------------------------------------------------------------------------------------

export const DRIVER_NATURE_RULES = {
  /** Top month holds at least this share of the period total ... */
  lumpyTopShare: 0.5,
  /** ... over at most this many active months. */
  lumpyMaxActiveMonths: 6,
  /** Or at most this many active months regardless of concentration. */
  lumpyFewMonths: 2,
  /** Billed in at least this many months reads as a run-rate change. */
  recurringMinMonths: 6,
} as const;

export interface DriverTiming {
  /** Months in the period with a non-zero posting. */
  readonly activeMonths: number;
  /**
   * Share of the period's gross activity (sum of |amount|) held by the single largest |month|.
   * Sign-insensitive on purpose: contra-revenue and reversal accounts post negatives, and a
   * signed max / signed total would read > 1 or < 0 there. Matches history[].drv[].conc.
   */
  readonly topShare: number;
  /** Month with the largest |amount|; null when nothing posted. */
  readonly topMonth: string | null;
  /** Signed period total. */
  readonly total: number;
}

/** Timing profile of one account over the months of a period. */
export function driverTiming(amountsByMonth: ReadonlyArray<{ month: string; amount: number }>): DriverTiming {
  let total = 0;
  // The share is taken in integer cents: summing float dollars drifts (0.10 + 0.20 + 0.30 =
  // 0.6000000000000001), which turned an exact 50% top month into 49.999...% and 'mixed'.
  let grossCents = 0;
  let activeMonths = 0;
  let top: { month: string; amount: number } | null = null;
  for (const x of amountsByMonth) {
    if (x.amount !== 0) activeMonths++;
    total += x.amount;
    grossCents += Math.round(Math.abs(x.amount) * 100);
    if (top === null || Math.abs(x.amount) > Math.abs(top.amount)) top = x;
  }
  const topShare = grossCents > 0 && top !== null ? Math.round(Math.abs(top.amount) * 100) / grossCents : 0;
  return { activeMonths, topShare, topMonth: top && top.amount !== 0 ? top.month : null, total };
}

/** Float slack for share-vs-threshold comparisons: far below a cent of any real period total. */
const SHARE_EPSILON = 1e-9;

/**
 * 'annual' for annual-only entities; 'lumpy' when one month holds >= 50% of the period over <= 6
 * active months or there are <= 2 active months; 'recurring' when billed in >= 6 months; else 'mixed'.
 * A hypothesis from timing, not proof (data-dictionary.md v02).
 */
export function driverNature(input: { annualOnly?: boolean; activeMonths: number; topShare: number }): PfDriverNature {
  if (input.annualOnly) return 'annual';
  const r = DRIVER_NATURE_RULES;
  if (input.activeMonths <= r.lumpyFewMonths) return 'lumpy';
  if (input.topShare >= r.lumpyTopShare - SHARE_EPSILON && input.activeMonths <= r.lumpyMaxActiveMonths) return 'lumpy';
  if (input.activeMonths >= r.recurringMinMonths) return 'recurring';
  return 'mixed';
}

// -------------------------------------------------------------------------------------------------
// Rent-step events
// -------------------------------------------------------------------------------------------------

export const RENT_STEP_RULES = {
  /** Months in each of the before / after windows. */
  window: 3,
  /** Minimum relative step between the window medians. */
  minPct: 0.02,
  /** Minimum absolute step per month. */
  minDollars: 500,
  /** Minimum months since the previous detected step. */
  minGapMonths: 4,
  /**
   * Null and zero months (missing exports, pre-lease months) are dropped from a window; a window
   * needs at least this many real values to produce a median.
   */
  minWindowValues: 2,
  /**
   * The step month itself must already have moved at least this fraction of the way from the old
   * level (a) to the new level (b) — a lone outlier three months out is not a step that "persisted".
   */
  minProgress: 0.5,
} as const;

export function median(values: readonly number[]): number {
  if (values.length === 0) throw new RangeError('median of empty list');
  const s = [...values].sort((x, y) => x - y);
  const n = s.length;
  return n % 2 === 1 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
}

function realValues(slice: ReadonlyArray<number | null>): number[] {
  return slice.filter((v): v is number => v !== null && Number.isFinite(v) && v > 0);
}

/**
 * Net base-rent steps visible in a monthly series: at month m, b = median of the `window` months
 * from m, a = median of the `window` months before m; a step when |b/a - 1| >= minPct and
 * |b - a| >= minDollars, at least minGapMonths after the previous step. Reproduces
 * history[entity].ev for all 62 events in the committed dataset.
 */
export function rentStepEvents(
  months: readonly string[],
  baseRent: ReadonlyArray<number | null>,
  rules: typeof RENT_STEP_RULES = RENT_STEP_RULES,
): PfRentStepEvent[] {
  if (months.length !== baseRent.length) throw new RangeError('months and baseRent must be parallel');
  const w = rules.window;
  const out: PfRentStepEvent[] = [];
  let lastIndex = Number.NEGATIVE_INFINITY;
  for (let i = w; i + w - 1 < baseRent.length; i++) {
    const before = realValues(baseRent.slice(i - w, i));
    const after = realValues(baseRent.slice(i, i + w));
    if (before.length < rules.minWindowValues || after.length < rules.minWindowValues) continue;
    const a = median(before);
    const b = median(after);
    const pctStep = b / a - 1;
    if (Math.abs(pctStep) < rules.minPct || Math.abs(b - a) < rules.minDollars) continue;
    if (i - lastIndex < rules.minGapMonths) continue;
    const m = baseRent[i];
    if (m === null || m === undefined || !Number.isFinite(m) || m <= 0) continue;
    if ((m - a) / (b - a) < rules.minProgress) continue;
    out.push({ m: months[i]!, a, b, pct: Number(pctStep.toFixed(4)) });
    lastIndex = i;
  }
  return out;
}

// -------------------------------------------------------------------------------------------------
// Scorecard inputs
// -------------------------------------------------------------------------------------------------

/**
 * Jan-Sep growth: rule 1 first (a partial period on EITHER side never produces a YoY — periods.ts),
 * then the test's prior-base floor. The order matters for the reason shown: Livingston's 3-month 2025
 * window is refused as partial, not as a small base.
 */
function growthWithFloor(prior: PeriodWindow & { amount: number }, current: PeriodWindow & { amount: number }, floor: number): MetricResult {
  for (const side of [current, prior]) {
    const reason = partialReason(side.id, side.n_months);
    if (reason !== null) return notMeaningful(`${side.id}: ${reason}`);
  }
  if (!(prior.amount > floor)) return notMeaningful(`prior-period base is $${Math.round(floor).toLocaleString('en-US')} or less`);
  return ok(current.amount / prior.amount - 1);
}

function ratioOf(num: number, den: number, reason: string): MetricResult {
  return den > 0 ? ok(num / den) : notMeaningful(reason);
}

type ThresholdConfig = Readonly<Record<EvaluationTestId, EvaluationThreshold>>;

/**
 * The eight evaluation-test inputs for one monthly property, exactly as the reference artifact
 * computes them, each as a MetricResult so an n/m carries its reason: ratios on TTM26, run-rate
 * Q3-26 vs Q3-25, utility / repairs growth Jan-Sep vs Jan-Sep — n/m when either Jan-Sep window is
 * partial (rule 1), then gated on a prior base above the test's minPriorBase (read from the
 * `thresholds` passed in, so the guard and the RAG boundaries come from one config).
 *
 * Pass the property's monthly cube to compute the run-rate growth exactly; without it the
 * dataset's 2-dp `base_rent_runrate_q3.yoy_2026` is used (what the artifact displays).
 */
export function evaluationResults(p: PfMonthlyProperty, monthly?: MonthlyBaseRent, thresholds: ThresholdConfig = THRESHOLDS): Record<EvaluationTestId, MetricResult> {
  const t = p.periods.TTM26;
  const y25 = p.periods.YTD25;
  const y26 = p.periods.YTD26;
  const ytd = (c: OpexCategory) => [
    { id: 'YTD25', n_months: y25.n_months, amount: y25.opex_by[c] },
    { id: 'YTD26', n_months: y26.n_months, amount: y26.opex_by[c] },
  ] as const;
  const noRevenue = 'no revenue in the period';
  const ttmPartial = partialReason('TTM26', t.n_months);
  const onTtm = (r: MetricResult): MetricResult => (ttmPartial !== null && r.value !== null ? notMeaningful(`TTM: ${ttmPartial}`) : r);
  const runRate: MetricResult = monthly
    ? runRateQ3Table(monthly).yoy_2026
    : p.base_rent_runrate_q3.yoy_2026 === null
      ? notMeaningful('needs a full Jul-Sep in both years')
      : ok(p.base_rent_runrate_q3.yoy_2026);
  return {
    noiMargin: onTtm(ratioOf(t.noi, t.revenue, noRevenue)),
    opexExTaxRatio: onTtm(ratioOf(t.opex - t.opex_by[RE_TAX], t.revenue, noRevenue)),
    recoveryRatio: onTtm(recoveryRatio(t)),
    mgmtFeePct: onTtm(ratioOf(t.opex_by['Management fees'], t.revenue, noRevenue)),
    contraRevenue: onTtm(ratioOf(Math.abs(t.vacancy_waivers), t.base_rent, 'no base rent in the period')),
    rentRunRateGrowth: runRate,
    utilityGrowth: growthWithFloor(...ytd('Utilities'), thresholds.utilityGrowth.minPriorBase ?? 0),
    repairsGrowth: growthWithFloor(...ytd('Repairs & maintenance'), thresholds.repairsGrowth.minPriorBase ?? 0),
  };
}

/** evaluationResults without the reasons (null = n/m). */
export function evaluationInputs(p: PfMonthlyProperty, monthly?: MonthlyBaseRent, thresholds: ThresholdConfig = THRESHOLDS): Record<EvaluationTestId, number | null> {
  const r = evaluationResults(p, monthly, thresholds);
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.value])) as Record<EvaluationTestId, number | null>;
}

// -------------------------------------------------------------------------------------------------
// FVC mapping flag
// -------------------------------------------------------------------------------------------------

export const FVC_MAPPING_FLAG_ID = 'FVC_SEPICH_MAPPING_INFERRED';

export interface FvcMappingFlag {
  readonly id: typeof FVC_MAPPING_FLAG_ID;
  /** True while the dataset still describes the FVC -> Sepich-portfolio SF mapping as inferred / to confirm. */
  readonly active: boolean;
  readonly text: string;
}

/**
 * The FVC square footage is mapped to the Sepich portfolio by reconciliation, not by a property-level
 * export (data-dictionary.md v03). The flag stays up until the note no longer carries the
 * inferred / confirm language — clearing it is a data change, not a code change.
 */
export function fvcSepichMappingFlag(sf: Pick<PfSfEntry, 'note'>): FvcMappingFlag {
  const active = /\binferred\b/i.test(sf.note) || /\bconfirm\.?(\s|$)/i.test(sf.note);
  return { id: FVC_MAPPING_FLAG_ID, active, text: active ? sf.note : '' };
}

/** Full-category opex map with zeros for the categories a sparse history row omits. */
export function fillOpexBy(partial: Readonly<Partial<Record<OpexCategory, number>>>, categories: readonly OpexCategory[]): PfOpexBy {
  return Object.fromEntries(categories.map((c) => [c, partial[c] ?? 0])) as PfOpexBy;
}
