// src/analytics/property-financials/build-dataset.ts
//
// monthly-long.csv rows + versioned config -> the Property Financials dataset (plan T9a, step 4).
// Numeric blocks (meta.periods, portfolio views, properties[id].periods / yoy / base_rent_runrate_q3,
// monthly cube, account_movers, history) are DERIVED from the CSV with the T3 aggregation core
// (aggregate.ts) and the T2 rules (metrics.ts); curated blocks (insights, leases, data_quality, sf and
// the meta text) come from scripts/property-financials/config/curated/*.json; selection thresholds
// from config/derivation.v1.json; entity identity from config/entities.json. Adding an entity is data
// only: a registry row + CSV rows (+ an sf entry) and it flows through every block here.
//
// Every rounded figure uses Python's round() (pyfloat.ts) because the committed dataset was made in
// Python and tests/unit/property-financials-build-dataset.test.ts requires an exact regeneration.
// Period ids are derived from meta.as_of (FY{Y-2}, FY{Y-1}, YTD{yy-1}, YTD{yy}, TTM{yy-1}, TTM{yy});
// for as_of 2026-09-30 they equal the contract's STANDARD_PERIODS. The contract constants are the
// architect-owned gate: a new entity or a rolled year passes this builder on data alone and is then
// admitted (or refused) by src/contracts/property-financials.ts.
//
// Pure TypeScript: no fs — the CLI in scripts/property-financials/ supplies the parsed inputs.
import { aggregateRows, indexRows, type LineType, type MonthlyLongRow, type RebuiltPeriod, type RowIndex } from './aggregate';
import { driverNature, driverTiming, q3RunRate, rentStepEvents } from './metrics';
import { pyRound } from './pyfloat';

// -------------------------------------------------------------------------------------------------
// Inputs
// -------------------------------------------------------------------------------------------------

export type EntityKind = 'monthly' | 'annual';

export interface EntityRegistryEntry {
  readonly id: string;
  readonly label: string;
  readonly kind: EntityKind;
  readonly layout: string;
  readonly source: string;
  readonly sameStore: boolean;
  readonly sameStoreFy: boolean;
  readonly leaseUp: boolean;
  readonly canonicalId: string;
}

