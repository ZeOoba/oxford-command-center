// src/modules/property-financials/explorer-model.ts
//
// The pure view-model of the Property explorer (plan T7; reference artifact "PROPERTY EXPLORER"
// block, tests/fixtures/property-financials/reference-artifact.html). Built ONLY from the dataset's
// history[entity] / sf / leases / insights blocks and the calc library (pctChange, perSf, cagr,
// ratio, recoveryRatio, trailingAverage, median, fvcSepichMappingFlag); components render the
// strings and numbers this returns and do no arithmetic on dataset figures.
//
// Every rule threshold the artifact hard-coded inside its insight closures lives in ONE exported
// config, EXPLORER_RULES, so an edit moves exactly the rule it governs (pinned in
// tests/unit/property-financials-explorer-model.test.ts).
//
// Departures from the artifact (intentional, each pinned):
//   - Percent changes refuse a zero / negative base (the artifact's chg() divided by a negative
//     2023 NOI at 3540 E 5th and printed a meaningless percent).
//   - The relative lease schedules (Y1, LY1, ...) anchor on the rent start PARSED from the lease
//     term ("rent starts 2026-09-01", "base rent from 2023-08-01"); the artifact hard-coded them.
//   - The management-fee cap is read from the lease (mgmt_fee_cap), not hard-coded per property.
//   - The per-SF benchmark median is the true median (calc lib), not the upper-middle element.
//
// Pure TypeScript: no React, no fetch.
import {
  ANNUAL_PARTIAL_PERIOD,
  OPEX_CATEGORIES,
  PF_ENTITY_IDS,
  PF_MONTHLY_ENTITY_IDS,
  REVENUE_CATEGORIES,
  type OpexCategory,
  type PfDataset,
  type PfDriver,
  type PfEntityId,
  type PfHistoryYtd,
  type PfInsight,
  type PfLease,
  type PfRentStepEvent,
  type RevenueCategory,
} from '@contracts/property-financials';
import { notMeaningful, periodLabel, type MetricResult } from '@analytics/property-financials/periods';
import {
  cagr,
  fvcSepichMappingFlag,
  median,
  pctChange,
  perSf,
  ratio,
  recoveryPool,
  recoveryRatio,
  trailingAverage,
  type FvcMappingFlag,
} from '@analytics/property-financials/metrics';
import { fmtResult, pct, pctLevel, usd } from '@analytics/property-financials/format';
import { liveSfUsable, occupancyBasis, type OccupancyBasis, type PfLiveSfBlock } from '@analytics/property-financials/live-sf';
import { computeLevers, describeLeverRate, LEVERS } from '@analytics/property-financials/levers';
import type { ScheduleStep } from '@/charts/kit/geometry';
import { countWord, fmtMonth, insightsForEntity, leaseForEntity, monthRangeLabel, OPEX_SHORT_LABEL } from './model';

const RE_TAX: OpexCategory = 'Real estate & property tax';
const money = (v: number) => usd(v, 'f');
const res = (r: MetricResult) => fmtResult(r, (v) => pct(v));

// -------------------------------------------------------------------------------------------------
// Config
// -------------------------------------------------------------------------------------------------

/** The artifact's default selection: the second PM asset. */
export const DEFAULT_EXPLORER_ENTITY: PfEntityId = PF_MONTHLY_ENTITY_IDS[1];

export interface ExplorerRules {
  readonly minMonthsForYear: number;
  readonly rentStepMinDollars: number;
  readonly rentStepTableLimit: number;
  readonly why: { readonly effectMinDollars: number; readonly effectLimit: number; readonly driverLimit: number; readonly driverFloorDollars: number };
  readonly trajectoryMinYears: number;
  readonly benchmark: { readonly minPeers: number; readonly rentBelowMedian: number; readonly opexAboveMedian: number };
  readonly vacancyBelowOccupancy: number;
  readonly vacancyQuoteSf: number;
  readonly margin: { readonly minYears: number; readonly gapPoints: number };
  readonly costsOutrunningRent: { readonly minDelta: number; readonly pointsAboveRent: number; readonly limit: number };
  readonly recovery: { readonly minPool: number; readonly lowRatio: number; readonly stepPoints: number };
  readonly driverInsights: number;
  readonly winterMonths: readonly number[];
}

/** Every explorer threshold, in one place (the reference artifact hard-coded each in its closure). */
export const EXPLORER_RULES: ExplorerRules = {
  /** A monthly calendar year shows only with at least this many months of data. */
  minMonthsForYear: 4,
  /** Rent-step markers and the rent-change table: |monthly step| at least this many dollars. */
  rentStepMinDollars: 1000,
  /** Rent-change table: most recent N steps. */
  rentStepTableLimit: 8,
  why: {
    /** Effect-on-NOI bars: |effect| at least this many dollars ... */
    effectMinDollars: 500,
    /** ... and at most this many lines. */
    effectLimit: 10,
    /** Ranked account movements shown. */
    driverLimit: 12,
    /** Text of the empty state (the dataset's drv[] lists only accounts moving more than this). */
    driverFloorDollars: 1500,
  },
  /** Rent trajectory as a compound rate needs at least this many full years. */
  trajectoryMinYears: 3,
  benchmark: {
    minPeers: 3,
    /** Flag rent per SF below this multiple of the portfolio median. */
    rentBelowMedian: 0.9,
    /** Flag opex per SF above this multiple of the portfolio median. */
    opexAboveMedian: 1.15,
  },
  /** Vacancy insight when rent-roll occupancy is below this. */
  vacancyBelowOccupancy: 0.95,
  /** Vacancy value is quoted per this many SF leased. */
  vacancyQuoteSf: 1000,
  margin: {
    minYears: 3,
    /** Quote the dollar gap when the latest margin trails the best by more than this. */
    gapPoints: 0.05,
  },
  costsOutrunningRent: {
    /** Category increase above this many dollars ... */
    minDelta: 3000,
    /** ... growing more than this many points faster than base rent. */
    pointsAboveRent: 0.05,
    limit: 3,
  },
  recovery: {
    /** Recovery insight only when the recoverable pool exceeds this. */
    minPool: 30_000,
    /** Below this the insight quotes the value of ten points. */
    lowRatio: 0.6,
    /** "Each ten points recovered" */
    stepPoints: 0.1,
  },
  /** Driver insights: the top N opex increases. */
  driverInsights: 2,
  /** Month numbers treated as winter (snow) for the grounds hint. */
  winterMonths: [12, 1, 2, 3],
};

/** First step per opex category for the "Costs outrunning rent" insight (presentation copy). */
export const EXPLORER_CATEGORY_ACTION: Readonly<Record<OpexCategory, string>> = {
  'Real estate & property tax': 'confirm assessment and installment timing, and file an appeal where assessed value exceeds income value',
  Insurance: 'market the program at renewal and compare a blanket policy',
  'Management fees': 'confirm the fee base and rate in the management agreement',
  Utilities: 'audit meter reads and rate notices, check for leaks, and confirm tenant submetering and billing',
  'Grounds / snow / lot': 'bid the contract and set snow pricing per event or seasonal cap',
  'Repairs & maintenance': 'request invoice detail, consolidate vendors and bid recurring work',
  'Turnover / make-ready': 'tie spend to specific lease events and cap make-ready per move-out',
  'Professional / admin': 'review legal, accounting and bank charges line by line',
};

// -------------------------------------------------------------------------------------------------
// Period groups
// -------------------------------------------------------------------------------------------------

export type PeriodRow = PfHistoryYtd;

