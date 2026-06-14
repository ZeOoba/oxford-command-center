// src/contracts/warehouse.ts
import { z } from 'zod';

export const Classification = z.enum([
  'revenue', 'recovery', 'other-income', 'opex',
  'capex', 'ti', 'leasing', 'debt-service', 'excluded',
]);
export type Classification = z.infer<typeof Classification>;

/** Capital-allocation recommendation for a property — the single source of truth shared by the server
 *  scoring engine and the client intel views (M4: was duplicated in intel-config.ts + analytics-hooks.ts). */
export const CapitalAction = z.enum(['invest', 'hold', 'monitor', 'disposition-candidate']);
export type CapitalAction = z.infer<typeof CapitalAction>;

/** Classes whose active ledger rows participate in NOI: revenue + recovery + other-income − opex. */
export const NOI_CLASSES = ['revenue', 'recovery', 'other-income', 'opex'] as const;

/**
 * Income classes — the positive NOI contributors (NOI_CLASSES minus opex). Derived from NOI_CLASSES
 * so that adding/removing an income member there propagates to every PRODUCTION codepath (queries.ts
 * noiMatrix, metrics.ts propertyPeriodMetrics, mapping.ts classificationSide, and the warehouse CLIs)
 * WITHOUT re-listing string literals that silently drift. Single source of truth for "which classes
 * are NOI income." (Test oracles in warehouse-ingest.test.ts deliberately keep the literal so they
 * remain an INDEPENDENT check on this derivation — see the comments there.)
 */
export const NOI_INCOME_CLASSES = NOI_CLASSES.filter((c) => c !== 'opex');

/** True when a ledger classification is an NOI income (positive) contributor. */
export function isNoiIncomeClass(c: string): boolean {
  return (NOI_INCOME_CLASSES as readonly string[]).includes(c);
}

/** True when a ledger classification is the NOI opex (negative) contributor. */
export function isOpex(c: string): boolean {
  return c === 'opex';
}

export const Basis = z.enum(['cash', 'accrual', 'tax', 'unknown']);
export const SourceSystem = z.enum(['quickbooks', 'yardi', 'rent-manager', 'appfolio', 'unknown']);
export const PeriodGrain = z.enum(['month', 'year', 'ytd']);
export const ImportStatus = z.enum(['pending-review', 'committed', 'superseded', 'rejected']);
export const FinancialMode = z.enum(['pnl', 'lease-run']);

export const PropertyMasterRowSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  market: z.string().nullish(),
  address: z.string().nullish(),
  propertyManager: z.string().nullish(),
  pmContact: z.string().nullish(),
  pmPlatform: z.string().nullish(),
  financialMode: FinancialMode.default('pnl'),
  rentableSf: z.number().nonnegative().finite().nullish(),
  acquisitionDate: z.string().nullish(),
  ownershipPct: z.number().gt(0).max(1).default(1),
  ownershipStatus: z.string().default('active'),
  assetClass: z.string().nullish(),
  notes: z.string().nullish(),
});
export type PropertyMasterRow = z.infer<typeof PropertyMasterRowSchema>;

export const RawAccountLineSchema = z.object({
  code: z.string().nullish(),
  name: z.string().min(1),
  section: z.string().min(1),
  parent: z.string().nullish(),
  total: z.number().finite().nullable(),
});
export type RawAccountLine = z.infer<typeof RawAccountLineSchema>;

export const RawStatementSchema = z.object({
  propertyRaw: z.string(),
  periodLabel: z.string(),
  periodStart: z.string().nullable(),
  periodEnd: z.string().nullable(),
  grain: PeriodGrain,
  basis: Basis,
  sourceSystem: SourceSystem,
  accounts: z.array(RawAccountLineSchema),
  totalIncome: z.number().finite().nullable(),
  totalExpense: z.number().finite().nullable(),
  // Per-section foot scope: each statement section with the leaf total accumulated
  // while the section was OPEN (accumulation closes at the section's top-level Total
  // row) and the report-stated total captured from that row (null = never stated).
  sections: z.array(z.object({
    name: z.string().min(1),
    leafSum: z.number().finite(),
    statedTotal: z.number().finite().nullable(),
  })).default([]),
});
export type RawStatement = z.infer<typeof RawStatementSchema>;

export const LedgerEntrySchema = z.object({
  importId: z.number().int(),
  propertyId: z.string().min(1),
  period: z.string().regex(/^\d{4}(-(0[1-9]|1[0-2]))?$/),
  rawAccount: z.string().min(1),
  glCode: z.string().nullish(),
  amount: z.number().finite(),
  normalizedCategory: z.string().min(1),
  classification: Classification,
});
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