export interface EntityRegistry {
  readonly version: string;
  readonly entities: readonly EntityRegistryEntry[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function needString(o: Record<string, unknown>, k: string, where: string): string {
  const v = o[k];
  if (typeof v !== 'string' || v.length === 0) throw new Error(`${where}: ${k} must be a non-empty string`);
  return v;
}

function needBool(o: Record<string, unknown>, k: string, where: string): boolean {
  const v = o[k];
  if (typeof v !== 'boolean') throw new Error(`${where}: ${k} must be a boolean`);
  return v;
}

export function parseEntityRegistry(json: unknown): EntityRegistry {
  if (!isRecord(json) || !Array.isArray(json.entities)) throw new Error('entity registry: expected { version, entities[] }');
  const version = needString(json, 'version', 'entity registry');
  const seen = new Set<string>();
  const entities = json.entities.map((e, i) => {
    const where = `entity registry entities[${i}]`;
    if (!isRecord(e)) throw new Error(`${where}: must be an object`);
    const id = needString(e, 'id', where);
    if (seen.has(id)) throw new Error(`${where}: duplicate id ${id}`);
    seen.add(id);
    if (e.kind !== 'monthly' && e.kind !== 'annual') throw new Error(`${where}: kind must be monthly | annual`);
    const kind: EntityKind = e.kind;
    const entry: EntityRegistryEntry = {
      id,
      label: needString(e, 'label', where),
      kind,
      layout: needString(e, 'layout', where),
      source: needString(e, 'source', where),
      sameStore: needBool(e, 'sameStore', where),
      sameStoreFy: needBool(e, 'sameStoreFy', where),
      leaseUp: needBool(e, 'leaseUp', where),
      canonicalId: needString(e, 'canonicalId', where),
    };
    return entry;
  });
  return { version, entities };
}

export interface DerivationConfig {
  readonly version: string;
  readonly account_movers: { readonly minAbsDelta: { readonly FY: number; readonly YTD: number } };
  readonly drivers: { readonly minAbsDelta: number; readonly max: number };
}

function needPositive(v: unknown, where: string): number {
  if (typeof v !== 'number' || !(v > 0) || !Number.isFinite(v)) throw new Error(`${where} must be a positive number`);
  return v;
}

export function parseDerivationConfig(json: unknown): DerivationConfig {
  if (!isRecord(json)) throw new Error('derivation config: expected an object');
  const version = needString(json, 'version', 'derivation config');
  const movers = json.account_movers;
  const drivers = json.drivers;
  if (!isRecord(movers) || !isRecord(movers.minAbsDelta) || !isRecord(drivers)) throw new Error('derivation config: expected account_movers.minAbsDelta{FY,YTD} and drivers{minAbsDelta,max}');
  return {
    version,
    account_movers: {
      minAbsDelta: {
        FY: needPositive(movers.minAbsDelta.FY, 'derivation account_movers.minAbsDelta.FY'),
        YTD: needPositive(movers.minAbsDelta.YTD, 'derivation account_movers.minAbsDelta.YTD'),
      },
    },
    drivers: { minAbsDelta: needPositive(drivers.minAbsDelta, 'derivation drivers.minAbsDelta'), max: needPositive(drivers.max, 'derivation drivers.max') },
  };
}

export interface CuratedMeta {
  readonly title: string;
  readonly version: string;
  readonly generated: string;
  readonly as_of: string;
  readonly basis: string;
  readonly units: string;
  readonly source_folder: string;
  readonly excluded: readonly string[];
  readonly noi_definition: string;
  readonly history_note: string;
  readonly portfolio_note: string;
}

export interface CuratedSfEntry {
  readonly sf: number | null;
  readonly leased_sf?: number;
  readonly occ?: number;
  readonly tenants?: number;
  readonly source?: string;
  readonly common_area_sf?: number;
  readonly note: string;
}

export interface CuratedInputs {
  readonly meta: CuratedMeta;
  readonly insights: readonly unknown[];
  readonly leases: readonly unknown[];
  readonly data_quality: readonly string[];
  readonly sf: Readonly<Record<string, CuratedSfEntry>>;
}

const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

function stripNote(json: unknown, file: string, key: string): unknown {
  if (!isRecord(json) || !(key in json)) throw new Error(`curated ${file}: expected { "${key}": ... }`);
  return json[key];
}

/** Each curated file is `{ "$note": ..., "<key>": payload }`; `meta.json` carries its fields at top level. */
export function parseCuratedInputs(files: { meta: unknown; insights: unknown; leases: unknown; data_quality: unknown; sf: unknown }): CuratedInputs {
  const m = files.meta;
  if (!isRecord(m)) throw new Error('curated meta.json: expected an object');
  const w = 'curated meta.json';
  const meta: CuratedMeta = {
    title: needString(m, 'title', w),
    version: needString(m, 'version', w),
    generated: needString(m, 'generated', w),
    as_of: needString(m, 'as_of', w),
    basis: needString(m, 'basis', w),
    units: needString(m, 'units', w),
    source_folder: needString(m, 'source_folder', w),
    excluded: Array.isArray(m.excluded) ? m.excluded.map((x) => String(x)) : [],
    noi_definition: needString(m, 'noi_definition', w),
    history_note: needString(m, 'history_note', w),
    portfolio_note: needString(m, 'portfolio_note', w),
  };
  if (!ISO_DATE.test(meta.as_of)) throw new Error(`${w}: as_of must be YYYY-MM-DD`);
  if (!ISO_DATE.test(meta.generated)) throw new Error(`${w}: generated must be YYYY-MM-DD`);
  const insights = stripNote(files.insights, 'insights.json', 'insights');
  const leases = stripNote(files.leases, 'leases.json', 'leases');
  const dq = stripNote(files.data_quality, 'data_quality.json', 'data_quality');
  const sf = stripNote(files.sf, 'sf.json', 'sf');
  if (!Array.isArray(insights) || !Array.isArray(leases) || !Array.isArray(dq)) throw new Error('curated insights / leases / data_quality must be arrays');
  if (!isRecord(sf)) throw new Error('curated sf.json: `sf` must be an object keyed by entity id');
  for (const [id, entry] of Object.entries(sf)) {
    if (!isRecord(entry) || !('sf' in entry) || typeof entry.note !== 'string') throw new Error(`curated sf.json: ${id} needs sf (number|null) and note`);
  }
  return { meta, insights, leases, data_quality: dq.map((x) => String(x)), sf: sf as Record<string, CuratedSfEntry> };
}

export interface BuildInputs {
  readonly rows: readonly MonthlyLongRow[];
  readonly registry: EntityRegistry;
  readonly curated: CuratedInputs;
  readonly derivation: DerivationConfig;
  /** From account-mapping.vN.json: the category lists the CSV must use. */
  readonly categories: { readonly revenue: readonly string[]; readonly opex: readonly string[]; readonly below_line: Readonly<Record<string, string>> };
}

// -------------------------------------------------------------------------------------------------
// Period scaffolding (derived from as_of)
// -------------------------------------------------------------------------------------------------

interface Scaffold {
  readonly year: number;
  readonly month: number;
  readonly asOfMonth: string;
  /** Standard period id -> month keys, in dataset order. */
  readonly standard: ReadonlyArray<{ id: string; family: 'FY' | 'YTD' | 'TTM'; months: readonly string[] }>;
  readonly comparisons: ReadonlyArray<{ id: string; family: 'FY' | 'YTD' | 'TTM'; current: string; prior: string }>;
  readonly fyIds: { prior: string; current: string };
  readonly cubeStart: string;
  readonly ytdKey: string;
  readonly yy: string;
}

function monthKey(y: number, m: number): string {
  return `${y}-${String(m).padStart(2, '0')}`;
}

function monthsOfYear(y: number, upTo = 12): string[] {
  return Array.from({ length: upTo }, (_, i) => monthKey(y, i + 1));
}

/** The 12 months ending at (y, m) inclusive. */
function trailing12(y: number, m: number): string[] {
  const out: string[] = [];
  let yy = y;
  let mm = m;
  for (let i = 0; i < 12; i++) {
    out.unshift(monthKey(yy, mm));
    mm--;
    if (mm === 0) {
      mm = 12;
      yy--;
    }
  }
  return out;
}

function scaffold(asOf: string): Scaffold {
  const year = Number(asOf.slice(0, 4));
  const month = Number(asOf.slice(5, 7));
  const yy = String(year).slice(2);
  const yyPrior = String(year - 1).slice(2);
  const standard = [
    { id: `FY${year - 2}`, family: 'FY' as const, months: monthsOfYear(year - 2) },
    { id: `FY${year - 1}`, family: 'FY' as const, months: monthsOfYear(year - 1) },
    { id: `YTD${yyPrior}`, family: 'YTD' as const, months: monthsOfYear(year - 1, month) },
    { id: `YTD${yy}`, family: 'YTD' as const, months: monthsOfYear(year, month) },
    { id: `TTM${yyPrior}`, family: 'TTM' as const, months: trailing12(year - 1, month) },
    { id: `TTM${yy}`, family: 'TTM' as const, months: trailing12(year, month) },
  ];
  return {
    year,
    month,
    asOfMonth: monthKey(year, month),
    standard,
    comparisons: [
      { id: `FY${year - 1}_vs_FY${year - 2}`, family: 'FY', current: `FY${year - 1}`, prior: `FY${year - 2}` },
      { id: `TTM${yy}_vs_TTM${yyPrior}`, family: 'TTM', current: `TTM${yy}`, prior: `TTM${yyPrior}` },
      { id: `YTD${yy}_vs_YTD${yyPrior}`, family: 'YTD', current: `YTD${yy}`, prior: `YTD${yyPrior}` },
    ],
    fyIds: { prior: `FY${year - 2}`, current: `FY${year - 1}` },
    cubeStart: monthKey(year - 2, 1),
    ytdKey: `YTD${yy}`,
    yy,
  };
}

// -------------------------------------------------------------------------------------------------
// Rounding helpers (Python round semantics)
// -------------------------------------------------------------------------------------------------

const r2 = (x: number): number => pyRound(x, 2);
const r0 = (x: number): number => pyRound(x, 0);
const r2n = (x: number | null): number | null => (x === null ? null : r2(x));
/** Whole dollars of the cent-rounded value: the reference rounded its 2-dp figures, so an exact x.495 reads as x.50 -> half-even. */
const r0c = (x: number): number => r0(r2(x));
/** current / prior - 1 at 2 dp; null when there is no prior base. */
const pct2 = (prior: number, current: number): number | null => (prior === 0 ? null : r2(current / prior - 1));
/** Driver change relative to the MAGNITUDE of the prior, 3 dp: (current - prior) / |prior| keeps the sign of the move when the prior is a contra (negative) balance. */
const pct3abs = (prior: number, current: number): number | null => (prior === 0 ? null : pyRound((current - prior) / Math.abs(prior), 3));

function mapValues<V, R>(o: Readonly<Record<string, V>>, f: (v: V, k: string) => R): Record<string, R> {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, f(v, k)]));
}