export interface PeriodGroup {
  /** '2024', or 'S25' / 'S26' for the Jan-Sep pair. */
  readonly key: string;
  readonly label: string;
  readonly row: PeriodRow;
  /** 'year' = calendar year (or annual statement); 'ytd' = the Jan-Sep pair. */
  readonly family: 'year' | 'ytd';
  readonly year: number;
  readonly partial: boolean;
  /** The prior comparable COMPLETE period (same family, previous year), or null. */
  readonly prev: PeriodGroup | null;
  /** Change of `pick` vs the prior comparable period; n/m with a reason for partial / no prior / ≤0 base. */
  readonly change: (pick: (r: PeriodRow) => number) => MetricResult;
}

interface MutableGroup {
  key: string;
  label: string;
  row: PeriodRow;
  family: 'year' | 'ytd';
  year: number;
  partial: boolean;
  prev: PeriodGroup | null;
  change: (pick: (r: PeriodRow) => number) => MetricResult;
}

/** The dataset's current calendar year (as_of year) and the Jan-Sep window. */
function calendar(d: PfDataset) {
  const year = Number(d.meta.as_of.slice(0, 4));
  const ytdMonths = d.meta.periods.YTD26.months;
  const [first, last] = [ytdMonths[0] ?? '', ytdMonths[ytdMonths.length - 1] ?? ''];
  const span = `${fmtMonth(first).split(' ')[0]}-${fmtMonth(last).split(' ')[0]}`;
  return {
    year,
    ytdLength: ytdMonths.length,
    /** 'Jan-Sep 26' */
    shortYtd: (y: number) => `${span} ${String(y).slice(2)}`,
    /** 'Jan-Sep 2026' */
    longYtd: (y: number) => `${span} ${y}`,
    longCurrent: monthRangeLabel(ytdMonths),
    longPrior: monthRangeLabel(d.meta.periods.YTD25.months),
  };
}

/** '2026 to 6/12' from the contract's annual partial period id. */
function annualPartialLabel(year: string): string {
  const m = /(\d{4})-(\d{2})-(\d{2})$/.exec(ANNUAL_PARTIAL_PERIOD);
  return m && m[1] === year ? `${year} to ${Number(m[2])}/${Number(m[3])}` : `${year} (partial)`;
}

/**
 * The explorer's comparison periods (artifact groups()): monthly entities show each calendar year
 * with at least minMonthsForYear months (partial years labelled with their month count) except the
 * current year, then the Jan-Sep pair when both sides are complete, else the current year as a
 * partial; annual entities show every statement year. Each COMPLETE group's prior is the previous
 * year of the same family when that one is complete too; a partial group never has a prior.
 */
export function periodGroups(d: PfDataset, id: PfEntityId, rules: ExplorerRules = EXPLORER_RULES): PeriodGroup[] {
  const h = d.history[id];
  const cal = calendar(d);
  const g: MutableGroup[] = [];
  const push = (key: string, label: string, row: PeriodRow, family: 'year' | 'ytd', year: number, partial: boolean) =>
    g.push({ key, label, row, family, year, partial, prev: null, change: () => notMeaningful('no prior comparable period') });
  for (const y of Object.keys(h.yr).sort()) {
    const row = h.yr[y]!;
    if (h.monthly) {
      if (row.n < rules.minMonthsForYear || Number(y) === cal.year) continue;
      push(y, row.n === 12 ? y : `${y} (${row.n} mo)`, row, 'year', Number(y), row.n < 12);
    } else {
      push(y, row.partial ? annualPartialLabel(y) : y, row, 'year', Number(y), row.partial);
    }
  }
  const cur = h.yr[String(cal.year)];
  if (h.monthly && cur) {
    const a = h.ytd[String(cal.year - 1)];
    const b = h.ytd[String(cal.year)];
    if (a && b && a.n === cal.ytdLength && b.n === cal.ytdLength) {
      push(`S${String(cal.year - 1).slice(2)}`, cal.shortYtd(cal.year - 1), a, 'ytd', cal.year - 1, false);
      push(`S${String(cal.year).slice(2)}`, cal.shortYtd(cal.year), b, 'ytd', cal.year, false);
    } else {
      push(`S${String(cal.year).slice(2)}`, `${cal.year} (${cur.n} mo)`, cur, 'year', cal.year, true);
    }
  }
  g.forEach((x, i) => {
    if (x.partial) {
      const months = x.family === 'year' && !h.monthly ? 'a partial-year statement' : `${x.row.n} of 12 months`;
      x.change = () => notMeaningful(`partial period (${months}): never compared year over year`);
      return;
    }
    for (let j = i - 1; j >= 0; j--) {
      const q = g[j]!;
      if (q.family === x.family && !q.partial && q.year === x.year - 1) {
        x.prev = q;
        break;
      }
    }
    const prev = x.prev;
    x.change = prev ? (pick) => pctChange(pick(prev.row), pick(x.row)) : () => notMeaningful('no prior comparable full period');
  });
  return g;
}

const fullYears = (gs: readonly PeriodGroup[]) => gs.filter((x) => x.family === 'year' && !x.partial);

/** Opex excluding real estate tax (cash-timing lumps). */
export const opexExTax = (r: PeriodRow): number => r.opex - (r.cats[RE_TAX] ?? 0);

// -------------------------------------------------------------------------------------------------
// Cards
// -------------------------------------------------------------------------------------------------

/** Card name: the label without a DESCRIPTIVE trailing parenthetical ('(EGFLLC)' stays). */
export function cardName(label: string): string {
  return label.replace(/\s*\(([^)]*\s[^)]*)\)\s*$/, '').trim();
}

export interface PropertyCard {
  readonly id: PfEntityId;
  readonly name: string;
  readonly sf: number | null;
  /** Latest full-year NOI (or the latest period when no full year exists). */
  readonly noi: number | null;
  readonly periodLabel: string;
  readonly partial: boolean;
  readonly change: MetricResult;
  /** Full-year NOI series for the sparkline (empty when fewer than two). */
  readonly spark: readonly number[];
}

function sfOf(d: PfDataset, id: PfEntityId): number | null {
  return d.sf[id].sf ?? null;
}

export function propertyCards(d: PfDataset): PropertyCard[] {
  return PF_ENTITY_IDS.map((id) => {
    const gs = periodGroups(d, id);
    const fy = fullYears(gs);
    const last = fy[fy.length - 1] ?? gs[gs.length - 1] ?? null;
    const spark = fy.map((x) => x.row.noi);
    return {
      id,
      name: cardName(d.properties[id].label),
      sf: sfOf(d, id),
      noi: last ? last.row.noi : null,
      periodLabel: last ? last.label : '',
      partial: last ? last.partial : true,
      change: last ? last.change((r) => r.noi) : notMeaningful('no periods'),
      spark: spark.length >= 2 ? spark : [],
    };
  });
}

// -------------------------------------------------------------------------------------------------
// KPIs, lede
// -------------------------------------------------------------------------------------------------

export interface ExplorerKpi {
  readonly id: 'baseRent' | 'opex' | 'noi' | 'margin' | 'noiPerSf' | 'occupancy' | 'noiYtd';
  readonly label: string;
  readonly value: string;
  readonly change?: MetricResult;
  /** Lower is better (costs). */
  readonly invert?: boolean;
  /** 'vs 2024' after the change chip. */
  readonly versus?: string;
  readonly note?: string;
}

const signed = (r: MetricResult) => fmtResult(r, (v) => pct(v));
const perSfText = (r: MetricResult) => fmtResult(r, (v) => `$${v.toFixed(2)}`);

