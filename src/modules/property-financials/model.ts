// src/modules/property-financials/model.ts
//
// The pure view-model of the Property Financials module (plan T5): everything the views render that
// is derived from the dataset, built ONLY from the calc library in src/analytics/property-financials
// (pctChange, recoveryRatio, runRateQ3Table, partialReason, the formatters). Components never do
// arithmetic on dataset figures themselves. No firm number is hardcoded here: the Overview lede, the
// member counts and the period labels are all read from the dataset.
//
// Pinned in tests/unit/property-financials-model.test.ts. Pure TypeScript: no React, no fetch.
import {
  OPEX_CATEGORIES,
  PF_ENTITY_IDS,
  PF_SEVERITIES,
  type OpexCategory,
  type PfDataset,
  type PfEntityId,
  type PfInsight,
  type PfLease,
  type PfPeriodFigures,
  type PfPortfolioView,
  type PfProperty,
} from '@contracts/property-financials';
import { notMeaningful, ok, partialReason, type MetricResult } from '@analytics/property-financials/periods';
import { pctChange, recoveryRatio, runRateQ3Table } from '@analytics/property-financials/metrics';
import { pctLevel } from '@analytics/property-financials/format';

const RE_TAX: OpexCategory = 'Real estate & property tax';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

// -------------------------------------------------------------------------------------------------
// Labels / dates
// -------------------------------------------------------------------------------------------------

/** `2026-09-30` → `30 Sep 2026`. Unparseable input is returned unchanged. */
export function fmtLongDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  const mon = m ? MONTHS[Number(m[2]) - 1] : undefined;
  return m && mon ? `${Number(m[3])} ${mon} ${m[1]}` : iso;
}

/** `2023-10` → `Oct 2023`. */
export function fmtMonth(ym: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  const mon = m ? MONTHS[Number(m[2]) - 1] : undefined;
  return m && mon ? `${mon} ${m[1]}` : ym;
}

/** First..last month of a window: `Jan-Sep 2026`, or `Oct 2025-Sep 2026` across years. */
export function monthRangeLabel(months: readonly string[]): string {
  const first = months[0];
  const last = months[months.length - 1];
  if (!first || !last) return '';
  const firstMon = fmtMonth(first).split(' ')[0];
  const lastMon = fmtMonth(last).split(' ')[0];
  const firstYear = first.slice(0, 4);
  const lastYear = last.slice(0, 4);
  return firstYear === lastYear ? `${firstMon}-${lastMon} ${lastYear}` : `${firstMon} ${firstYear}-${lastMon} ${lastYear}`;
}

/** Masthead exclusion notes from dataset meta.excluded: `X (pending)` → `X excluded (pending)`. */
export function excludedNotes(excluded: readonly string[]): string[] {
  return excluded.map((e) => {
    const m = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(e);
    return m ? `${m[1]} excluded (${m[2]})` : `${e} excluded`;
  });
}

/** Short opex category labels for chart rows (presentation only). */
export const OPEX_SHORT_LABEL: Readonly<Record<OpexCategory, string>> = {
  'Real estate & property tax': 'Real estate tax',
  Insurance: 'Insurance',
  'Management fees': 'Management fees',
  Utilities: 'Utilities',
  'Grounds / snow / lot': 'Grounds & snow',
  'Repairs & maintenance': 'Repairs & maint.',
  'Turnover / make-ready': 'Turnover / make-ready',
  'Professional / admin': 'Professional / admin',
};

// -------------------------------------------------------------------------------------------------
// Entity matching
// -------------------------------------------------------------------------------------------------