function roundPeriod(a: RebuiltPeriod, nMonths = a.n_months): Record<string, unknown> {
  return {
    base_rent: r2(a.base_rent),
    vacancy_waivers: r2(a.vacancy_waivers),
    reimbursements: r2(a.reimbursements),
    recoveries: r2(a.recoveries),
    utility_reimb: r2(a.utility_reimb),
    other_income: r2(a.other_income),
    energy_income: r2(a.energy_income),
    revenue: r2(a.revenue),
    opex: r2(a.opex),
    noi: r2(a.noi),
    noi_margin: r2n(a.noi_margin),
    opex_ratio: r2n(a.opex_ratio),
    mgmt_fee_pct: r2n(a.mgmt_fee_pct),
    recovery_ratio: r2n(a.recovery_ratio),
    pool: r2(a.pool),
    capex: r2(a.capex),
    dist: r2(a.dist),
    opex_by: mapValues(a.opex_by, r2),
    n_months: nMonths,
  };
}

// -------------------------------------------------------------------------------------------------
// Row access
// -------------------------------------------------------------------------------------------------

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function rowsIn(index: RowIndex, entity: string, periodKeys: readonly string[]): MonthlyLongRow[] {
  const byPeriod = index.get(entity);
  const out: MonthlyLongRow[] = [];
  for (const k of periodKeys) for (const r of byPeriod?.get(k) ?? []) out.push(r);
  return out;
}