function explorerLede(label: string, last: PeriodGroup | null): string {
  if (!last) return `${label}: short history; see the figures below as indicators only.`;
  const noi = usd(last.row.noi);
  const prev = last.prev;
  if (!prev) return `${label}: NOI was ${noi} in ${last.label}.`;
  const c = last.change((r) => r.noi);
  const tail = ` (revenue ${signed(last.change((r) => r.rev))}, operating expense ${signed(last.change((r) => r.opex))}).`;
  if (c.value === null) return `${label}: NOI was ${noi} in ${last.label}, against ${usd(prev.row.noi)} in ${prev.label}${tail}`;
  return `${label}: NOI ${last.row.noi >= prev.row.noi ? 'rose' : 'fell'} ${pctLevel(Math.abs(c.value), 1)} to ${noi} in ${last.label}${tail}`;
}

/** The entity's occupancy on one basis (leased / leasable SF), with any disagreeing figure named. */
function occupancyOf(d: PfDataset, id: PfEntityId, liveSf: PfLiveSfBlock | null): OccupancyBasis | null {
  return occupancyBasis(d.sf[id], liveSfUsable(liveSf) ? (liveSf.entries[id] ?? null) : null);
}

function explorerKpis(d: PfDataset, id: PfEntityId, gs: readonly PeriodGroup[], last: PeriodGroup | null, liveSf: PfLiveSfBlock | null): ExplorerKpi[] {
  if (!last) return [];
  const sf = sfOf(d, id);
  const prev = last.prev;
  const versus = prev ? `vs ${prev.label}` : undefined;
  const r = last.row;
  const out: ExplorerKpi[] = [
    { id: 'baseRent', label: `Base rent, ${last.label}`, value: usd(r.br), ...(prev ? { change: last.change((x) => x.br), versus } : {}) },
    { id: 'opex', label: `Operating expense, ${last.label}`, value: usd(r.opex), invert: true, ...(prev ? { change: last.change((x) => x.opex), versus } : {}) },
    { id: 'noi', label: `NOI, ${last.label}`, value: usd(r.noi), ...(prev ? { change: last.change((x) => x.noi), versus } : {}) },
    {
      id: 'margin',
      // Named with its period: the Scorecard's margin column is TTM, this tile the latest full year.
      label: `NOI margin, FY${last.key}`,
      value: fmtResult(ratio(r.noi, r.rev), (v) => pctLevel(v)),
      note: `Opex ratio, FY${last.key} ${fmtResult(ratio(r.opex, r.rev), (v) => pctLevel(v))}`,
    },
  ];
  if (sf !== null) {
    out.push({
      id: 'noiPerSf',
      label: `NOI per SF, ${last.label}`,
      value: perSfText(perSf(r.noi, sf)),
      note: `Rent ${perSfText(perSf(r.br, sf))} · Opex ${perSfText(perSf(r.opex, sf))} per SF`,
    });
    const s = d.sf[id];
    const ob = occupancyOf(d, id, liveSf);
    if (ob) {
      out.push({
        id: 'occupancy',
        label: 'Occupancy (rent roll)',
        value: pctLevel(ob.occ, 1),
        note:
          `${ob.leased.toLocaleString('en-US')} of ${ob.leasable.toLocaleString('en-US')} SF leased${s.tenants !== undefined ? ` · ${s.tenants} tenant${s.tenants === 1 ? '' : 's'}` : ''}` +
          (ob.conflict ? ` · ${ob.conflict.source} says ${pctLevel(ob.conflict.otherOcc, 1)}: sources disagree` : ''),
      });
    }
  }
  const s26 = gs.find((x) => x.family === 'ytd' && x.prev);
  if (s26 && s26.prev) {
    out.push({ id: 'noiYtd', label: `NOI, ${s26.label}`, value: usd(s26.row.noi), change: s26.change((x) => x.noi), versus: `vs ${s26.prev.label}` });
  }
  return out;
}

// -------------------------------------------------------------------------------------------------
// YoY table + category detail
// -------------------------------------------------------------------------------------------------

export interface TableColumn {
  readonly key: string;
  readonly label: string;
  readonly partial: boolean;
  readonly family: 'year' | 'ytd';
}

export interface ValueCell {
  readonly value: number;
  /** Change vs the prior comparable period; n/m when partial / no prior / ≤0 base. */
  readonly change: MetricResult;
}

export interface ValueRow {
  readonly label: string;
  readonly invert: boolean;
  readonly cells: readonly ValueCell[];
}

export interface PerSfRow {
  readonly label: string;
  readonly cells: ReadonlyArray<{ readonly value: MetricResult; readonly note: string | null }>;
}

export interface YoyTable {
  readonly columns: readonly TableColumn[];
  readonly rows: readonly ValueRow[];
  /** Empty when the entity has no SF on file. */
  readonly perSf: readonly PerSfRow[];
  readonly sfNote: string | null;
}

const columnsOf = (gs: readonly PeriodGroup[]): TableColumn[] => gs.map((x) => ({ key: x.key, label: x.label, partial: x.partial, family: x.family }));

function valueRow(gs: readonly PeriodGroup[], label: string, pick: (r: PeriodRow) => number, invert: boolean): ValueRow {
  return { label, invert, cells: gs.map((x) => ({ value: pick(x.row), change: x.change(pick) })) };
}

function sfSourceNote(d: PfDataset, id: PfEntityId, sf: number): string {
  const src = d.sf[id].source ?? '';
  const file = src.split(':')[0]?.trim();
  const asOf = /as of (\d{4}-\d{2}-\d{2})/.exec(src)?.[1];
  const cite = [file, asOf].filter(Boolean).join(', ');
  const ytdWord = countWord(d.meta.periods.YTD26.months.length);
  return `Per-SF figures divide each period by current total building SF (${sf.toLocaleString('en-US')} SF${cite ? `, ${cite}` : ''}). ${calendar(d).shortYtd(0).split(' ')[0]} periods are ${ytdWord} months, not annualized.`;
}

function yoyTable(d: PfDataset, id: PfEntityId, gs: readonly PeriodGroup[]): YoyTable {
  const sf = sfOf(d, id);
  const rows = [
    valueRow(gs, 'Base rent', (r) => r.br, false),
    valueRow(gs, 'Revenue', (r) => r.rev, false),
    valueRow(gs, 'Operating expense', (r) => r.opex, true),
    valueRow(gs, 'Opex excl. RE tax', opexExTax, true),
    valueRow(gs, 'NOI', (r) => r.noi, false),
  ];
  const ytdNote = `${d.meta.periods.YTD26.months.length} mo`;
  const perSfRows: PerSfRow[] =
    sf === null
      ? []
      : (
          [
            ['Base rent per SF', (r: PeriodRow) => r.br],
            ['Operating expense per SF', (r: PeriodRow) => r.opex],
            ['NOI per SF', (r: PeriodRow) => r.noi],
          ] as const
        ).map(([label, pick]) => ({
          label,
          cells: gs.map((x) => ({ value: perSf(pick(x.row), sf), note: x.family === 'ytd' ? ytdNote : x.partial ? 'partial' : null })),
        }));
  return { columns: columnsOf(gs), rows, perSf: perSfRows, sfNote: sf === null ? null : sfSourceNote(d, id, sf) };
}

export interface CategoryRow {
  readonly label: string;
  readonly invert: boolean;
  readonly cells: ReadonlyArray<{ readonly value: number; readonly change: MetricResult | null }>;
}

export interface CategoryTable {
  readonly columns: readonly TableColumn[];
  readonly revenue: readonly CategoryRow[];
  readonly opex: readonly CategoryRow[];
  readonly totals: readonly CategoryRow[];
}

function categoryRow(gs: readonly PeriodGroup[], label: string, pick: (r: PeriodRow) => number, invert: boolean): CategoryRow {
  // The artifact prints a change only where a prior comparable period exists AND its base is positive.
  return {
    label,
    invert,
    cells: gs.map((x) => {
      const c = x.change(pick);
      return { value: pick(x.row), change: x.prev && c.value !== null ? c : null };
    }),
  };
}

