// src/contracts/property-financials.ts
//
// Property Financials module — the typed boundary for data/property-financials/dataset.json
// (docs/superpowers/plans/2026-10-05-property-financials-module.md, T1; field meanings in
// data/property-financials/data-dictionary.md). This is a THIRD basis of NOI ("normalized NOI,
// cash basis"), read-only and separate from Spine A (Property.noi) and Spine B (warehouse ledger
// NOI). Nothing here feeds scoring or governors; it must never be aggregated with either spine
// without explicit basis-matching (CLAUDE.md §1).
//
// Every object is .strict(): the dataset is a committed file that a refresh pipeline rewrites, so an
// unknown key is drift that must fail the loader, not pass through silently. Where the real data
// legitimately varies (annual vs monthly entities, optional lease facts, partial category maps in
// history rows) the variation is modelled, not loosened.
//
// All names are prefixed `Pf` to avoid colliding with the Spine-A contracts (Property, Lease,
// Insight) that the barrel also re-exports.
import { z } from 'zod';

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

/** The nine entities with PM monthly exports (in dataset order). */
export const PF_MONTHLY_ENTITY_IDS = [
  '1100 Rarig',
  '1900 Broadway',
  '29000 Info Lane',
  '3034 Westerville',
  '3540 E 5th',
  '3883 Livingston',
  '9050 Red Branch',
  '9620 State 350',
  'FVC',
] as const;

/** The two entity-level annual QuickBooks statements (no monthly detail). */
export const PF_ANNUAL_ENTITY_IDS = ['55 New Plant (EGFLLC)', '1851 South Club Solar'] as const;

/** All 11 entity ids. 2203-2207 Northwood is excluded by instruction (financials pending). */
export const PF_ENTITY_IDS = [...PF_MONTHLY_ENTITY_IDS, ...PF_ANNUAL_ENTITY_IDS] as const;

export type PfMonthlyEntityId = (typeof PF_MONTHLY_ENTITY_IDS)[number];
export type PfAnnualEntityId = (typeof PF_ANNUAL_ENTITY_IDS)[number];
export type PfEntityId = (typeof PF_ENTITY_IDS)[number];

/** Operating-expense categories in their fixed display order (data dictionary "opex categories"). */
export const OPEX_CATEGORIES = [
  'Real estate & property tax',
  'Insurance',
  'Management fees',
  'Utilities',
  'Grounds / snow / lot',
  'Repairs & maintenance',
  'Turnover / make-ready',
  'Professional / admin',
] as const;
export type OpexCategory = (typeof OPEX_CATEGORIES)[number];

/** Revenue categories (data dictionary "Revenue categories"). */
export const REVENUE_CATEGORIES = [
  'Base rent',
  'Vacancy / waivers / bad debt',
  'Recoveries (CAM/tax/ins)',
  'Utility reimbursements',
  'Other income',
  'Solar / energy income',
] as const;
export type RevenueCategory = (typeof REVENUE_CATEGORIES)[number];

/** Below-the-line keys (never part of normalized NOI). */
export const BELOW_LINE_KEYS = ['capex', 'dist', 'debt', 'inctax', 'noncash', 'nonop'] as const;

/** Same-store set: PM monthly exports with full history (trend / TTM / YTD views). */
export const SAME_STORE = ['1100 Rarig', '1900 Broadway', '29000 Info Lane', '3540 E 5th', '9050 Red Branch', 'FVC'] as const;

/** Excluded from trend views: lease-up or partial history. */
export const LEASE_UP_EXCLUDED = ['9620 State 350', '3034 Westerville', '3883 Livingston'] as const;

/** The six standard periods every monthly entity carries. */
export const STANDARD_PERIODS = ['FY2024', 'FY2025', 'YTD25', 'YTD26', 'TTM25', 'TTM26'] as const;
export type StandardPeriodId = (typeof STANDARD_PERIODS)[number];

/** The annual entities' 2026 period: calendar 2026 through the last QuickBooks statement date. */
export const ANNUAL_PARTIAL_PERIOD = 'YTD26_partial_thru_2026-06-12' as const;
export const ANNUAL_PERIODS = ['FY2024', 'FY2025', ANNUAL_PARTIAL_PERIOD] as const;
export type AnnualPeriodId = (typeof ANNUAL_PERIODS)[number];
export type PfPeriodId = StandardPeriodId | AnnualPeriodId;