function sumWhere(rows: readonly MonthlyLongRow[], pred: (r: MonthlyLongRow) => boolean): number {
  let s = 0;
  for (const r of rows) if (pred(r)) s += r.amount_usd;
  return s;
}

/** Sum by category in first-appearance order — history rows list only categories that have postings. */
function sumByCategory(rows: readonly MonthlyLongRow[], lineType: LineType): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) if (r.line_type === lineType) out[r.category] = (out[r.category] ?? 0) + r.amount_usd;
  return out;
}

interface AccountTotals {
  readonly key: string;
  readonly lt: LineType;
  readonly c: string;
  readonly a: string;
  readonly prior: number;
  readonly current: number;
}

/** Per (line_type, category, account) totals over two windows, in first-appearance order (current window first). */
function accountDeltas(index: RowIndex, entity: string, current: readonly string[], prior: readonly string[], lineTypes: readonly LineType[]): AccountTotals[] {
  const acc = new Map<string, { lt: LineType; c: string; a: string; prior: number; current: number }>();
  const add = (rows: readonly MonthlyLongRow[], side: 'prior' | 'current'): void => {
    for (const r of rows) {
      if (!lineTypes.includes(r.line_type)) continue;
      const key = `${r.line_type}\u0001${r.category}\u0001${r.source_account}`;
      const e = acc.get(key) ?? { lt: r.line_type, c: r.category, a: r.source_account, prior: 0, current: 0 };
      e[side] += r.amount_usd;
      acc.set(key, e);
    }
  };
  add(rowsIn(index, entity, current), 'current');
  add(rowsIn(index, entity, prior), 'prior');
  return [...acc.entries()].map(([key, e]) => ({ key, ...e }));
}

function byAbsDeltaDesc<T extends { delta: number }>(list: T[]): T[] {
  return list.map((x, i) => ({ x, i })).sort((p, q) => Math.abs(q.x.delta) - Math.abs(p.x.delta) || p.i - q.i).map((p) => p.x);
}

// -------------------------------------------------------------------------------------------------
// Build
// -------------------------------------------------------------------------------------------------

/**
 * Build the dataset object. Throws on: a CSV entity missing from the registry, a registry entity with
 * no rows, a revenue/opex category outside the declared lists, a below-line category that is not the
 * declared label, or an annual entity without exactly one partial-year statement for as_of's year.
 */