function categoryTable(gs: readonly PeriodGroup[]): CategoryTable {
  const any = (pick: (r: PeriodRow) => number) => gs.some((x) => Math.abs(pick(x.row)) > 0);
  const rc = (c: RevenueCategory) => (r: PeriodRow) => r.rc[c] ?? 0;
  const oc = (c: OpexCategory) => (r: PeriodRow) => r.cats[c] ?? 0;
  return {
    columns: columnsOf(gs),
    revenue: REVENUE_CATEGORIES.filter((c) => any(rc(c))).map((c) => categoryRow(gs, c, rc(c), false)),
    opex: OPEX_CATEGORIES.filter((c) => any(oc(c))).map((c) => categoryRow(gs, c, oc(c), true)),
    totals: [categoryRow(gs, 'Total operating expense', (r) => r.opex, true), categoryRow(gs, 'NOI (normalized)', (r) => r.noi, false)],
  };
}

// -------------------------------------------------------------------------------------------------
// Chart data: grouped revenue / opex / NOI bars and the opex stack (tooltips built here, not in components)
// -------------------------------------------------------------------------------------------------

export interface ChartSeries {
  readonly id: string;
  readonly label: string;
  /** Fixed palette slot 1-8 (--pf-c1..8): revenue 1, opex 2, NOI 3; opex categories 1-8 in order. */
  readonly slot: number;
}

export interface BarsData {
  readonly columns: readonly TableColumn[];
  readonly series: readonly ChartSeries[];
  /** [column][series] */
  readonly values: ReadonlyArray<readonly number[]>;
  /** [column][series] tooltip lines, title first. */
  readonly tips: ReadonlyArray<ReadonlyArray<readonly string[]>>;
  /** Stacked charts only: the SIGNED per-column total and its net-credit part (drawn bars floor at zero). */
  readonly stack?: StackTotalsData;
}

export interface StackTotalsData {
  /** Signed total per column (= the period's operating expense, credits included). */
  readonly totals: readonly number[];
  /** Sum of the net-credit (negative) categories per column; 0 when none. */
  readonly credits: readonly number[];
  /** 'Total $64.9K (incl. -$6.6K credit)': accessible / compact text. */
  readonly text: readonly string[];
  /** '$REDACTED-AMT (incl. -$REDACTED-AMT credit)': the data-table Total cell. */
  readonly tableText: readonly string[];
  /** 'incl. -$6.6K credit' under the chart's total label, or null when the column has no credit. */
  readonly creditNote: ReadonlyArray<string | null>;
}

/** $64.9K at or above $1,000, else whole dollars ($230). */
const compactUsd = (v: number): string => (Math.abs(v) >= 1000 ? usd(v, 'k') : usd(v));

/** Signed stack totals: the label never drops a net-credit category (the drawn stack does, by necessity). */
export function stackTotalsData(values: ReadonlyArray<readonly number[]>): StackTotalsData {
  const fin = (v: number) => (Number.isFinite(v) ? v : 0);
  const totals = values.map((g) => g.reduce((a, v) => a + fin(v), 0));
  const credits = values.map((g) => g.reduce((a, v) => a + Math.min(0, fin(v)), 0));
  const creditNote = credits.map((c) => (c < 0 ? `incl. ${compactUsd(c)} credit` : null));
  return {
    totals,
    credits,
    creditNote,
    text: totals.map((t, i) => `Total ${compactUsd(t)}${creditNote[i] ? ` (${creditNote[i]})` : ''}`),
    tableText: totals.map((t, i) => `${usd(t, 'f')}${credits[i]! < 0 ? ` (incl. ${usd(credits[i]!, 'f')} credit)` : ''}`),
  };
}

/** Revenue, operating expense and NOI by period (artifact barChart 'group'). */
export function periodBars(gs: readonly PeriodGroup[]): BarsData {
  const defs = [
    { id: 'rev', label: 'Revenue', slot: 1, pick: (r: PeriodRow) => r.rev },
    { id: 'opex', label: 'Operating expense', slot: 2, pick: (r: PeriodRow) => r.opex },
    { id: 'noi', label: 'NOI', slot: 3, pick: (r: PeriodRow) => r.noi },
  ];
  return {
    columns: columnsOf(gs),
    series: defs.map(({ id, label, slot }) => ({ id, label, slot })),
    values: gs.map((x) => defs.map((s) => s.pick(x.row))),
    tips: gs.map((x) =>
      defs.map((s) => {
        const v = s.pick(x.row);
        const lines = [`${x.label} · ${s.label}`, usd(v, 'f')];
        const c = x.change(s.pick);
        if (x.prev && c.value !== null) lines.push(`${pct(c.value)} vs ${x.prev.label} (${usd(v - s.pick(x.prev.row), 'f')})`);
        if (x.partial) lines.push('Partial period: not comparable');
        return lines;
      }),
    ),
  };
}

/** Operating expense by category per period, fixed category order and slots (artifact barChart 'stack'). */
export function opexStack(gs: readonly PeriodGroup[]): BarsData {
  const values = gs.map((x) => OPEX_CATEGORIES.map((c) => x.row.cats[c] ?? 0));
  return {
    columns: columnsOf(gs),
    series: OPEX_CATEGORIES.map((c, i) => ({ id: c, label: OPEX_SHORT_LABEL[c], slot: i + 1 })),
    values,
    stack: stackTotalsData(values),
    tips: gs.map((x) => {
      // Signed throughout, like categoryRow: a category can net to a credit (a refund or reversal
      // larger than the period's charges), and clamping it to $0 printed a fake -100% change.
      // A positive category's share is taken against the DRAWN stack (gross charges, credits not
      // drawn), so the tooltip and the bar proportions agree; the credit is named when present.
      const gross = OPEX_CATEGORIES.reduce((a, c) => a + Math.max(0, x.row.cats[c] ?? 0), 0);
      const credit = OPEX_CATEGORIES.reduce((a, c) => a + Math.min(0, x.row.cats[c] ?? 0), 0);
      return OPEX_CATEGORIES.map((c) => {
        const pick = (r: PeriodRow) => r.cats[c] ?? 0;
        const v = pick(x.row);
        const lines = [`${x.label} · ${OPEX_SHORT_LABEL[c]}`, v < 0 ? `${usd(v, 'f')} (net credit)` : usd(v, 'f')];
        const ch = x.change(pick);
        if (x.prev && ch.value !== null) lines.push(`${pct(ch.value)} vs ${x.prev.label} (${usd(v - pick(x.prev.row), 'f')})`);
        if (x.partial) lines.push('Partial period: not comparable');
        if (v < 0) lines.push('Share of operating expense: n/m (net credit)');
        else {
          const share = ratio(v, gross, 'no operating expense');
          if (share.value !== null)
            lines.push(credit < 0 ? `${pctLevel(share.value)} of gross charges, before the ${usd(credit, 'f')} credit` : `${pctLevel(share.value)} of operating expense`);
        }
        return lines;
      });
    }),
  };
}

// -------------------------------------------------------------------------------------------------
// What changed and why
// -------------------------------------------------------------------------------------------------

export interface EffectLine {
  readonly name: string;
  readonly prior: number;
  readonly current: number;
  /** Effect on NOI: revenue up / cost down = positive. */
  readonly impact: number;
  readonly helps: boolean;
  /** Bar length as a share (0-1) of the largest |effect| in the comparison. */
  readonly width: number;
  /** Tooltip lines, title first. */
  readonly tip: readonly string[];
}