export const MONTHLY_COMPARISONS = ['FY2025_vs_FY2024', 'TTM26_vs_TTM25', 'YTD26_vs_YTD25'] as const;
export type PfComparisonId = (typeof MONTHLY_COMPARISONS)[number];

// ---------------------------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------------------------

const fin = z.number().finite();
const finN = fin.nullable();
const pctUnit = z.number().finite().min(0).max(1);

/** `YYYY-MM` with a real month number. */
export const PfYearMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'expected YYYY-MM');
export type PfYearMonth = z.infer<typeof PfYearMonth>;
const IsoDate = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'expected YYYY-MM-DD');
const Year = z.string().regex(/^\d{4}$/, 'expected YYYY');
const NonEmpty = z.string().min(1);

const EntityId = z.enum(PF_ENTITY_IDS);
const MonthlyEntityId = z.enum(PF_MONTHLY_ENTITY_IDS);
const AnnualEntityId = z.enum(PF_ANNUAL_ENTITY_IDS);
const OpexCategoryEnum = z.enum(OPEX_CATEGORIES);
const RevenueCategoryEnum = z.enum(REVENUE_CATEGORIES);

function fixedShape<K extends string, V extends z.ZodTypeAny>(keys: readonly K[], value: V): Record<K, V> {
  return Object.fromEntries(keys.map((k) => [k, value])) as Record<K, V>;
}

/** All eight opex categories present (0 when nothing posted). */
export const PfOpexBy = z.object(fixedShape(OPEX_CATEGORIES, fin)).strict();
export type PfOpexBy = z.infer<typeof PfOpexBy>;

// ---------------------------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------------------------

export const PfMeta = z
  .object({
    title: NonEmpty,
    version: z.string().regex(/^v\d{2}$/),
    generated: IsoDate,
    as_of: IsoDate,
    basis: z.literal('cash'),
    units: z.literal('USD'),
    source_folder: NonEmpty,
    periods: z.object(fixedShape(STANDARD_PERIODS, z.object({ months: z.array(PfYearMonth).min(1) }).strict())).strict(),
    categories: z
      .object({
        revenue: z.array(RevenueCategoryEnum),
        opex: z.array(OpexCategoryEnum),
        below_line: z.array(z.enum(BELOW_LINE_KEYS)),
      })
      .strict(),
    excluded: z.array(NonEmpty),
    noi_definition: NonEmpty,
    history_note: NonEmpty,
  })
  .strict();
export type PfMeta = z.infer<typeof PfMeta>;

// ---------------------------------------------------------------------------------------------
// Portfolio views
// ---------------------------------------------------------------------------------------------

export const PfComparison = z.object({ prior: fin, current: fin, pct: finN }).strict();
export type PfComparison = z.infer<typeof PfComparison>;

export const PfPortfolioView = z
  .object({
    members: z.array(EntityId).min(1),
    view: z
      .object({
        base_rent: PfComparison,
        reimbursements: PfComparison,
        revenue: PfComparison,
        opex: PfComparison,
        noi: PfComparison,
        capex: PfComparison,
        opex_by: z.object(fixedShape(OPEX_CATEGORIES, PfComparison)).strict(),
      })
      .strict(),
  })
  .strict();
export type PfPortfolioView = z.infer<typeof PfPortfolioView>;

export const PfPortfolio = z
  .object({
    same_store_FY2025_vs_FY2024: PfPortfolioView,
    pm_only_FY2025_vs_FY2024: PfPortfolioView,
    same_store_TTM26_vs_TTM25: PfPortfolioView,
    same_store_YTD26_vs_YTD25: PfPortfolioView,
    note: NonEmpty,
  })
  .strict();
export type PfPortfolio = z.infer<typeof PfPortfolio>;

// ---------------------------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------------------------

/** One period's normalized figures. Ratios are null when the denominator is zero. */
export const PfPeriodFigures = z
  .object({
    base_rent: fin,
    vacancy_waivers: fin,
    /** recoveries + utility_reimb */
    reimbursements: fin,
    recoveries: fin,
    utility_reimb: fin,
    other_income: fin,
    energy_income: fin,
    revenue: fin,
    opex: fin,
    /** Normalized: revenue - recurring opex. */
    noi: fin,
    noi_margin: finN,
    opex_ratio: finN,
    mgmt_fee_pct: finN,
    recovery_ratio: finN,
    /** Recoverable cost pool: tax + insurance + utilities + grounds + R&M. */
    pool: fin,
    capex: fin,
    dist: fin,
    opex_by: PfOpexBy,
    /** Months with data in the window; below the period length = partial (never annualize). */
    n_months: fin.nonnegative(),
  })
  .strict();