export const AccountMappingSchema = z.object({
  account: z.string().min(1),
  code: z.string().nullish(),
  normalized_category: z.string().min(1),
  classification: Classification,
  confidence: z.string().optional(),
  note: z.string().nullish(),
});
export type AccountMapping = z.infer<typeof AccountMappingSchema>;

// ── Calibration log (the 40-year feedback loop) ───────────────────────────
// Records every warehouse verdict at the moment it is made, freezes the exact
// ledger+config state that produced it (inputs_version), and later records the
// realized outcome. Append-only / deterministic / fail-open by design — these
// schemas are the validation boundary for the calibration emit path and the
// (Phase 2) /calibration routes. Nothing here is a governor.
export const SubjectKind = z.enum(['property', 'tenant', 'loan', 'deal', 'portfolio', 'pm']);
export type SubjectKind = z.infer<typeof SubjectKind>;

export const VerdictKind = z.enum([
  'health-band', 'attention', 'capital-action', 'anomaly',
  'refi-score', 'acquisition-score', 'forecast',
]);
export type VerdictKind = z.infer<typeof VerdictKind>;

export const VerdictEngine = z.enum([
  'scores', 'anomalies', 'benchmarks', 'growth', 'drivers', 'refi', 'acquisition', 'forecast',
]);
export type VerdictEngine = z.infer<typeof VerdictEngine>;

export const PredictedUnit = z.enum(['score-0-100', 'pct-change', 'usd', 'usd-per-sf', 'band']);
export type PredictedUnit = z.infer<typeof PredictedUnit>;

export const ActionTaken = z.enum(['none', 'acted-aligned', 'acted-counter', 'unknown']);
export type ActionTaken = z.infer<typeof ActionTaken>;

/** A YYYY or YYYY-MM period token (same shape as LedgerEntrySchema.period). */
const PeriodToken = z.string().regex(/^\d{4}(-(0[1-9]|1[0-2]))?$/);

export const InputsVersionSchema = z.object({
  inputsVersion: z.string().length(16),
  ledgerFingerprint: z.string().min(1),
  configHash: z.string().min(1),
  codeVersion: z.string().min(1),
  configJson: z.string().min(2), // serialized INTEL_CONFIG, stored verbatim
  createdAt: z.string().optional(),
});
export type InputsVersion = z.infer<typeof InputsVersionSchema>;

export const CalibrationVerdictSchema = z.object({
  subjectKind: SubjectKind,
  subjectId: z.string().min(1),
  verdictKind: VerdictKind,
  // Sub-identity WITHIN a verdict_kind. '' (default) for the singleton scores kinds; the anomaly
  // `kind` for anomalies. Part of the dedup identity so several distinct anomalies for one
  // (subject, period, inputs_version) do not collide to a single dedup_key (D3).
  verdictSubkind: z.string().default(''),
  verdictEngine: VerdictEngine,
  predictedBand: z.string().nullable(),
  predictedValue: z.number().finite().nullable(),
  predictedUnit: PredictedUnit.nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  direction: z.enum(['up', 'down', 'flat', 'n/a']).default('n/a'),
  reasons: z.array(z.string()).default([]),
  asOfPeriod: PeriodToken,
  horizonPeriods: z.number().int().positive().nullable(),
  inputsVersion: z.string().length(16),
  emittedBy: z.string().min(1),
}).refine((v) => v.predictedBand !== null || v.predictedValue !== null, {
  message: 'a verdict must carry a band, a value, or both',
});
export type CalibrationVerdict = z.infer<typeof CalibrationVerdictSchema>;

export const CalibrationOutcomeSchema = z.object({
  calibrationId: z.number().int().positive(),
  realizedBand: z.string().nullable(),
  realizedValue: z.number().finite().nullable(),
  realizedUnit: PredictedUnit.nullable(),
  outcomePeriod: PeriodToken,
  horizonActual: z.number().int().nonnegative().nullable(),
  hit: z.union([z.literal(0), z.literal(1)]).nullable(),
  absError: z.number().nonnegative().nullable(),
  brierComponent: z.number().min(0).max(1).nullable(),
  actionTaken: ActionTaken.default('unknown'),
  actionDetail: z.string().nullable(),
  treatmentNote: z.string().nullable(),
  resolvedBy: z.string().min(1),
  resolutionBasis: z.string().min(1),
  isResolution: z.boolean().default(false),
  inputsVersion: z.string().length(16).nullable(),
});
export type CalibrationOutcome = z.infer<typeof CalibrationOutcomeSchema>;