export interface DriverLine {
  readonly account: string;
  readonly category: string;
  readonly kind: 'revenue' | 'expense';
  readonly prior: number;
  readonly current: number;
  readonly delta: number;
  readonly change: MetricResult;
  readonly helps: boolean;
  readonly natureLabel: string;
  readonly natureTag: string;
  readonly text: string;
}

export interface WhyPair {
  /** drv key: '2025' or 'YTD26'. */
  readonly key: string;
  readonly label: string;
  readonly priorLabel: string;
  readonly currentLabel: string;
  readonly effects: readonly EffectLine[];
  readonly drivers: readonly DriverLine[];
}

export interface WhyView {
  readonly pairs: readonly WhyPair[];
  readonly emptyDriversNote: string;
}

const NATURE_LABEL: Readonly<Record<PfDriver['nat'], string>> = { recurring: 'Recurring', lumpy: 'Lumpy', mixed: 'Mixed', annual: 'Annual' };

/** The artifact's natText: what the timing of an account's postings suggests, plus a category hint. */
export function natureText(dr: PfDriver, rules: ExplorerRules = EXPLORER_RULES): string {
  const rev = dr.lt === 'rev';
  if (dr.nat === 'annual') return 'Annual totals only: monthly detail is needed to separate run-rate from one-time items.';
  if (dr.nm === 0) {
    return rev
      ? 'Income on this line stopped in the period; confirm it was a one-time item and not a billing gap.'
      : 'No charge in the period; confirm it was a one-time item and not a missed bill.';
  }
  const m = dr.top ? fmtMonth(dr.top) : '';
  const t =
    dr.nat === 'recurring'
      ? `Billed in ${dr.nm} months of the period, so this reads as a run-rate change${rev ? ' in income' : '; budget it and negotiate it'}.`
      : dr.nat === 'lumpy'
        ? `Concentrated: ${Math.round(dr.conc * 100)}% sits in ${m} (${dr.nm} active month${dr.nm === 1 ? '' : 's'}), so it reads as a one-time or timing item; confirm whether it repeats.`
        : `Spread unevenly over ${dr.nm} months with a peak in ${m}; partly run-rate, partly lumpy.`;
  let hint = '';
  if (!rev && dr.d > 0) {
    if (dr.c === RE_TAX) hint = ' Tax is paid in installments, so cash timing may explain part of this [INFERRED]; compare full years and check the assessment notice.';
    else if (dr.c === 'Utilities') hint = ' Pull rate notices and meter reads; confirm submetering and tenant billing.';
    else if (dr.c === 'Insurance') hint = ' Compare against renewal terms; get competing quotes.';
    else if (dr.c === 'Repairs & maintenance') hint = ' Request invoice-level detail and bid recurring work.';
    else if (dr.c === 'Professional / admin') hint = ' Review the engagement and scope.';
  }
  if (!rev && dr.c === 'Grounds / snow / lot' && dr.top && rules.winterMonths.includes(Number(dr.top.slice(5)))) {
    hint = ' Peak falls in a winter month, consistent with snow events [INFERRED].';
  }
  return t + hint;
}

function driverLine(dr: PfDriver, rules: ExplorerRules): DriverLine {
  const rev = dr.lt === 'rev';
  return {
    account: dr.a,
    category: dr.c,
    kind: rev ? 'revenue' : 'expense',
    prior: dr.p,
    current: dr.n,
    delta: dr.d,
    change: pctChange(dr.p, dr.n),
    helps: rev ? dr.d > 0 : dr.d < 0,
    natureLabel: NATURE_LABEL[dr.nat],
    natureTag: dr.nat === 'annual' ? 'annual statements only' : '[INFERRED] from monthly timing',
    text: natureText(dr, rules),
  };
}

interface ComparisonPair {
  readonly a: PeriodRow;
  readonly b: PeriodRow;
  readonly la: string;
  readonly lb: string;
}

/**
 * The two COMPLETE periods behind a drv key ('YTD26' = the Jan-Sep pair, '2025' = 2025 vs 2024), or
 * null when either side is missing or partial — the same guard periodGroups applies (rule 1: a partial
 * period is never compared year over year). Monthly entities need every month of the window on both
 * sides; annual statements need both years non-partial. The dataset may still carry drv[] for a
 * partial pair (Livingston's 3-month Jan-Sep 2025); the view refuses it rather than show 3 vs 9 months.
 */
function comparisonPair(d: PfDataset, id: PfEntityId, key: string): ComparisonPair | null {
  const h = d.history[id];
  const cal = calendar(d);
  if (key === 'YTD26') {
    const a = h.ytd[String(cal.year - 1)];
    const b = h.ytd[String(cal.year)];
    if (!a || !b || a.n !== cal.ytdLength || b.n !== cal.ytdLength) return null;
    return { a, b, la: cal.longPrior, lb: cal.longCurrent };
  }
  const a = h.yr[String(Number(key) - 1)];
  const b = h.yr[key];
  if (!a || !b) return null;
  if (h.monthly ? a.n !== 12 || b.n !== 12 : a.partial || b.partial) return null;
  return { a, b, la: String(Number(key) - 1), lb: key };
}

export function whyView(d: PfDataset, id: PfEntityId, rules: ExplorerRules = EXPLORER_RULES): WhyView {
  const h = d.history[id];
  const keys = Object.keys(h.drv);
  const ordered = [...(keys.includes('YTD26') ? ['YTD26'] : []), ...keys.filter((k) => k !== 'YTD26').sort().reverse()];
  const pairs: WhyPair[] = [];
  for (const k of ordered) {
    const pair = comparisonPair(d, id, k);
    if (!pair) continue;
    const { a, b } = pair;
    const ranked = [
      ...REVENUE_CATEGORIES.map((c) => ({ name: c as string, prior: a.rc[c] ?? 0, current: b.rc[c] ?? 0, sign: 1 })),
      ...OPEX_CATEGORIES.map((c) => ({ name: c as string, prior: a.cats[c] ?? 0, current: b.cats[c] ?? 0, sign: -1 })),
    ]
      .map((x) => {
        const impact = x.sign * (x.current - x.prior);
        return { name: x.name, prior: x.prior, current: x.current, impact, helps: impact >= 0 };
      })
      .filter((x) => Math.abs(x.impact) >= rules.why.effectMinDollars)
      .sort((p, q) => Math.abs(q.impact) - Math.abs(p.impact))
      .slice(0, rules.why.effectLimit);
    const maxAbs = Math.max(1, ...ranked.map((x) => Math.abs(x.impact)));
    const effects: EffectLine[] = ranked.map((x) => ({
      ...x,
      width: Math.abs(x.impact) / maxAbs,
      tip: [x.name, `${usd(x.prior, 'f')} → ${usd(x.current, 'f')}`, `Effect on NOI ${x.impact >= 0 ? '+' : '-'}${usd(Math.abs(x.impact), 'f')}`],
    }));
    pairs.push({
      key: k,
      label: `${pair.lb} vs ${pair.la}`,
      priorLabel: pair.la,
      currentLabel: pair.lb,
      effects,
      drivers: (h.drv[k] ?? []).slice(0, rules.why.driverLimit).map((x) => driverLine(x, rules)),
    });
  }
  return { pairs, emptyDriversNote: `No account moved by more than ${usd(rules.why.driverFloorDollars)}.` };
}

// -------------------------------------------------------------------------------------------------
// Rent-step events + timeline
// -------------------------------------------------------------------------------------------------

export interface RentEventRow {
  /** Tooltip lines (title first). */
  readonly tip: readonly string[];
  readonly month: string;
  readonly label: string;
  readonly before: number;
  readonly after: number;
  readonly change: MetricResult;
  readonly annualized: number;
  readonly dir: 'up' | 'down';
}