export type PfPeriodFigures = z.infer<typeof PfPeriodFigures>;

export const PfMonthlyYoy = z
  .object({
    base_rent: finN,
    reimbursements: finN,
    revenue: finN,
    opex: finN,
    noi: finN,
    capex: finN,
    opex_by: z.object(fixedShape(OPEX_CATEGORIES, finN)).strict(),
    opex_by_delta: PfOpexBy,
    delta: z.object({ base_rent: fin, reimbursements: fin, revenue: fin, opex: fin, noi: fin }).strict(),
  })
  .strict();
export type PfMonthlyYoy = z.infer<typeof PfMonthlyYoy>;

export const PfAnnualYoy = z
  .object({
    base_rent: finN,
    energy_income: finN,
    revenue: finN,
    opex: finN,
    noi: finN,
    delta: z.object({ revenue: fin, opex: fin, noi: fin }).strict(),
  })
  .strict();
export type PfAnnualYoy = z.infer<typeof PfAnnualYoy>;

export const PfRunRateQ3 = z
  .object({ q3_2024: finN, q3_2025: finN, q3_2026: finN, yoy_2025: finN, yoy_2026: finN })
  .strict();
export type PfRunRateQ3 = z.infer<typeof PfRunRateQ3>;

const SfFields = {
  sf: fin.positive(),
  leased_sf: fin.nonnegative(),
  occupancy: pctUnit,
};

export const PfMonthlyProperty = z
  .object({
    id: MonthlyEntityId,
    label: NonEmpty,
    source: NonEmpty,
    kind: z.literal('monthly'),
    first_month: PfYearMonth,
    last_month: PfYearMonth,
    missing_months_since_2024: z.array(PfYearMonth),
    periods: z.object(fixedShape(STANDARD_PERIODS, PfPeriodFigures)).strict(),
    /** null when either side of the comparison is partial / absent. */
    yoy: z.object(fixedShape(MONTHLY_COMPARISONS, PfMonthlyYoy.nullable())).strict(),
    base_rent_runrate_q3: PfRunRateQ3,
    ...SfFields,
  })
  .strict();
export type PfMonthlyProperty = z.infer<typeof PfMonthlyProperty>;

const YearAmounts = z.object({ '2024': fin, '2025': fin, '2026': fin }).strict();

export const PfNonOp = z
  .object({
    interest_income_2026ytd: fin,
    interest_expense: YearAmounts,
    entity_income_tax: YearAmounts,
  })
  .strict();
export type PfNonOp = z.infer<typeof PfNonOp>;

export const PfAnnualProperty = z
  .object({
    id: AnnualEntityId,
    label: NonEmpty,
    source: NonEmpty,
    kind: z.literal('annual'),
    periods: z.object(fixedShape(ANNUAL_PERIODS, PfPeriodFigures)).strict(),
    yoy: z.object({ FY2025_vs_FY2024: PfAnnualYoy.nullable() }).strict(),
    nonop: PfNonOp,
    // The solar entity has no building SF; 55 New Plant does.
    sf: SfFields.sf.optional(),
    leased_sf: SfFields.leased_sf.optional(),
    occupancy: SfFields.occupancy.optional(),
  })
  .strict();
export type PfAnnualProperty = z.infer<typeof PfAnnualProperty>;

export const PfProperty = z.discriminatedUnion('kind', [PfMonthlyProperty, PfAnnualProperty]);
export type PfProperty = z.infer<typeof PfProperty>;

const PfProperties = z
  .object({
    ...fixedShape(PF_MONTHLY_ENTITY_IDS, PfMonthlyProperty),
    ...fixedShape(PF_ANNUAL_ENTITY_IDS, PfAnnualProperty),
  })
  .strict()
  .superRefine((props, ctx) => {
    for (const [key, p] of Object.entries(props)) {
      if (p.id !== key) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key, 'id'], message: 'id must equal its key' });
    }
  });
export type PfProperties = z.infer<typeof PfProperties>;

// ---------------------------------------------------------------------------------------------
// Monthly cube + account movers
// ---------------------------------------------------------------------------------------------

export const PfMonthFigures = z
  .object({
    base_rent: fin,
    reimbursements: fin,
    other_income: fin,
    vacancy_waivers: fin,
    revenue: fin,
    opex: fin,
    noi: fin,
    capex: fin,
    opex_by: PfOpexBy,
  })
  .strict();