/** Entity / lease / insight property label without its trailing parenthetical. */
function baseName(s: string): string {
  return s.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

/**
 * The lease for an entity: same street words, and the entity's building number equals the lease's
 * number or one end of its range ("3883 Livingston" ↔ "3875-3883 Livingston"). Null when none.
 */
export function leaseForEntity(leases: readonly PfLease[], entity: string): PfLease | null {
  const [num, ...street] = baseName(entity).split(/\s+/);
  if (!num || street.length === 0) return null;
  for (const l of leases) {
    const [lnum, ...lstreet] = baseName(l.property).split(/\s+/);
    if (!lnum || lstreet.join(' ').toLowerCase() !== street.join(' ').toLowerCase()) continue;
    if (lnum === num || lnum.split('-').includes(num)) return l;
  }
  return null;
}

/** Review items for an entity: the insight's property starts with the entity's base name. */
export function insightsForEntity(insights: readonly PfInsight[], entity: string): PfInsight[] {
  const key = baseName(entity);
  return insights.filter((i) => i.property.startsWith(key));
}

/** The dataset entity an insight is about, or null (Portfolio, lease-only properties). */
export function entityForInsight(insight: PfInsight): PfEntityId | null {
  return PF_ENTITY_IDS.find((id) => insight.property.startsWith(baseName(id))) ?? null;
}

// -------------------------------------------------------------------------------------------------
// Insights
// -------------------------------------------------------------------------------------------------

const SEVERITY_RANK: Readonly<Record<PfInsight['severity'], number>> = Object.fromEntries(
  PF_SEVERITIES.map((s, i) => [s, i]),
) as Record<PfInsight['severity'], number>;

const absImpact = (i: PfInsight): number => (i.annual_impact_usd === null ? -1 : Math.abs(i.annual_impact_usd));

/** Severity (High → Low), then |annual impact| descending; an unknown impact sorts last in its band. */
export function sortInsights(insights: readonly PfInsight[]): PfInsight[] {
  return [...insights].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || absImpact(b) - absImpact(a));
}

/** "Where the money is": High-severity items ranked by |annual impact|. */
export function whereTheMoneyIs(insights: readonly PfInsight[]): PfInsight[] {
  return sortInsights(insights.filter((i) => i.severity === 'High'));
}

/** Sign tone class: positive good (or inverted for costs), negligible muted (the artifact's cls). */
export function toneClass(x: number | null, invert = false): string {
  if (x === null || Math.abs(x) < 0.0005) return 'pf-mut';
  return (invert ? x < 0 : x > 0) ? 'pf-pos' : 'pf-neg';
}

/** Display tone of an impact figure: an expense increase or a revenue loss reads negative. */
export function impactTone(i: PfInsight): 'pos' | 'neg' | 'mut' {
  const v = i.annual_impact_usd;
  if (v === null) return 'mut';
  if (i.type === 'Expense') return v > 0 ? 'neg' : 'pos';
  return v < 0 ? 'neg' : 'pos';
}

/** Plain-language noun for an insight's primary tag (presentation vocabulary, not data). */
const TAG_NOUN: Readonly<Record<string, string>> = {
  solar: 'solar income',
  rent: 'rent',
  lease: 'leasing',
  utilities: 'utilities',
  repairs: 'repairs',
  vacancy: 'vacancy and waivers',
  nnn: 'cost recovery',
  cam: 'CAM recovery',
  recoveries: 'recoveries',
  tax: 'real estate tax',
  insurance: 'insurance',
  'management-fee': 'management fees',
  'bid-out': 'service contracts',
};

function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

export interface InsightTheme {
  /** The primary tag the theme groups on. */
  readonly key: string;
  readonly phrase: string;
  /** Gross |annual impact| of the grouped items. */
  readonly total: number;
  readonly insightIds: readonly string[];
}

/**
 * The biggest-dollar themes among High-severity items: grouped by primary tag, ranked by gross
 * |annual impact|. Items without a dollar estimate carry no weight and are left out.
 */
export function insightThemes(insights: readonly PfInsight[], limit = 3): InsightTheme[] {
  const groups = new Map<string, PfInsight[]>();
  for (const i of whereTheMoneyIs(insights)) {
    if (i.annual_impact_usd === null) continue;
    const key = i.tags[0] ?? i.type.toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), i]);
  }
  return [...groups.entries()]
    .map(([key, items]) => {
      const places = [...new Set(items.map((i) => i.property))];
      const noun = TAG_NOUN[key] ?? key.replace(/-/g, ' ');
      const where = places.length === 1 && places[0] === 'Portfolio' ? 'across the portfolio' : `at ${joinList(places.map((p) => (p === 'Portfolio' ? 'portfolio level' : p)))}`;
      return { key, phrase: `${noun} ${where}`, total: items.reduce((a, i) => a + Math.abs(i.annual_impact_usd ?? 0), 0), insightIds: items.map((i) => i.id) };
    })
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);
}