const visibleSteps = (ev: readonly PfRentStepEvent[], rules: ExplorerRules) => ev.filter((v) => Math.abs(v.b - v.a) >= rules.rentStepMinDollars);

function eventRow(v: PfRentStepEvent): RentEventRow {
  const up = v.b > v.a;
  const tip = [
    `${fmtMonth(v.m)} · net base rent change`,
    `${usd(v.a, 'f')} → ${usd(v.b, 'f')} per month`,
    `${res(pctChange(v.a, v.b))} (${up ? '+' : '-'}${usd(Math.abs(v.b - v.a) * 12, 'f')} annualized)`,
  ];
  return { tip, month: v.m, label: fmtMonth(v.m), before: v.a, after: v.b, change: pctChange(v.a, v.b), annualized: (v.b - v.a) * 12, dir: v.b > v.a ? 'up' : 'down' };
}

export interface TimelineMarker {
  /** Index into the windowed months. */
  readonly index: number;
  readonly event: PfRentStepEvent;
  readonly row: RentEventRow;
}

export interface TimelineSeries {
  readonly months: readonly string[];
  /** 3-month trailing average (computed over the full history, then windowed). */
  readonly baseRent: ReadonlyArray<number | null>;
  readonly opexExTax: ReadonlyArray<number | null>;
  readonly markers: readonly TimelineMarker[];
}

export type TimelineRange = 'all' | 'since';

/** Monthly base rent vs opex excl. RE tax, 3-month trailing; null for annual-only entities. */
export function timelineSeries(d: PfDataset, id: PfEntityId, range: TimelineRange, rules: ExplorerRules = EXPLORER_RULES): TimelineSeries | null {
  const mm = d.history[id].months;
  if (!mm) return null;
  const since = d.meta.periods.FY2024.months[0];
  const i0 = range === 'since' && since ? Math.max(0, mm.g.indexOf(since)) : 0;
  const br = trailingAverage(mm.br);
  const ox = trailingAverage(mm.ox.map((v, i) => (v === null ? null : v - (mm.tx[i] ?? 0))));
  const markers: TimelineMarker[] = [];
  for (const ev of visibleSteps(d.history[id].ev, rules)) {
    const gi = mm.g.indexOf(ev.m);
    if (gi < i0 || gi < 0 || br[gi] === null || br[gi] === undefined) continue;
    markers.push({ index: gi - i0, event: ev, row: eventRow(ev) });
  }
  return { months: mm.g.slice(i0), baseRent: br.slice(i0), opexExTax: ox.slice(i0), markers };
}

// -------------------------------------------------------------------------------------------------
// Lease panel
// -------------------------------------------------------------------------------------------------

/** One day before ISO date `iso` + `years` (the end of a lease year). */
function lastDayOfLeaseYear(year: number, monthDay: string): string {
  const [m, dd] = monthDay.split('-').map(Number) as [number, number];
  const t = new Date(Date.UTC(year + 1, m - 1, dd));
  t.setUTCDate(t.getUTCDate() - 1);
  return t.toISOString().slice(0, 10);
}

/** The lease's rent start: a date inside the term's parenthetical ("rent starts …"), else the term start. */
export function leaseRentStart(term: string): string | null {
  return /\([^)]*?(\d{4}-\d{2}-\d{2})[^)]*\)/.exec(term)?.[1] ?? /^(\d{4}-\d{2}-\d{2})/.exec(term)?.[1] ?? null;
}

/**
 * The lease's rent schedule as dated steps (artifact normSched): ISO rows pass through, calendar-year
 * rows ("2024") become Jan 1-Dec 31, relative rows (Y1, LY1, ...) are consecutive lease years from
 * the rent start parsed from the term. Rows that cannot be dated are dropped, never guessed.
 */
export function normalizeRentSchedule(lease: PfLease): ScheduleStep[] {
  const sc = lease.rent_schedule_monthly ?? [];
  const start = leaseRentStart(lease.term);
  const out: ScheduleStep[] = [];
  sc.forEach(([from, to, value], i) => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(from) && to && /^\d{4}-\d{2}-\d{2}$/.test(to)) out.push({ from, to, value });
    else if (/^\d{4}$/.test(from)) out.push({ from: `${from}-01-01`, to: `${from}-12-31`, value });
    else if (start) {
      const y = Number(start.slice(0, 4)) + i;
      const md = start.slice(5);
      out.push({ from: `${y}-${md}`, to: lastDayOfLeaseYear(y, md), value });
    }
  });
  return out;
}

export interface LeaseStepRow extends ScheduleStep {
  readonly tip: readonly string[];
  readonly change: MetricResult | null;
  readonly annual: number;
  readonly current: boolean;
}

export interface LeasePanel {
  readonly lease: PfLease;
  readonly subtitle: string;
  readonly steps: readonly ScheduleStep[];
  readonly rows: readonly LeaseStepRow[];
  readonly today: string;
  readonly current: ScheduleStep | null;
  readonly currentAnnual: number | null;
  readonly currentPerSf: MetricResult;
  readonly next: (ScheduleStep & { readonly annualDelta: number; readonly change: MetricResult }) | null;
  readonly nnnNote: string | null;
  readonly sourceNote: string;
}

function leasePanel(d: PfDataset, id: PfEntityId): LeasePanel | null {
  const lease = leaseForEntity(d.leases, id);
  if (!lease || !lease.rent_schedule_monthly) return null;
  const steps = normalizeRentSchedule(lease);
  if (steps.length === 0) return null;
  const today = d.meta.generated;
  const current = steps.find((s) => s.from <= today && s.to >= today) ?? null;
  const nx = steps.find((s) => s.from > today) ?? null;
  const subtitle = [lease.tenant, lease.sf !== null ? `${lease.sf.toLocaleString('en-US')} SF` : null, lease.term, lease.escalator ? `escalator ${lease.escalator}` : null]
    .filter(Boolean)
    .join(' · ');
  return {
    lease,
    subtitle,
    steps,
    rows: steps.map((s, i) => {
      const prior = i ? steps[i - 1]!.value : null;
      const change = prior === null ? null : pctChange(prior, s.value);
      const tip = [`${s.from} to ${s.to}`, `${usd(s.value, 'f')} per month`];
      if (prior !== null && change) tip.push(`${res(change)} vs prior step (${usd((s.value - prior) * 12, 'f')} per year)`);
      return { ...s, tip, change, annual: s.value * 12, current: s === current };
    }),
    today,
    current,
    currentAnnual: current ? current.value * 12 : null,
    currentPerSf: current ? perSf(current.value * 12, lease.sf) : notMeaningful('no current rent step'),
    next: nx ? { ...nx, annualDelta: (nx.value - (current?.value ?? 0)) * 12, change: current ? pctChange(current.value, nx.value) : notMeaningful('no current rent step') } : null,
    nnnNote: lease.nnn_estimate_monthly !== undefined ? `NNN estimate in lease: ${usd(lease.nnn_estimate_monthly, 'f')} per month. Reconcile actual billings against it each quarter.` : null,
    sourceNote: `Source: ${lease.source} (${lease.confidence}).`,
  };
}

// -------------------------------------------------------------------------------------------------
// Insights
// -------------------------------------------------------------------------------------------------

export interface ExplorerInsight {
  readonly heading: string;
  readonly text: string;
}

/**
 * The "+N points of recovery" sensitivity, ONE number per entity: where Rent & NOI levers has a
 * recovery lever for the entity, its value, rate and period are quoted (read from the lever config,
 * never recomputed on another period); otherwise the Explorer's own figure on `label`'s pool, period named.
 */