export type PfMonthFigures = z.infer<typeof PfMonthFigures>;

const PfMonthlyCube = z.object(fixedShape(PF_MONTHLY_ENTITY_IDS, z.record(PfYearMonth, PfMonthFigures))).strict();
export type PfMonthlyCube = z.infer<typeof PfMonthlyCube>;

export const PfAccountMover = z
  .object({
    category: OpexCategoryEnum,
    account: NonEmpty,
    prior: fin,
    current: fin,
    delta: fin,
    /** null when prior is zero. */
    pct: finN,
  })
  .strict();
export type PfAccountMover = z.infer<typeof PfAccountMover>;

const PfAccountMovers = z
  .object(
    fixedShape(
      PF_MONTHLY_ENTITY_IDS,
      z.object({ YTD26_vs_YTD25: z.array(PfAccountMover), FY2025_vs_FY2024: z.array(PfAccountMover) }).strict(),
    ),
  )
  .strict();
export type PfAccountMovers = z.infer<typeof PfAccountMovers>;

// ---------------------------------------------------------------------------------------------
// Insights, leases, data quality
// ---------------------------------------------------------------------------------------------

export const PF_SEVERITIES = ['High', 'Medium', 'Low'] as const;
export const PF_INSIGHT_TYPES = ['Revenue', 'Expense', 'Recovery'] as const;

export const PfInsight = z
  .object({
    id: z.string().regex(/^[A-Z]+-\d+$/),
    severity: z.enum(PF_SEVERITIES),
    type: z.enum(PF_INSIGHT_TYPES),
    /** Entity id, 'Portfolio', or a lease-only property (7658 Fishel). */
    property: NonEmpty,
    title: NonEmpty,
    finding: NonEmpty,
    action: NonEmpty,
    /** null = "verify": no dollar estimate. */
    annual_impact_usd: finN,
    impact_basis: z.string().nullable(),
    tags: z.array(NonEmpty),
    evidence: z.record(z.string(), fin),
  })
  .strict();
export type PfInsight = z.infer<typeof PfInsight>;

/** [from, to, monthly amount]; `to` is null and `from` is a label ("Y1", "LY3", "2024") for relative schedules. */
export const PfRentStepRow = z.tuple([NonEmpty, z.string().nullable(), fin]);
export type PfRentStepRow = z.infer<typeof PfRentStepRow>;

export const PfLease = z
  .object({
    property: NonEmpty,
    tenant: NonEmpty,
    sf: finN,
    term: NonEmpty,
    rent_schedule_monthly: z.array(PfRentStepRow).optional(),
    rent_annual: z.record(z.string(), fin).optional(),
    security_deposit: fin.optional(),
    nnn_estimate_monthly: fin.optional(),
    renewal: NonEmpty.optional(),
    second_renewal: NonEmpty.optional(),
    escalator: NonEmpty.optional(),
    mgmt_fee_cap: NonEmpty.optional(),
    hvac_replacement_recovery: NonEmpty.optional(),
    source: NonEmpty,
    confidence: NonEmpty,
  })
  .strict();
export type PfLease = z.infer<typeof PfLease>;

// ---------------------------------------------------------------------------------------------
// History (full-history explorer data)
// ---------------------------------------------------------------------------------------------

const PfHistoryRowBase = {
  br: fin,
  rev: fin,
  opex: fin,
  /** Only categories with postings appear. */
  cats: z.record(OpexCategoryEnum, fin),
  rc: z.record(RevenueCategoryEnum, fin),
  noi: fin,
  /** Months with data (annual entities: 1 statement). */
  n: z.number().int().nonnegative(),
};

export const PfHistoryYear = z.object({ ...PfHistoryRowBase, partial: z.boolean() }).strict();
export type PfHistoryYear = z.infer<typeof PfHistoryYear>;

export const PfHistoryYtd = z.object(PfHistoryRowBase).strict();
export type PfHistoryYtd = z.infer<typeof PfHistoryYtd>;

/** Parallel monthly series: g = months, br = base rent, rv = revenue, ox = opex, tx = RE tax. */
export const PfHistoryMonths = z
  .object({
    g: z.array(PfYearMonth).min(1),
    br: z.array(finN),
    rv: z.array(finN),
    ox: z.array(finN),
    tx: z.array(fin),
  })
  .strict()
  .refine((m) => [m.br, m.rv, m.ox, m.tx].every((s) => s.length === m.g.length), {
    message: 'months series must be parallel to g',
  });
