// src/analytics/property-financials/aggregate.ts
//
// Rebuilds the Property Financials dataset figures from monthly-long.csv alone, so the committed JSON
// can be proven against its flat source (plan T3; tests/unit/property-financials-reconcile.test.ts
// ties every figure of every entity and period to the cent). Also the aggregation core the refresh
// pipeline (T9) will reuse.
//
// Normalized NOI (data-dictionary.md "Definitions") = sum of `rev` rows - sum of `opex` rows. Capex,
// distributions, debt service, non-operating, entity income tax and non-cash rows are carried as
// below-line figures or ignored, never netted into NOI. Security-deposit receipts do not exist as CSV
// rows (excluded upstream); prepaid-rent rows are revenue rows under "Vacancy / waivers / bad debt"
// and are counted, matching the dataset.
//
// Pure TypeScript: no fs.
import {
  ANNUAL_PARTIAL_PERIOD,
  OPEX_CATEGORIES,
  REVENUE_CATEGORIES,
  type AnnualPeriodId,
  type OpexCategory,
  type PfMonthFigures,
  type PfOpexBy,
  type RevenueCategory,
  type StandardPeriodId,
} from '@contracts/property-financials';
import { parseCsv } from './csv';
import { recoveryPool } from './metrics';

export const LINE_TYPES = ['rev', 'opex', 'capex', 'dist', 'debt', 'nonop', 'inctax', 'noncash'] as const;
export type LineType = (typeof LINE_TYPES)[number];

export const MONTHLY_LONG_HEADER = ['entity', 'period', 'line_type', 'category', 'source_account', 'amount_usd'] as const;

export interface MonthlyLongRow {
  readonly entity: string;
  /** `YYYY-MM` for monthly exports; `YYYY-FY` / `2026-YTD(thru 2026-06-12)` for annual statements. */
  readonly period: string;
  readonly line_type: LineType;
  readonly category: string;
  readonly source_account: string;
  readonly amount_usd: number;
}

const LINE_TYPE_SET: ReadonlySet<string> = new Set(LINE_TYPES);

/** Parse monthly-long.csv text into typed rows. Throws on a bad header or any malformed row. */
export function parseMonthlyLong(text: string): MonthlyLongRow[] {
  const grid = parseCsv(text);
  const header = grid[0];
  if (!header || header.length !== MONTHLY_LONG_HEADER.length || header.some((h, i) => h !== MONTHLY_LONG_HEADER[i])) {
    throw new Error(`monthly-long.csv: unexpected header [${(header ?? []).join(', ')}]; expected [${MONTHLY_LONG_HEADER.join(', ')}]`);
  }
  const rows: MonthlyLongRow[] = [];
  for (let r = 1; r < grid.length; r++) {
    const cells = grid[r]!;
    const rowNo = r + 1;
    if (cells.length !== 6) throw new Error(`monthly-long.csv row ${rowNo}: expected 6 columns, got ${cells.length}`);
    const [entity, period, lineType, category, account, amountText] = cells as [string, string, string, string, string, string];
    if (!entity) throw new Error(`monthly-long.csv row ${rowNo}: empty entity`);
    if (!period) throw new Error(`monthly-long.csv row ${rowNo}: empty period`);
    if (!LINE_TYPE_SET.has(lineType)) throw new Error(`monthly-long.csv row ${rowNo}: unknown line_type`);
    if (!/^-?\d+(\.\d+)?$/.test(amountText.trim())) throw new Error(`monthly-long.csv row ${rowNo}: amount_usd is not a decimal number`);
    const amount = Number(amountText);
    if (!Number.isFinite(amount)) throw new Error(`monthly-long.csv row ${rowNo}: amount_usd is not finite`);
    rows.push({ entity, period, line_type: lineType as LineType, category, source_account: account, amount_usd: amount });
  }
  return rows;
}

/** entity -> period key -> rows. */
export type RowIndex = ReadonlyMap<string, ReadonlyMap<string, readonly MonthlyLongRow[]>>;

export function indexRows(rows: readonly MonthlyLongRow[]): RowIndex {
  const index = new Map<string, Map<string, MonthlyLongRow[]>>();
  for (const r of rows) {
    let byPeriod = index.get(r.entity);
    if (!byPeriod) {
      byPeriod = new Map();
      index.set(r.entity, byPeriod);
    }
    let list = byPeriod.get(r.period);
    if (!list) {
      list = [];
      byPeriod.set(r.period, list);
    }
    list.push(r);
  }
  return index;
}

/** CSV period keys of the annual (QuickBooks entity) statements. */
export const ANNUAL_CSV_PERIOD_KEYS: Readonly<Record<AnnualPeriodId, string>> = {
  FY2024: '2024-FY',
  FY2025: '2025-FY',
  [ANNUAL_PARTIAL_PERIOD]: '2026-YTD(thru 2026-06-12)',
};

type PeriodMonths = Readonly<Record<StandardPeriodId, { readonly months: readonly string[] }>>;

/** The CSV period keys that make up a dataset period for an entity kind. */
export function periodKeysFor(periodId: string, kind: 'monthly' | 'annual', periods: PeriodMonths): readonly string[] {
  if (kind === 'annual') {
    const key = (ANNUAL_CSV_PERIOD_KEYS as Record<string, string | undefined>)[periodId];
    if (!key) throw new Error(`no annual CSV period key for ${periodId}`);
    return [key];
  }
  const def = (periods as Record<string, { months: readonly string[] } | undefined>)[periodId];
  if (!def) throw new Error(`no month list for period ${periodId}`);
  return def.months;
}