function recoverySensitivity(d: PfDataset, id: PfEntityId, pool: number, label: string, rules: ExplorerRules): string {
  const def = LEVERS.find((l) => l.base.kind === 'recoveryPool' && l.base.entity === id);
  if (def && def.base.kind === 'recoveryPool') {
    const lv = computeLevers(d, [def])[0]!;
    if (lv.value.value !== null && lv.base !== null) {
      return `Each ${describeLeverRate(def)} recovered is worth ${money(lv.value.value)} a year on the ${periodLabel(def.base.period)} pool (${money(lv.base)}), the Rent & NOI levers figure.`;
    }
  }
  return `Each ${Math.round(rules.recovery.stepPoints * 100)} points recovered is worth ${money(pool * rules.recovery.stepPoints)} a year on the ${label} pool.`;
}

/** The artifact's insightsFor(): computed from the data, each rule's threshold in EXPLORER_RULES. */
export function explorerInsights(d: PfDataset, id: PfEntityId, rules: ExplorerRules = EXPLORER_RULES, liveSf: PfLiveSfBlock | null = null): ExplorerInsight[] {
  const h = d.history[id];
  const gs = periodGroups(d, id, rules);
  const fy = fullYears(gs);
  const last = fy[fy.length - 1] ?? null;
  const prev = last?.prev ?? null;
  const cal = calendar(d);
  const L: ExplorerInsight[] = [];
  const missing = d.properties[id].kind === 'monthly' ? (d.properties[id] as { missing_months_since_2024: string[] }).missing_months_since_2024 : [];
  const gap = missing.length
    ? [{ heading: 'Data gap', text: `Missing monthly exports: ${missing.map(fmtMonth).join(', ')}. Any period containing them is excluded from comparisons.` }]
    : [];
  if (!last) {
    return [
      {
        heading: 'Short history',
        text: 'This asset has fewer than twelve months of continuous data, so year-over-year comparison is not yet valid. Treat the figures as run-rate indicators only.',
      },
      ...gap,
    ];
  }
  const lr = last.row;

  // Rent trajectory
  const f0 = fy.find((x) => x.row.br > 0);
  const growth = f0 && fy.length >= rules.trajectoryMinYears && f0 !== last ? cagr(f0.row.br, lr.br, last.year - f0.year) : null;
  if (f0 && growth && growth.value !== null) {
    L.push({
      heading: 'Rent trajectory',
      text: `Base rent compounded at ${pct(growth.value)} a year from ${usd(f0.row.br)} (${f0.label}) to ${usd(lr.br)} (${last.label})${
        prev ? `; the latest year moved ${res(last.change((r) => r.br))}.` : '.'
      } Compare that pace with the escalators in each lease: any year below the contract steps points to vacancy, concessions or a stale rent roll.`,
    });
  } else if (prev && last.change((r) => r.br).value !== null) {
    L.push({ heading: 'Rent trajectory', text: `Base rent moved ${res(last.change((r) => r.br))} from ${usd(prev.row.br)} to ${usd(lr.br)} (${prev.label} to ${last.label}).` });
  }

  // This year so far
  const s26 = gs.find((x) => x.family === 'ytd' && x.prev);
  if (s26 && s26.prev) {
    const a = s26.prev.row;
    const b = s26.row;
    L.push({
      heading: 'This year so far',
      text: `${cal.longCurrent} against ${cal.longPrior}: base rent ${res(pctChange(a.br, b.br))}, revenue ${res(pctChange(a.rev, b.rev))}, operating expense ${res(pctChange(a.opex, b.opex))} (${res(
        pctChange(opexExTax(a), opexExTax(b)),
      )} excluding real estate tax), NOI ${res(pctChange(a.noi, b.noi))} (${money(b.noi - a.noi)}).`,
    });
  }

  // Per-SF benchmark + vacancy. Every per-SF figure goes through the calc lib's perSf(): a zero / missing
  // SF is n/m, so a peer without usable SF is left out and a subject without it gets no per-SF line.
  const sf0 = sfOf(d, id);
  const subj = { br: perSf(lr.br, sf0).value, ox: perSf(lr.opex, sf0).value, no: perSf(lr.noi, sf0).value };
  if (sf0 !== null && subj.br !== null && subj.ox !== null && subj.no !== null) {
    const peers = PF_ENTITY_IDS.filter((q) => q !== id).flatMap((q) => {
      const qg = fullYears(periodGroups(d, q, rules)).find((x) => x.key === last.key);
      if (!qg) return [];
      const qsf = sfOf(d, q);
      const br = perSf(qg.row.br, qsf).value;
      const ox = perSf(qg.row.opex, qsf).value;
      const no = perSf(qg.row.noi, qsf).value;
      return br !== null && ox !== null && no !== null ? [{ br, ox, no }] : [];
    });
    const brSf = subj.br;
    if (peers.length >= rules.benchmark.minPeers) {
      const mb = median(peers.map((q) => q.br));
      const mo = median(peers.map((q) => q.ox));
      const mn = median(peers.map((q) => q.no));
      const oxSf = subj.ox;
      L.push({
        heading: `Per-SF benchmark (${last.label})`,
        text:
          `Base rent $${brSf.toFixed(2)}/SF against a portfolio median of $${mb.toFixed(2)}; operating expense $${oxSf.toFixed(2)}/SF against $${mo.toFixed(2)}; NOI $${subj.no.toFixed(2)}/SF against $${mn.toFixed(2)}. ` +
          (brSf < mb * rules.benchmark.rentBelowMedian
            ? `Rent per SF is more than ${pctLevel(1 - rules.benchmark.rentBelowMedian)} below the median: test the rent roll for below-market leases at renewal. `
            : '') +
          (oxSf > mo * rules.benchmark.opexAboveMedian
            ? `Operating expense per SF is more than ${pctLevel(rules.benchmark.opexAboveMedian - 1)} above the median: prioritize the cost drivers below. `
            : '') +
          'Mix differs (flex, retail, NNN versus gross), so use this to choose where to look, not as a verdict.',
      });
    }
    const ob = occupancyOf(d, id, liveSf);
    if (ob?.conflict) {
      L.push({
        heading: 'Vacancy',
        text: `Occupancy sources disagree: leased SF is ${ob.leased.toLocaleString('en-US')} of ${ob.leasable.toLocaleString('en-US')} leasable SF (${pctLevel(ob.occ, 1)}), but ${ob.conflict.source} is ${pctLevel(ob.conflict.otherOcc, 1)}. Reconcile the rent roll with the Property NOI tab before quoting vacancy.`,
      });
    } else if (ob && ob.occ < rules.vacancyBelowOccupancy) {
      L.push({
        heading: 'Vacancy',
        text: `${ob.unleased.toLocaleString('en-US')} SF is unleased (${pctLevel(1 - ob.occ, 1)}). At the current base rent of $${brSf.toFixed(2)}/SF on total SF, each ${rules.vacancyQuoteSf.toLocaleString('en-US')} SF leased adds about $${Math.round(
          brSf * rules.vacancyQuoteSf,
        ).toLocaleString('en-US')} a year before recoveries.`,
      });
    }
  }

  // Margin
  const ms = fy.flatMap((x) => {
    const m = ratio(x.row.noi, x.row.rev);
    return m.value === null ? [] : [{ label: x.label, v: m.value }];
  });
  if (ms.length >= rules.margin.minYears) {
    const best = [...ms].sort((a, c) => c.v - a.v)[0]!;
    const worst = [...ms].sort((a, c) => a.v - c.v)[0]!;
    const lm = ms[ms.length - 1]!;
    L.push({
      heading: 'Margin',
      text: `NOI margin ran from ${pctLevel(worst.v)} (${worst.label}) to ${pctLevel(best.v)} (${best.label}); the latest full year is ${pctLevel(lm.v)}. ${
        lm.v < best.v - rules.margin.gapPoints
          ? `The gap to the best year is worth ${money((best.v - lm.v) * lr.rev)} of NOI at current revenue.`
          : 'The latest year is at or near the best margin on record.'
      }`,
    });
  }

  // Costs outrunning rent
  if (prev) {
    const rentChange = last.change((r) => r.br);
    // The artifact treats an unmeasurable rent change as 0 for the filter; the text says so.
    const rg = rentChange.value ?? 0;
    const cr = rules.costsOutrunningRent;
    const rows = OPEX_CATEGORIES.map((c) => {
      const a = prev.row.cats[c] ?? 0;
      const b = lr.cats[c] ?? 0;
      return { c, d: b - a, g: pctChange(a, b).value };
    })
      .filter((r) => r.d > cr.minDelta && (r.g === null || r.g > rg + cr.pointsAboveRent))
      .sort((a, b) => b.d - a.d)
      .slice(0, cr.limit);
    if (rows.length) {
      L.push({
        heading: 'Costs outrunning rent',
        text: `${rows.map((r) => `${OPEX_SHORT_LABEL[r.c]} ${r.g === null ? 'new' : pct(r.g)} (${money(r.d)})`).join('; ')} between ${prev.label} and ${last.label}, against ${rentChange.value === null ? 'no measurable base-rent change' : `base rent ${pct(rg)}`}. First step for each: ${rows
          .map((r) => `${OPEX_SHORT_LABEL[r.c]} - ${EXPLORER_CATEGORY_ACTION[r.c]}`)
          .join('; ')}.`,
      });
    } else {
      L.push({
        heading: 'Cost discipline',
        text: `No expense category grew more than ${Math.round(cr.pointsAboveRent * 100)} points faster than rent between ${prev.label} and ${last.label} on amounts above ${usd(cr.minDelta)}.`,
      });
    }
  }

  // Recovery
  const pool = recoveryPool(lr.cats);
  if (h.monthly && pool > rules.recovery.minPool) {
    const rec = (lr.rc['Recoveries (CAM/tax/ins)'] ?? 0) + (lr.rc['Utility reimbursements'] ?? 0);
    const rr = recoveryRatio({ recoveries: lr.rc['Recoveries (CAM/tax/ins)'] ?? 0, utility_reimb: lr.rc['Utility reimbursements'] ?? 0, opex_by: lr.cats });
    if (rr.value !== null) {
      L.push({
        heading: 'Recovery',
        text: `Tenants reimbursed ${pctLevel(rr.value)} of the recoverable cost pool (${money(rec)} of ${money(pool)}) in ${last.label}. ${
          rr.value < rules.recovery.lowRatio
            ? `${recoverySensitivity(d, id, pool, last.label, rules)} Check lease structure first: single-tenant NNN assets pay these costs directly and will read low by design.`
            : 'This is in a healthy range for a multi-tenant structure; confirm annual reconciliations were billed.'
        }`,
      });
    }
  }

  // Management fee
  const mf = lr.cats['Management fees'] ?? 0;
  const feePct = ratio(mf, lr.rev);
  if (mf > 0 && feePct.value !== null) {
    const cap = leaseForEntity(d.leases, id)?.mgmt_fee_cap;
    L.push({
      heading: 'Management fee',
      text: `Fees were ${money(mf)}, ${pctLevel(feePct.value, 1)} of revenue in ${last.label}. Confirm the percentage and the base (collected revenue versus billed) against the management agreement${
        cap ? `; the lease caps the fee at ${cap}.` : '.'
      }`,
    });
  }

  // Drivers: the latest drv key whose two periods are both complete (partial pairs are never quoted).
  const dk = [...(h.drv.YTD26 ? ['YTD26'] : []), ...Object.keys(h.drv).filter((k) => k !== 'YTD26').sort().reverse()].find((k) => comparisonPair(d, id, k) !== null);
  if (dk) {
    const when = comparisonPair(d, id, dk)!.lb;
    for (const dr of (h.drv[dk] ?? []).filter((x) => x.lt === 'opex' && x.d > 0).slice(0, rules.driverInsights)) {
      L.push({
        heading: `Driver: ${dr.a}`,
        text: `${dr.c} rose ${money(dr.d)} (${dr.pct === null ? 'new' : res(pctChange(dr.p, dr.n))}, ${money(dr.p)} to ${money(dr.n)}) in ${when}. ${natureText(dr, rules)}`,
      });
    }
  }
  return [...L, ...gap];
}