// ── Warehouse analytics read boundary (H6 / I2) ───────────────────────────────────────────────
// Promotes the warehouse analytics-engine return types to Zod schemas so every server→client
// analytics payload crosses a PARSED contract — the client (src/modules/intel/analytics-hooks.ts)
// imports these z.infer types + envelope schemas and `.parse()`s each response instead of casting
// raw JSON, and each /analytics/* route `.parse()`s before `c.json(...)` (mirrors acquisition.ts,
// whose engine ends with AcquisitionScore.parse(result)). These schemas MUST match the CURRENT
// engine output EXACTLY — a behavior-preserving boundary, not a data change. Source of truth:
// server/warehouse/{metrics,scores,growth,drivers,anomalies,benchmarks}.ts. CapitalAction is
// single-sourced above (M4); the remaining shared engine enums are single-sourced here and the
// engines re-export them as their local type names.

export const HealthBand = z.enum(['excellent', 'good', 'watch', 'concern']);
export type HealthBand = z.infer<typeof HealthBand>;

export const AttentionBand = z.enum(['green', 'yellow', 'orange', 'red']);
export type AttentionBand = z.infer<typeof AttentionBand>;

export const AnomalySeverity = z.enum(['low', 'moderate', 'high', 'critical']);
export type AnomalySeverity = z.infer<typeof AnomalySeverity>;

export const AnomalyKind = z.enum([
  'expense-growth', 'revenue-decline', 'noi-decline', 'noi-per-sf-decline', 'new-category', 'category-spike',
]);
export type AnomalyKind = z.infer<typeof AnomalyKind>;

/** NOI/SF quartile: 1 = top … 4 = bottom; null = low-confidence singleton cohort (n<2). */
export const Quartile = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).nullable();
export type Quartile = z.infer<typeof Quartile>;

/** A benchmarkable numeric PeriodMetrics key — in lockstep with benchmarks.ts and the
 *  /analytics/benchmarks route's `metric` enum. */
export const NumericMetricKey = z.enum([
  'revenue', 'opex', 'noi', 'oxfordNoi', 'noiMargin', 'expenseRatio',
  'revenuePerSf', 'noiPerSf', 'expensePerSf', 'taxesPerSf', 'insurancePerSf', 'repairsPerSf',
]);
export type NumericMetricKey = z.infer<typeof NumericMetricKey>;

// ── Payload schemas — each mirrors ONE engine return type EXACTLY (no field added/dropped). ─────

/** metrics.ts → PeriodMetrics: per (propertyId, period) financial metrics (100%-basis). */
export const PeriodMetricsSchema = z.object({
  propertyId: z.string(),
  propertyName: z.string().nullable(),
  period: z.string(),
  grainHint: z.string().nullable(),
  basis: z.string(),
  rentableSf: z.number().nullable(),
  ownershipPct: z.number(),
  revenue: z.number(),
  opex: z.number(),
  noi: z.number(),
  noiMargin: z.number().nullable(),
  expenseRatio: z.number().nullable(),
  capex: z.number(),
  ti: z.number(),
  leasing: z.number(),
  categories: z.record(z.string(), z.number()),
  revenueCategories: z.record(z.string(), z.number()),
  revenuePerSf: z.number().nullable(),
  noiPerSf: z.number().nullable(),
  expensePerSf: z.number().nullable(),
  taxesPerSf: z.number().nullable(),
  insurancePerSf: z.number().nullable(),
  repairsPerSf: z.number().nullable(),
  oxfordNoi: z.number(),
});
export type PeriodMetrics = z.infer<typeof PeriodMetricsSchema>;

/** scores.ts → PropertyScore: per-property health + attention + capital-allocation recommendation. */
export const PropertyScoreSchema = z.object({
  propertyId: z.string(),
  propertyName: z.string().nullable(),
  period: z.string(),
  health: z.number(),
  healthBand: HealthBand,
  attentionBand: AttentionBand,
  capitalAction: CapitalAction,
  subScores: z.record(z.string(), z.number()),
  noiPerSfQuartile: Quartile,
  benchmarkCohortSize: z.number(),
  reasons: z.array(z.string()),
});
export type PropertyScore = z.infer<typeof PropertyScoreSchema>;

/** growth.ts → GrowthPoint: period-over-period growth for one property's series. */
export const GrowthPointSchema = z.object({
  propertyId: z.string(),
  period: z.string(),
  comparable: z.boolean(),
  revenueGrowth: z.number().nullable(),
  expenseGrowth: z.number().nullable(),
  noiGrowth: z.number().nullable(),
  noiPerSfGrowth: z.number().nullable(),
});
export type GrowthPoint = z.infer<typeof GrowthPointSchema>;