export type PfHistoryMonths = z.infer<typeof PfHistoryMonths>;

export const PF_DRIVER_NATURES = ['recurring', 'lumpy', 'mixed', 'annual'] as const;
export type PfDriverNature = (typeof PF_DRIVER_NATURES)[number];

export const PfDriver = z
  .object({
    lt: z.enum(['rev', 'opex']),
    c: z.union([OpexCategoryEnum, RevenueCategoryEnum]),
    a: NonEmpty,
    p: fin,
    n: fin,
    d: fin,
    pct: finN,
    nat: z.enum(PF_DRIVER_NATURES),
    /** Active (non-zero) months in the current period. */
    nm: z.number().int().nonnegative(),
    top: PfYearMonth.nullable(),
    /** Share of the current-period total held by the top month. */
    conc: pctUnit,
  })
  .strict();
export type PfDriver = z.infer<typeof PfDriver>;

/** A net base-rent step: median of the 3 months from `m` (b) vs the 3 months before (a). */
export const PfRentStepEvent = z.object({ m: PfYearMonth, a: fin, b: fin, pct: fin }).strict();
export type PfRentStepEvent = z.infer<typeof PfRentStepEvent>;

export const PfHistoryEntity = z
  .object({
    monthly: z.boolean(),
    yr: z.record(Year, PfHistoryYear),
    ytd: z.record(Year, PfHistoryYtd),
    months: PfHistoryMonths.nullable(),
    /** Keyed by year ("2025" = 2025 vs 2024) or "YTD26" (Jan-Sep 2026 vs 2025). */
    drv: z.record(z.string().regex(/^(\d{4}|YTD26)$/), z.array(PfDriver)),
    ev: z.array(PfRentStepEvent),
  })
  .strict()
  .refine((h) => (h.monthly ? h.months !== null : h.months === null && h.ev.length === 0), {
    message: 'monthly entities carry a months series; annual entities carry none and no rent steps',
  });
export type PfHistoryEntity = z.infer<typeof PfHistoryEntity>;

// ---------------------------------------------------------------------------------------------
// Square footage
// ---------------------------------------------------------------------------------------------

export const PfSfEntry = z
  .object({
    /** null for the solar entity (not applicable). */
    sf: fin.positive().nullable(),
    leased_sf: fin.nonnegative().optional(),
    occ: pctUnit.optional(),
    tenants: z.number().int().nonnegative().optional(),
    source: NonEmpty.optional(),
    common_area_sf: fin.nonnegative().optional(),
    note: NonEmpty,
  })
  .strict();
export type PfSfEntry = z.infer<typeof PfSfEntry>;

// ---------------------------------------------------------------------------------------------
// Dataset
// ---------------------------------------------------------------------------------------------

export const PfDataset = z
  .object({
    meta: PfMeta,
    portfolio: PfPortfolio,
    properties: PfProperties,
    monthly: PfMonthlyCube,
    account_movers: PfAccountMovers,
    insights: z.array(PfInsight),
    leases: z.array(PfLease),
    data_quality: z.array(NonEmpty),
    history: z.object(fixedShape(PF_ENTITY_IDS, PfHistoryEntity)).strict(),
    sf: z.object(fixedShape(PF_ENTITY_IDS, PfSfEntry)).strict(),
  })
  .strict();
export type PfDataset = z.infer<typeof PfDataset>;

const MAX_REPORTED_ISSUES = 12;

/**
 * Parse an untrusted dataset. Throws an Error whose message carries only Zod paths and issue codes
 * — never input values — so a loader can log it without echoing figures.
 */
export function parsePropertyFinancialsDataset(raw: unknown): PfDataset {
  const result = PfDataset.safeParse(raw);
  if (result.success) return result.data;
  const issues = result.error.issues;
  const shown = issues.slice(0, MAX_REPORTED_ISSUES).map((i) => {
    const where = i.path.length ? i.path.join('.') : '<root>';
    // Unknown KEY NAMES are structure, not figures — naming them is what makes drift diagnosable.
    const keys = i.code === z.ZodIssueCode.unrecognized_keys ? ` [${i.keys.join(', ')}]` : '';
    return `${where}: ${i.code}${keys}`;
  });
  const more = issues.length > MAX_REPORTED_ISSUES ? `; +${issues.length - MAX_REPORTED_ISSUES} more` : '';
  throw new Error(`property-financials dataset failed validation (${issues.length} issue(s)): ${shown.join('; ')}${more}`);
}