export function buildDataset(input: BuildInputs): Record<string, unknown> {
  const { rows, registry, curated, derivation, categories } = input;
  const S = scaffold(curated.meta.as_of);
  const byId = new Map(registry.entities.map((e) => [e.id, e]));

  // --- validation --------------------------------------------------------------------------------
  const revSet = new Set(categories.revenue);
  const opexSet = new Set(categories.opex);
  const rowEntities = new Set<string>();
  for (const r of rows) {
    rowEntities.add(r.entity);
    if (!byId.has(r.entity)) throw new Error(`CSV entity "${r.entity}" is not in the entity registry (config/entities.json)`);
    if (r.line_type === 'rev' && !revSet.has(r.category)) throw new Error(`${r.entity}/${r.period}: revenue category "${r.category}" is not declared in the mapping`);
    if (r.line_type === 'opex' && !opexSet.has(r.category)) throw new Error(`${r.entity}/${r.period}: opex category "${r.category}" is not declared in the mapping`);
    if (r.line_type !== 'rev' && r.line_type !== 'opex' && categories.below_line[r.line_type] !== r.category) {
      throw new Error(`${r.entity}/${r.period}: ${r.line_type} category "${r.category}" is not the declared label "${categories.below_line[r.line_type] ?? ''}"`);
    }
  }
  for (const e of registry.entities) if (!rowEntities.has(e.id)) throw new Error(`registry entity "${e.id}" has no rows in the CSV`);

  const index = indexRows(rows);
  const opexCats = categories.opex;

  const properties: Record<string, unknown> = {};
  const monthly: Record<string, unknown> = {};
  const accountMovers: Record<string, unknown> = {};
  const history: Record<string, unknown> = {};
  const sf: Record<string, unknown> = {};
  /** Exact (unrounded) period aggregates per entity, for the portfolio views. */
  const exact = new Map<string, Record<string, RebuiltPeriod>>();

  for (const e of registry.entities) {
    const sfEntry = curated.sf[e.id];
    if (!sfEntry) throw new Error(`curated sf.json has no entry for "${e.id}" (sf: null + note is the explicit "not applicable" form)`);
    sf[e.id] = sfEntry;
    const sfFields: Record<string, unknown> = {};
    if (sfEntry.sf !== null) {
      sfFields.sf = sfEntry.sf;
      sfFields.leased_sf = sfEntry.leased_sf;
      sfFields.occupancy = sfEntry.occ;
    }
    if (e.kind === 'monthly') {
      const built = buildMonthlyEntity(e, index, S, derivation, opexCats);
      properties[e.id] = { ...built.property, ...sfFields };
      monthly[e.id] = built.cube;
      accountMovers[e.id] = built.movers;
      history[e.id] = built.history;
      exact.set(e.id, built.exactPeriods);
    } else {
      const built = buildAnnualEntity(e, index, S, derivation);
      properties[e.id] = { ...built.property, ...sfFields };
      history[e.id] = built.history;
      exact.set(e.id, built.exactPeriods);
    }
  }

  // --- portfolio views ---------------------------------------------------------------------------
  const view = (members: readonly string[], currentId: string, priorId: string): Record<string, unknown> => {
    const cur = members.map((id) => exact.get(id)![currentId]!);
    const pri = members.map((id) => exact.get(id)![priorId]!);
    const sum = (list: readonly RebuiltPeriod[], f: (p: RebuiltPeriod) => number): number => list.reduce((a, p) => a + f(p), 0);
    const cmp = (f: (p: RebuiltPeriod) => number): Record<string, unknown> => {
      const p = sum(pri, f);
      const c = sum(cur, f);
      return { prior: r2(p), current: r2(c), pct: pct2(p, c) };
    };
    return {
      members,
      view: {
        base_rent: cmp((p) => p.base_rent),
        reimbursements: cmp((p) => p.reimbursements),
        revenue: cmp((p) => p.revenue),
        opex: cmp((p) => p.opex),
        noi: cmp((p) => p.noi),
        capex: cmp((p) => p.capex),
        opex_by: Object.fromEntries(opexCats.map((c) => [c, cmp((p) => p.opex_by[c as keyof typeof p.opex_by] ?? 0)])),
      },
    };
  };
  const sameStoreFy = registry.entities.filter((e) => e.sameStoreFy).map((e) => e.id);
  const pmOnly = registry.entities.filter((e) => e.sameStore && e.kind === 'monthly').map((e) => e.id);
  const fy = S.comparisons[0]!;
  const ttm = S.comparisons[1]!;
  const ytd = S.comparisons[2]!;
  const portfolio: Record<string, unknown> = {
    [`same_store_${fy.id}`]: view(sameStoreFy, fy.current, fy.prior),
    [`pm_only_${fy.id}`]: view(pmOnly, fy.current, fy.prior),
    [`same_store_${ttm.id}`]: view(pmOnly, ttm.current, ttm.prior),
    [`same_store_${ytd.id}`]: view(pmOnly, ytd.current, ytd.prior),
    note: curated.meta.portfolio_note,
  };

  const meta = {
    title: curated.meta.title,
    version: curated.meta.version,
    generated: curated.meta.generated,
    as_of: curated.meta.as_of,
    basis: curated.meta.basis,
    units: curated.meta.units,
    source_folder: curated.meta.source_folder,
    periods: Object.fromEntries(S.standard.map((p) => [p.id, { months: [...p.months] }])),
    categories: { revenue: [...categories.revenue], opex: [...categories.opex], below_line: Object.keys(categories.below_line) },
    excluded: [...curated.meta.excluded],
    noi_definition: curated.meta.noi_definition,
    history_note: curated.meta.history_note,
  };

  return {
    meta,
    portfolio,
    properties,
    monthly,
    account_movers: accountMovers,
    insights: curated.insights,
    leases: curated.leases,
    data_quality: curated.data_quality,
    history,
    sf,
  };
}

// -------------------------------------------------------------------------------------------------
// Monthly entity
// -------------------------------------------------------------------------------------------------