// -------------------------------------------------------------------------------------------------
// Overview
// -------------------------------------------------------------------------------------------------

export interface KpiFigure {
  readonly current: number;
  readonly prior: number;
  readonly change: MetricResult;
}

export interface OverviewKpis {
  /** Label of the same-store year-to-date window, e.g. `Jan-Sep 2026`. */
  readonly periodLabel: string;
  readonly baseRent: KpiFigure & { readonly members: number };
  readonly opexExTax: KpiFigure;
  readonly noiFy: KpiFigure & { readonly members: number };
  readonly high: { readonly count: number; readonly grossSwing: number };
}

function kpi(prior: number, current: number): KpiFigure {
  return { prior, current, change: pctChange(prior, current) };
}

function opexExTax(view: PfPortfolioView['view']): KpiFigure {
  return kpi(view.opex.prior - view.opex_by[RE_TAX].prior, view.opex.current - view.opex_by[RE_TAX].current);
}

/** The four Overview KPI tiles. Percent changes come from pctChange, never the view's rounded pct. */
export function overviewKpis(d: PfDataset): OverviewKpis {
  const ytd = d.portfolio.same_store_YTD26_vs_YTD25;
  const fy = d.portfolio.pm_only_FY2025_vs_FY2024;
  const high = d.insights.filter((i) => i.severity === 'High');
  return {
    periodLabel: monthRangeLabel(d.meta.periods.YTD26.months),
    baseRent: { ...kpi(ytd.view.base_rent.prior, ytd.view.base_rent.current), members: ytd.members.length },
    opexExTax: opexExTax(ytd.view),
    noiFy: { ...kpi(fy.view.noi.prior, fy.view.noi.current), members: fy.members.length },
    high: { count: high.length, grossSwing: high.reduce((a, i) => a + Math.abs(i.annual_impact_usd ?? 0), 0) },
  };
}

const COUNT_WORD = ['no', 'one', 'two', 'three', 'four', 'five'] as const;

/**
 * The Overview lede, computed (the reference artifact hardcoded it): same-store rent growth,
 * opex-excl-tax growth, and the three biggest-dollar themes among High-severity items.
 */
export function overviewLede(d: PfDataset): string {
  const k = overviewKpis(d);
  const rent = k.baseRent.change;
  const cost = k.opexExTax.change;
  const abs = (v: number) => pctLevel(Math.abs(v), 1);
  const rentPart =
    rent.value === null
      ? `Same-store rent growth is not measurable (${rent.reason})`
      : rent.value >= 0
        ? `Rent is growing ${abs(rent.value)} on a same-store basis`
        : `Rent is falling ${abs(rent.value)} on a same-store basis`;
  const costPart =
    cost.value === null
      ? `the change in operating cost excluding real estate tax is not measurable (${cost.reason})`
      : `operating cost excluding real estate tax is ${cost.value >= 0 ? 'up' : 'down'} ${abs(cost.value)}`;
  let lede = `${rentPart}, while ${costPart}.`;
  const themes = insightThemes(d.insights, 3);
  if (themes.length > 0) {
    const n = COUNT_WORD[themes.length] ?? String(themes.length);
    const places = themes.length === 1 ? 'place' : 'places';
    const list = themes.length >= 3 ? `${themes.slice(0, -1).map((t) => t.phrase).join(', ')}, and ${themes[themes.length - 1]!.phrase}` : joinList(themes.map((t) => t.phrase));
    lede += ` The biggest dollars sit in ${n} ${places}: ${list}.`;
  }
  return lede;
}

export interface OpexDeltaItem {
  readonly category: OpexCategory;
  readonly label: string;
  readonly value: number;
  readonly prior: number;
  readonly current: number;
  readonly change: MetricResult;
}

/** Chart 2: dollar change by opex category (current - prior), largest increase first. */
export function opexDeltaItems(view: PfPortfolioView['view']): OpexDeltaItem[] {
  return OPEX_CATEGORIES.map((c) => {
    const o = view.opex_by[c];
    return { category: c, label: OPEX_SHORT_LABEL[c], value: o.current - o.prior, prior: o.prior, current: o.current, change: pctChange(o.prior, o.current) };
  }).sort((a, b) => b.value - a.value);
}