/** growth.ts → SinceAcquisition: anchor→latest same-grain spread for one property. */
export const SinceAcquisitionSchema = z.object({
  propertyId: z.string().nullable(),
  anchorPeriod: z.string().nullable(),
  latestPeriod: z.string().nullable(),
  comparable: z.boolean(),
  revenueGrowth: z.number().nullable(),
  noiGrowth: z.number().nullable(),
  noiPerSfGrowth: z.number().nullable(),
  taxesGrowth: z.number().nullable(),
  insuranceGrowth: z.number().nullable(),
  revenuePerSfGrowth: z.number().nullable(),
  noiCagr: z.number().nullable(),
});
export type SinceAcquisition = z.infer<typeof SinceAcquisitionSchema>;

/** drivers.ts → NoiDriver: a single ΔNOI driver by normalized category. */
export const NoiDriverSchema = z.object({
  category: z.string(),
  delta: z.number(),
  contributionPct: z.number().nullable(),
});
export type NoiDriver = z.infer<typeof NoiDriverSchema>;

/** drivers.ts → NoiDecomposition (engine return): ΔNOI total + ranked drivers. The /analytics/
 *  drivers route wraps this with propertyId/from/to (see DriversResponseSchema). */
export const NoiDecompositionSchema = z.object({
  totalDelta: z.number(),
  drivers: z.array(NoiDriverSchema),
});
export type NoiDecomposition = z.infer<typeof NoiDecompositionSchema>;

/** anomalies.ts → AnomalyFlag: a flagged anomaly between consecutive same-grain periods. */
export const AnomalyFlagSchema = z.object({
  propertyId: z.string(),
  period: z.string(),
  kind: AnomalyKind,
  severity: AnomalySeverity,
  detail: z.string(),
  metricValue: z.number().nullable(),
});
export type AnomalyFlag = z.infer<typeof AnomalyFlagSchema>;

/** benchmarks.ts → MetricBenchmark: portfolio benchmark summary for one (period, metric). */
export const MetricBenchmarkSchema = z.object({
  period: z.string(),
  metric: NumericMetricKey,
  avg: z.number().nullable(),
  median: z.number().nullable(),
  p25: z.number().nullable(),
  p75: z.number().nullable(),
  n: z.number(),
  bases: z.array(z.string()),
  mixedBasis: z.boolean(),
});
export type MetricBenchmark = z.infer<typeof MetricBenchmarkSchema>;

/** benchmarks.ts → PropertyRank: a property's rank within a (period, metric) cohort. */
export const PropertyRankSchema = z.object({
  propertyId: z.string(),
  value: z.number(),
  rank: z.number(),
  quartile: Quartile,
});
export type PropertyRank = z.infer<typeof PropertyRankSchema>;

/** benchmarks.ts → PmScorecard: PM-level aggregate scorecard. */
export const PmScorecardSchema = z.object({
  propertyManager: z.string(),
  propertyCount: z.number(),
  smallSample: z.boolean(),
  avgNoiPerSf: z.number().nullable(),
  avgNoiGrowth: z.number().nullable(),
  avgExpenseGrowth: z.number().nullable(),
});
export type PmScorecard = z.infer<typeof PmScorecardSchema>;

// ── Route envelope schemas — the exact JSON each /analytics/* route emits. ──────────────────────
export const MetricsResponseSchema = z.object({ metrics: z.array(PeriodMetricsSchema) });
export type MetricsResponse = z.infer<typeof MetricsResponseSchema>;

export const GrowthResponseSchema = z.object({
  growth: z.array(GrowthPointSchema),
  sinceAcquisition: z.array(SinceAcquisitionSchema),
});
export type GrowthResponse = z.infer<typeof GrowthResponseSchema>;

/** /analytics/drivers/:propertyId → the engine decomposition wrapped with propertyId/from/to. */
export const DriversResponseSchema = NoiDecompositionSchema.extend({
  propertyId: z.string(),
  from: z.string(),
  to: z.string(),
});
export type DriversResponse = z.infer<typeof DriversResponseSchema>;

export const AnomaliesResponseSchema = z.object({ anomalies: z.array(AnomalyFlagSchema) });
export type AnomaliesResponse = z.infer<typeof AnomaliesResponseSchema>;

export const BenchmarksResponseSchema = z.object({
  byMetric: MetricBenchmarkSchema,
  rankings: z.array(PropertyRankSchema),
});
export type BenchmarksResponse = z.infer<typeof BenchmarksResponseSchema>;

export const ScoresResponseSchema = z.object({ scores: z.array(PropertyScoreSchema) });
export type ScoresResponse = z.infer<typeof ScoresResponseSchema>;

export const PmScorecardsResponseSchema = z.object({ scorecards: z.array(PmScorecardSchema) });
export type PmScorecardsResponse = z.infer<typeof PmScorecardsResponseSchema>;