function monthRange(from: string, to: string): string[] {
  const out: string[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const endY = Number(to.slice(0, 4));
  const endM = Number(to.slice(5, 7));
  while (y < endY || (y === endY && m <= endM)) {
    out.push(monthKey(y, m));
    m++;
    if (m === 13) {
      m = 1;
      y++;
    }
  }
  return out;
}

function buildMonthlyEntity(
  e: EntityRegistryEntry,
  index: RowIndex,
  S: Scaffold,
  derivation: DerivationConfig,
  opexCats: readonly string[],
): { property: Record<string, unknown>; cube: Record<string, unknown>; movers: Record<string, unknown>; history: Record<string, unknown>; exactPeriods: Record<string, RebuiltPeriod> } {
  const periodKeys = [...(index.get(e.id)?.keys() ?? [])].filter((k) => MONTH_RE.test(k)).sort();
  if (periodKeys.length === 0) throw new Error(`${e.id}: monthly entity has no YYYY-MM rows`);
  const firstMonth = periodKeys[0]!;
  const lastMonth = periodKeys[periodKeys.length - 1]!;
  const present = new Set(periodKeys);

  // periods
  const exactPeriods: Record<string, RebuiltPeriod> = {};
  const periods: Record<string, unknown> = {};
  const partial = new Map<string, boolean>();
  for (const p of S.standard) {
    const a = aggregateRows(index, e.id, p.months);
    exactPeriods[p.id] = a;
    periods[p.id] = roundPeriod(a);
    partial.set(p.id, a.n_months < p.months.length);
  }

  // yoy
  const yoy: Record<string, unknown> = {};
  for (const c of S.comparisons) {
    if (partial.get(c.current) || partial.get(c.prior)) {
      yoy[c.id] = null;
      continue;
    }
    const cur = exactPeriods[c.current]!;
    const pri = exactPeriods[c.prior]!;
    yoy[c.id] = {
      base_rent: pct2(pri.base_rent, cur.base_rent),
      reimbursements: pct2(pri.reimbursements, cur.reimbursements),
      revenue: pct2(pri.revenue, cur.revenue),
      opex: pct2(pri.opex, cur.opex),
      noi: pct2(pri.noi, cur.noi),
      capex: pct2(pri.capex, cur.capex),
      opex_by: Object.fromEntries(opexCats.map((k) => [k, pct2(pri.opex_by[k as keyof typeof pri.opex_by] ?? 0, cur.opex_by[k as keyof typeof cur.opex_by] ?? 0)])),
      opex_by_delta: Object.fromEntries(opexCats.map((k) => [k, r2((cur.opex_by[k as keyof typeof cur.opex_by] ?? 0) - (pri.opex_by[k as keyof typeof pri.opex_by] ?? 0))])),
      delta: {
        base_rent: r2(cur.base_rent - pri.base_rent),
        reimbursements: r2(cur.reimbursements - pri.reimbursements),
        revenue: r2(cur.revenue - pri.revenue),
        opex: r2(cur.opex - pri.opex),
        noi: r2(cur.noi - pri.noi),
      },
    };
  }

  // monthly cube (from the first FY of the standard periods) + exact monthly series
  const cube: Record<string, unknown> = {};
  const exactMonths = new Map<string, RebuiltPeriod>();
  for (const m of periodKeys) {
    const a = aggregateRows(index, e.id, [m]);
    exactMonths.set(m, a);
    if (m < S.cubeStart) continue;
    cube[m] = {
      base_rent: r2(a.base_rent),
      reimbursements: r2(a.reimbursements),
      other_income: r2(a.other_income),
      vacancy_waivers: r2(a.vacancy_waivers),
      revenue: r2(a.revenue),
      opex: r2(a.opex),
      noi: r2(a.noi),
      capex: r2(a.capex),
      opex_by: mapValues(a.opex_by, r2),
    };
  }
  const missing = monthRange(firstMonth > S.cubeStart ? firstMonth : S.cubeStart, S.asOfMonth).filter((m) => !present.has(m));

  // run-rate
  const brByMonth: Record<string, { base_rent: number }> = Object.fromEntries([...exactMonths].map(([m, a]) => [m, { base_rent: a.base_rent }]));
  const q3 = (y: number): number | null => {
    const v = q3RunRate(brByMonth, y);
    return v === null ? null : r2(v);
  };
  const q3Prior2 = q3(S.year - 2);
  const q3Prior1 = q3(S.year - 1);
  const q3Now = q3(S.year);
  const q3Pct = (a: number | null, b: number | null): number | null => (a === null || b === null ? null : pct2(a, b));
  const runrate = {
    [`q3_${S.year - 2}`]: q3Prior2,
    [`q3_${S.year - 1}`]: q3Prior1,
    [`q3_${S.year}`]: q3Now,
    [`yoy_${S.year - 1}`]: q3Pct(q3Prior2, q3Prior1),
    [`yoy_${S.year}`]: q3Pct(q3Prior1, q3Now),
  };

  // account movers (opex)
  const movers: Record<string, unknown> = {};
  for (const c of [S.comparisons[2]!, S.comparisons[0]!]) {
    const curMonths = S.standard.find((p) => p.id === c.current)!.months;
    const priMonths = S.standard.find((p) => p.id === c.prior)!.months;
    const threshold = c.family === 'FY' ? derivation.account_movers.minAbsDelta.FY : derivation.account_movers.minAbsDelta.YTD;
    const list = accountDeltas(index, e.id, curMonths, priMonths, ['opex']).map((t) => ({
      category: t.c,
      account: t.a,
      prior: r2(t.prior),
      current: r2(t.current),
      delta: r2(t.current - t.prior),
      pct: pct2(t.prior, t.current),
    }));
    movers[c.id] = byAbsDeltaDesc(list.filter((x) => Math.abs(x.delta) >= threshold));
  }

  // history
  const firstYear = Number(firstMonth.slice(0, 4));
  const lastYear = Number(lastMonth.slice(0, 4));
  const yr: Record<string, unknown> = {};
  const ytd: Record<string, unknown> = {};
  const yearN = new Map<number, number>();
  for (let y = firstYear; y <= lastYear; y++) {
    const full = aggregateRows(index, e.id, monthsOfYear(y));
    const fullRows = rowsIn(index, e.id, monthsOfYear(y));
    yearN.set(y, full.n_months);
    yr[String(y)] = {
      br: r2(full.base_rent),
      rev: r2(full.revenue),
      opex: r2(full.opex),
      cats: mapValues(sumByCategory(fullRows, 'opex'), r2),
      rc: mapValues(sumByCategory(fullRows, 'rev'), r2),
      noi: r2(full.noi),
      n: full.n_months,
      partial: false,
    };
    const slice = aggregateRows(index, e.id, monthsOfYear(y, S.month));
    const sliceRows = rowsIn(index, e.id, monthsOfYear(y, S.month));
    ytd[String(y)] = {
      br: r2(slice.base_rent),
      rev: r2(slice.revenue),
      opex: r2(slice.opex),
      cats: mapValues(sumByCategory(sliceRows, 'opex'), r2),
      rc: mapValues(sumByCategory(sliceRows, 'rev'), r2),
      noi: r2(slice.noi),
      n: slice.n_months,
    };
  }
  const g = monthRange(firstMonth, lastMonth);
  const brExact = g.map((m) => exactMonths.get(m)?.base_rent ?? null);
  const months = {
    g,
    br: g.map((m) => (exactMonths.has(m) ? r0c(exactMonths.get(m)!.base_rent) : null)),
    rv: g.map((m) => (exactMonths.has(m) ? r0c(exactMonths.get(m)!.revenue) : null)),
    ox: g.map((m) => (exactMonths.has(m) ? r0c(exactMonths.get(m)!.opex) : null)),
    tx: g.map((m) => (exactMonths.has(m) ? r0c(exactMonths.get(m)!.opex_by['Real estate & property tax'] ?? 0) : 0)),
  };
  const ev = rentStepEvents(g, brExact).map((x) => ({ m: x.m, a: r0(x.a), b: r0(x.b), pct: x.pct }));

  const drv: Record<string, unknown> = {};
  for (let y = firstYear + 1; y <= lastYear; y++) {
    if (yearN.get(y) !== 12 || yearN.get(y - 1) !== 12) continue;
    drv[String(y)] = drivers(index, e.id, monthsOfYear(y), monthsOfYear(y - 1), derivation);
  }
  drv[S.ytdKey] = drivers(index, e.id, monthsOfYear(S.year, S.month), monthsOfYear(S.year - 1, S.month), derivation);

  return {
    property: {
      id: e.id,
      label: e.label,
      source: e.source,
      kind: 'monthly',
      first_month: firstMonth,
      last_month: lastMonth,
      missing_months_since_2024: missing,
      periods,
      yoy,
      base_rent_runrate_q3: runrate,
    },
    cube,
    movers,
    history: { monthly: true, yr, ytd, months, drv, ev },
    exactPeriods,
  };
}

function drivers(index: RowIndex, entity: string, cur: readonly string[], pri: readonly string[], derivation: DerivationConfig): unknown[] {
  const list = accountDeltas(index, entity, cur, pri, ['rev', 'opex']).map((t) => {
    const byMonth = cur.map((m) => ({ month: m, amount: sumWhere(index.get(entity)?.get(m) ?? [], (r) => r.line_type === t.lt && r.category === t.c && r.source_account === t.a) }));
    const timing = driverTiming(byMonth);
    return {
      delta: r0(t.current - t.prior),
      row: {
        lt: t.lt,
        c: t.c,
        a: t.a,
        p: r0(t.prior),
        n: r0(t.current),
        d: r0(t.current - t.prior),
        pct: pct3abs(t.prior, t.current),
        nat: driverNature({ activeMonths: timing.activeMonths, topShare: timing.topShare }),
        nm: timing.activeMonths,
        top: timing.topMonth,
        conc: r2(timing.topShare),
      },
    };
  });
  return byAbsDeltaDesc(list.filter((x) => Math.abs(x.delta) >= derivation.drivers.minAbsDelta))
    .slice(0, derivation.drivers.max)
    .map((x) => x.row);
}

// -------------------------------------------------------------------------------------------------
// Annual entity
// -------------------------------------------------------------------------------------------------

const PARTIAL_RE = /^(\d{4})-YTD\(thru (\d{4}-\d{2}-\d{2})\)$/;

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function buildAnnualEntity(
  e: EntityRegistryEntry,
  index: RowIndex,
  S: Scaffold,
  derivation: DerivationConfig,
): { property: Record<string, unknown>; history: Record<string, unknown>; exactPeriods: Record<string, RebuiltPeriod> } {
  const keys = [...(index.get(e.id)?.keys() ?? [])];
  const partials = keys.filter((k) => PARTIAL_RE.test(k));
  if (partials.length !== 1) throw new Error(`${e.id}: annual entity needs exactly one "<year>-YTD(thru <date>)" statement, found ${partials.length}`);
  const partialKey = partials[0]!;
  const [, pYear, thru] = PARTIAL_RE.exec(partialKey)!;
  if (Number(pYear) !== S.year) throw new Error(`${e.id}: partial statement year ${pYear} does not match as_of year ${S.year}`);
  const thruMonth = Number(thru!.slice(5, 7));
  const thruDay = Number(thru!.slice(8, 10));
  const partialMonths = pyRound(thruMonth - 1 + thruDay / daysInMonth(S.year, thruMonth), 1);
  const partialId = `YTD${S.yy}_partial_thru_${thru}`;

  const fyKey = (y: number): string => `${y}-FY`;
  const periodDefs = [
    { id: S.fyIds.prior, key: fyKey(S.year - 2), year: S.year - 2, n: 12, partial: false },
    { id: S.fyIds.current, key: fyKey(S.year - 1), year: S.year - 1, n: 12, partial: false },
    { id: partialId, key: partialKey, year: S.year, n: partialMonths, partial: true },
  ];
  for (const p of periodDefs) if (!index.get(e.id)?.has(p.key)) throw new Error(`${e.id}: no rows for statement period ${p.key}`);

  const exactPeriods: Record<string, RebuiltPeriod> = {};
  const periods: Record<string, unknown> = {};
  const yr: Record<string, unknown> = {};
  for (const p of periodDefs) {
    const a = aggregateRows(index, e.id, [p.key]);
    exactPeriods[p.id] = a;
    periods[p.id] = roundPeriod(a, p.n);
    const prows = rowsIn(index, e.id, [p.key]);
    yr[String(p.year)] = {
      br: r2(a.base_rent),
      rev: r2(a.revenue),
      opex: r2(a.opex),
      cats: mapValues(sumByCategory(prows, 'opex'), r2),
      rc: mapValues(sumByCategory(prows, 'rev'), r2),
      noi: r2(a.noi),
      n: 1,
      partial: p.partial,
    };
  }

  const pri = exactPeriods[S.fyIds.prior]!;
  const cur = exactPeriods[S.fyIds.current]!;
  const yoy = {
    [`${S.fyIds.current}_vs_${S.fyIds.prior}`]: {
      base_rent: pct2(pri.base_rent, cur.base_rent),
      energy_income: pct2(pri.energy_income, cur.energy_income),
      revenue: pct2(pri.revenue, cur.revenue),
      opex: pct2(pri.opex, cur.opex),
      noi: pct2(pri.noi, cur.noi),
      delta: { revenue: r2(cur.revenue - pri.revenue), opex: r2(cur.opex - pri.opex), noi: r2(cur.noi - pri.noi) },
    },
  };

  const byType = (key: string, lt: LineType): number => r2(sumWhere(rowsIn(index, e.id, [key]), (r) => r.line_type === lt));
  const nonop = {
    [`interest_income_${S.year}ytd`]: byType(partialKey, 'nonop'),
    interest_expense: Object.fromEntries(periodDefs.map((p) => [String(p.year), byType(p.key, 'debt')])),
    entity_income_tax: Object.fromEntries(periodDefs.map((p) => [String(p.year), byType(p.key, 'inctax')])),
  };

  const drvList = accountDeltas(index, e.id, [fyKey(S.year - 1)], [fyKey(S.year - 2)], ['rev', 'opex']).map((t) => ({
    delta: r0(t.current - t.prior),
    row: {
      lt: t.lt,
      c: t.c,
      a: t.a,
      p: r0(t.prior),
      n: r0(t.current),
      d: r0(t.current - t.prior),
      pct: pct3abs(t.prior, t.current),
      nat: driverNature({ annualOnly: true, activeMonths: 0, topShare: 0 }),
      nm: 0,
      top: null,
      conc: 0,
    },
  }));
  const drv = {
    [String(S.year - 1)]: byAbsDeltaDesc(drvList.filter((x) => Math.abs(x.delta) >= derivation.drivers.minAbsDelta))
      .slice(0, derivation.drivers.max)
      .map((x) => x.row),
  };

  return {
    property: { id: e.id, label: e.label, source: e.source, kind: 'annual', periods, yoy, nonop },
    history: { monthly: false, yr, ytd: {}, months: null, drv, ev: [] },
    exactPeriods,
  };
}