export interface RebuiltPeriod {
  readonly base_rent: number;
  readonly vacancy_waivers: number;
  readonly reimbursements: number;
  readonly recoveries: number;
  readonly utility_reimb: number;
  readonly other_income: number;
  readonly energy_income: number;
  readonly revenue: number;
  readonly opex: number;
  readonly noi: number;
  readonly noi_margin: number | null;
  readonly opex_ratio: number | null;
  readonly mgmt_fee_pct: number | null;
  readonly recovery_ratio: number | null;
  readonly pool: number;
  readonly capex: number;
  readonly dist: number;
  readonly opex_by: PfOpexBy;
  /** Period keys in the window that carry at least one row. */
  readonly n_months: number;
}

const REVENUE_SET: ReadonlySet<string> = new Set(REVENUE_CATEGORIES);
const OPEX_SET: ReadonlySet<string> = new Set(OPEX_CATEGORIES);

function emptyOpexBy(): Record<OpexCategory, number> {
  return Object.fromEntries(OPEX_CATEGORIES.map((c) => [c, 0])) as Record<OpexCategory, number>;
}

/**
 * Sum one entity's rows over a set of CSV period keys into the dataset period shape. Unknown revenue
 * or opex categories throw: an unmapped account must fail the rebuild, not vanish from NOI.
 */
export function aggregateRows(index: RowIndex, entity: string, periodKeys: readonly string[]): RebuiltPeriod {
  const byPeriod = index.get(entity);
  const rev = Object.fromEntries(REVENUE_CATEGORIES.map((c) => [c, 0])) as Record<RevenueCategory, number>;
  const opexBy = emptyOpexBy();
  let capex = 0;
  let dist = 0;
  let nMonths = 0;

  for (const key of periodKeys) {
    const rows = byPeriod?.get(key);
    if (!rows || rows.length === 0) continue;
    nMonths++;
    for (const r of rows) {
      switch (r.line_type) {
        case 'rev': {
          if (!REVENUE_SET.has(r.category)) throw new Error(`${entity}/${key}: unknown revenue category "${r.category}"`);
          rev[r.category as RevenueCategory] += r.amount_usd;
          break;
        }
        case 'opex': {
          if (!OPEX_SET.has(r.category)) throw new Error(`${entity}/${key}: unknown opex category "${r.category}"`);
          opexBy[r.category as OpexCategory] += r.amount_usd;
          break;
        }
        case 'capex':
          capex += r.amount_usd;
          break;
        case 'dist':
          dist += r.amount_usd;
          break;
        default:
          // debt / nonop / inctax / noncash: below the line, never in NOI.
          break;
      }
    }
  }

  const base_rent = rev['Base rent'];
  const vacancy_waivers = rev['Vacancy / waivers / bad debt'];
  const recoveries = rev['Recoveries (CAM/tax/ins)'];
  const utility_reimb = rev['Utility reimbursements'];
  const other_income = rev['Other income'];
  const energy_income = rev['Solar / energy income'];
  const revenue = REVENUE_CATEGORIES.reduce((a, c) => a + rev[c], 0);
  const opex = OPEX_CATEGORIES.reduce((a, c) => a + opexBy[c], 0);
  const noi = revenue - opex;
  const pool = recoveryPool(opexBy);
  const ratio = (num: number, den: number): number | null => (den > 0 ? num / den : null);

  return {
    base_rent,
    vacancy_waivers,
    reimbursements: recoveries + utility_reimb,
    recoveries,
    utility_reimb,
    other_income,
    energy_income,
    revenue,
    opex,
    noi,
    noi_margin: ratio(noi, revenue),
    opex_ratio: ratio(opex, revenue),
    mgmt_fee_pct: ratio(opexBy['Management fees'], revenue),
    recovery_ratio: ratio(recoveries + utility_reimb, pool),
    pool,
    capex,
    dist,
    opex_by: opexBy,
    n_months: nMonths,
  };
}

/** Every dataset period for one entity. */
export function rebuildPeriods(
  index: RowIndex,
  entity: string,
  kind: 'monthly' | 'annual',
  periods: PeriodMonths,
): Record<string, RebuiltPeriod> {
  const ids: readonly string[] = kind === 'monthly' ? Object.keys(periods) : Object.keys(ANNUAL_CSV_PERIOD_KEYS);
  return Object.fromEntries(ids.map((id) => [id, aggregateRows(index, entity, periodKeysFor(id, kind, periods))]));
}

/** One cube month for a monthly entity; null when the CSV has no rows for that month (missing export). */
export function rebuildMonth(index: RowIndex, entity: string, month: string): PfMonthFigures | null {
  if (!index.get(entity)?.get(month)?.length) return null;
  const a = aggregateRows(index, entity, [month]);
  return {
    base_rent: a.base_rent,
    reimbursements: a.reimbursements,
    other_income: a.other_income,
    vacancy_waivers: a.vacancy_waivers,
    revenue: a.revenue,
    opex: a.opex,
    noi: a.noi,
    capex: a.capex,
    opex_by: a.opex_by,
  };
}