// -------------------------------------------------------------------------------------------------
// Scorecard
// -------------------------------------------------------------------------------------------------

export interface ScorecardRow {
  readonly id: PfEntityId;
  readonly label: string;
  readonly kind: PfProperty['kind'];
  readonly sourceNote: string;
  readonly noiFy24: MetricResult;
  readonly noiFy25: MetricResult;
  readonly noiTtm: MetricResult;
  readonly margin: MetricResult;
  readonly runRateYoy: MetricResult;
  readonly opexRatio: MetricResult;
  readonly mgmtFee: MetricResult;
  readonly recovery: MetricResult;
  readonly flags: number;
}

const ANNUAL_ONLY = 'annual statements only: no monthly detail';

/** A period figure, or n/m with the partial-period reason. */
function periodValue(periodId: string, f: PfPeriodFigures, pick: (f: PfPeriodFigures) => number | null, nullReason: string): MetricResult {
  const partial = partialReason(periodId, f.n_months);
  if (partial !== null) return notMeaningful(partial);
  const v = pick(f);
  return v === null ? notMeaningful(nullReason) : ok(v);
}

/** Scorecard table rows in dataset order (PM monthly entities, then annual entity statements). */
export function scorecardRows(d: PfDataset): ScorecardRow[] {
  return (Object.keys(d.properties) as PfEntityId[]).map((id) => {
    const p = d.properties[id];
    const flags = insightsForEntity(d.insights, id).length;
    const noi = (per: 'FY2024' | 'FY2025') => periodValue(per, p.periods[per], (f) => f.noi, 'no figure');
    if (p.kind === 'monthly') {
      const t = p.periods.TTM26;
      return {
        id,
        label: p.label,
        kind: p.kind,
        sourceNote: `PM monthly, ${fmtMonth(p.first_month)} to ${fmtMonth(p.last_month)}`,
        noiFy24: noi('FY2024'),
        noiFy25: noi('FY2025'),
        noiTtm: periodValue('TTM26', t, (f) => f.noi, 'no figure'),
        margin: periodValue('TTM26', t, (f) => f.noi_margin, 'no revenue in the period'),
        runRateYoy: runRateQ3Table(d.monthly[p.id]).yoy_2026,
        opexRatio: periodValue('TTM26', t, (f) => f.opex_ratio, 'no revenue in the period'),
        mgmtFee: periodValue('TTM26', t, (f) => f.mgmt_fee_pct, 'no revenue in the period'),
        recovery: partialReason('TTM26', t.n_months) ? notMeaningful(partialReason('TTM26', t.n_months)!) : recoveryRatio(t),
        flags,
      };
    }
    const fy = p.periods.FY2025;
    return {
      id,
      label: p.label,
      kind: p.kind,
      sourceNote: 'Entity annual P&L',
      noiFy24: noi('FY2024'),
      noiFy25: noi('FY2025'),
      noiTtm: notMeaningful(`${ANNUAL_ONLY}, so no trailing-twelve-month figure`),
      margin: periodValue('FY2025', fy, (f) => f.noi_margin, 'no revenue in the period'),
      runRateYoy: notMeaningful(`${ANNUAL_ONLY}, so no Q3 run-rate`),
      opexRatio: periodValue('FY2025', fy, (f) => f.opex_ratio, 'no revenue in the period'),
      mgmtFee: periodValue('FY2025', fy, (f) => f.mgmt_fee_pct, 'no revenue in the period'),
      recovery: notMeaningful(`${ANNUAL_ONLY}, so no recovery split`),
      flags,
    };
  });
}

/** Ordered month keys of the monthly cube across the given entities (missing months included as keys). */
export function cubeMonths(d: PfDataset, entities: readonly string[]): string[] {
  const set = new Set<string>();
  for (const id of entities) for (const m of Object.keys((d.monthly as Record<string, Record<string, unknown>>)[id] ?? {})) set.add(m);
  return [...set].sort();
}
