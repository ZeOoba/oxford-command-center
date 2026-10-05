// src/analytics/property-financials/thresholds.ts
//
// The eight evaluation tests of the Property Financials scorecard, as ONE config object. The reference
// artifact (tests/fixtures/property-financials/reference-artifact.html, "EVALUATE" block) hard-codes
// each boundary inside its status closure; here the boundaries are data so a single edit moves exactly
// the cells it governs (tests/unit/property-financials-golden.test.ts pins that).
//
// These are portfolio-spread starting points, NOT market benchmarks and NOT governors: nothing here
// touches DSCR / LTV / hurdle-rate constants (Hard Invariant 4), and nothing here feeds scoring.
//
// Pure TypeScript.

export const EVALUATION_TEST_IDS = [
  'noiMargin',
  'opexExTaxRatio',
  'recoveryRatio',
  'mgmtFeePct',
  'contraRevenue',
  'rentRunRateGrowth',
  'utilityGrowth',
  'repairsGrowth',
] as const;
export type EvaluationTestId = (typeof EVALUATION_TEST_IDS)[number];

/** g = green, a = amber, r = red, n = not meaningful (no value). */
export type RagStatus = 'g' | 'a' | 'r' | 'n';

export type ThresholdDirection = 'higher-is-better' | 'lower-is-better';

export interface EvaluationThreshold {
  readonly id: EvaluationTestId;
  readonly label: string;
  readonly definition: string;
  readonly thresholdsText: string;
  readonly direction: ThresholdDirection;
  /** Green when value >= green (higher-is-better) or <= green (lower-is-better). */
  readonly green: number;
  /** Amber when not green but value >= amber (higher) or <= amber (lower); red beyond. */
  readonly amber: number;
  /** Growth tests only: the prior-period base must exceed this or the test is n/m. */
  readonly minPriorBase?: number;
  /** How the value prints in a cell. */
  readonly format: 'level0' | 'level1' | 'signed1' | 'signed0';
}

export const THRESHOLDS: Readonly<Record<EvaluationTestId, EvaluationThreshold>> = {
  noiMargin: {
    id: 'noiMargin',
    label: 'NOI margin',
    definition: 'TTM NOI / revenue',
    thresholdsText: 'Green ≥ 65%, amber 50-65%, red < 50%',
    direction: 'higher-is-better',
    green: 0.65,
    amber: 0.5,
    format: 'level0',
  },
  opexExTaxRatio: {
    id: 'opexExTaxRatio',
    label: 'Opex excl. tax / revenue',
    definition: 'Recurring cost before real estate tax',
    thresholdsText: 'Green ≤ 20%, amber 20-30%, red > 30%',
    direction: 'lower-is-better',
    green: 0.2,
    amber: 0.3,
    format: 'level0',
  },
  recoveryRatio: {
    id: 'recoveryRatio',
    label: 'Recovery ratio',
    definition: 'Reimbursements / (tax + insurance + utilities + grounds + repairs)',
    thresholdsText: 'Green ≥ 85%, amber 50-85%, red < 50%',
    direction: 'higher-is-better',
    green: 0.85,
    amber: 0.5,
    format: 'level0',
  },
  mgmtFeePct: {
    id: 'mgmtFeePct',
    label: 'Management fee',
    definition: 'Fee / revenue',
    thresholdsText: 'Green ≤ 4.0%, amber 4.0-5.0%, red > 5.0%',
    direction: 'lower-is-better',
    green: 0.04,
    amber: 0.05,
    format: 'level1',
  },
  contraRevenue: {
    id: 'contraRevenue',
    label: 'Contra-revenue',
    definition: 'Vacancy, waivers and bad debt / base rent',
    thresholdsText: 'Green ≤ 1.5%, amber 1.5-3.5%, red > 3.5%',
    direction: 'lower-is-better',
    green: 0.015,
    amber: 0.035,
    format: 'level1',
  },
  rentRunRateGrowth: {
    id: 'rentRunRateGrowth',
    label: 'Rent run-rate growth',
    definition: 'Q3 2026 vs Q3 2025 base rent',
    thresholdsText: 'Green ≥ +3%, amber 0-3%, red < 0%',
    direction: 'higher-is-better',
    green: 0.03,
    amber: 0,
    format: 'signed1',
  },
  utilityGrowth: {
    id: 'utilityGrowth',
    label: 'Utility cost growth',
    definition: 'Jan-Sep 2026 vs 2025',
    thresholdsText: 'Green ≤ +5%, amber +5-15%, red > +15%',
    direction: 'lower-is-better',
    green: 0.05,
    amber: 0.15,
    minPriorBase: 1000,
    format: 'signed0',
  },
  repairsGrowth: {
    id: 'repairsGrowth',
    label: 'Repairs growth',
    definition: 'Jan-Sep 2026 vs 2025',
    thresholdsText: 'Green ≤ +10%, amber +10-30%, red > +30%',
    direction: 'lower-is-better',
    green: 0.1,
    amber: 0.3,
    minPriorBase: 1000,
    format: 'signed0',
  },
};

/** RAG status of one value under one test. null / NaN / ±Infinity = 'n'. */
export function ragStatus(
  testId: EvaluationTestId,
  value: number | null | undefined,
  thresholds: Readonly<Record<EvaluationTestId, EvaluationThreshold>> = THRESHOLDS,
): RagStatus {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'n';
  const t = thresholds[testId];
  if (t.direction === 'higher-is-better') {
    if (value >= t.green) return 'g';
    if (value >= t.amber) return 'a';
    return 'r';
  }
  if (value <= t.green) return 'g';
  if (value <= t.amber) return 'a';
  return 'r';
}

/** Status for every test from a value map (missing tests read as 'n'). */
export function ragMatrix(
  values: Readonly<Partial<Record<EvaluationTestId, number | null>>>,
  thresholds: Readonly<Record<EvaluationTestId, EvaluationThreshold>> = THRESHOLDS,
): Record<EvaluationTestId, RagStatus> {
  const out = {} as Record<EvaluationTestId, RagStatus>;
  for (const id of EVALUATION_TEST_IDS) out[id] = ragStatus(id, values[id] ?? null, thresholds);
  return out;
}