// -------------------------------------------------------------------------------------------------
// The whole explorer
// -------------------------------------------------------------------------------------------------

export interface ExplorerModel {
  readonly id: PfEntityId;
  readonly label: string;
  readonly monthly: boolean;
  readonly sf: number | null;
  readonly groups: readonly PeriodGroup[];
  readonly lede: string;
  readonly kpis: readonly ExplorerKpi[];
  readonly yoy: YoyTable;
  readonly categories: CategoryTable;
  readonly why: WhyView;
  /** Rent-change table rows, newest first. */
  readonly events: readonly RentEventRow[];
  readonly eventsNote: string | null;
  readonly lease: LeasePanel | null;
  readonly insights: readonly ExplorerInsight[];
  readonly openItems: readonly PfInsight[];
  readonly annualOnlyNote: string | null;
  readonly missingMonthsNote: string | null;
  readonly fvcFlag: FvcMappingFlag | null;
}

/**
 * The whole explorer for one entity. `liveSf` is the raw live block (the dataset passed in already has
 * it applied); it is read only to name a Spine A occupancy that disagrees with leased SF.
 */
export function buildExplorer(d: PfDataset, id: PfEntityId, rules: ExplorerRules = EXPLORER_RULES, liveSf: PfLiveSfBlock | null = null): ExplorerModel {
  const p = d.properties[id];
  const h = d.history[id];
  const gs = periodGroups(d, id, rules);
  const fy = fullYears(gs);
  const last = fy[fy.length - 1] ?? null;
  const events = visibleSteps(h.ev, rules).slice(-rules.rentStepTableLimit).reverse().map(eventRow);
  const missing = p.kind === 'monthly' ? p.missing_months_since_2024 : [];
  const partialEnd = /thru_(\d{4}-\d{2}-\d{2})$/.exec(ANNUAL_PARTIAL_PERIOD)?.[1];
  const flag = id === 'FVC' ? fvcSepichMappingFlag(d.sf.FVC) : null;
  return {
    id,
    label: p.label,
    monthly: h.monthly,
    sf: sfOf(d, id),
    groups: gs,
    lede: explorerLede(p.label, last),
    kpis: explorerKpis(d, id, gs, last, liveSf),
    yoy: yoyTable(d, id, gs),
    categories: categoryTable(gs),
    why: whyView(d, id, rules),
    events,
    eventsNote:
      events.length > 0
        ? null
        : h.monthly
          ? `No persistent step of ${usd(rules.rentStepMinDollars)} a month or more was detected.`
          : 'Annual statements only: see the year-over-year table for the rent change.',
    lease: leasePanel(d, id),
    insights: explorerInsights(d, id, rules, liveSf),
    openItems: insightsForEntity(d.insights, id),
    annualOnlyNote: h.monthly
      ? null
      : `Entity-level annual statements only (no monthly detail), so there is no monthly series, rent-step detection or Jan-Sep comparison here${
          partialEnd ? `; the latest year runs to ${partialEnd} and is partial` : ''
        }.`,
    missingMonthsNote: missing.length
      ? `Missing monthly exports since 2024: ${missing.map(fmtMonth).join(', ')}. Periods containing them are marked partial and excluded from year-over-year comparisons.`
      : null,
    fvcFlag: flag && flag.active ? flag : null,
  };
}
