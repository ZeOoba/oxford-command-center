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
// The threshold sentence ("Green ≥ 65%, amber 50-65%, red < 50%") and the growth tests' prior-base
// guard text are GENERATED from the same numbers (thresholdText / thresholdDefinition), so editing a
// boundary moves the status and its description together.
//
// Pure TypeScript.
import { pct, pctLevel } from './format';

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
  /** What the test measures. The threshold sentence is generated (thresholdText), never stored. */
  readonly definition: string;
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
    direction: 'higher-is-better',
    green: 0.65,
    amber: 0.5,
    format: 'level0',
  },
  opexExTaxRatio: {
    id: 'opexExTaxRatio',
    label: 'Opex excl. tax / revenue',
    definition: 'Recurring cost before real estate tax',
    direction: 'lower-is-better',
    green: 0.2,
    amber: 0.3,
    format: 'level0',
  },
  recoveryRatio: {
    id: 'recoveryRatio',
    label: 'Recovery ratio',
    definition: 'Reimbursements / (tax + insurance + utilities + grounds + repairs)',
    direction: 'higher-is-better',
    green: 0.85,
    amber: 0.5,
    format: 'level0',
  },
  mgmtFeePct: {
    id: 'mgmtFeePct',
    label: 'Management fee',
    definition: 'Fee / revenue',
    direction: 'lower-is-better',
    green: 0.04,
    amber: 0.05,
    format: 'level1',
  },
  contraRevenue: {
    id: 'contraRevenue',
    label: 'Contra-revenue',
    definition: 'Vacancy, waivers and bad debt / base rent',
    direction: 'lower-is-better',
    green: 0.015,
    amber: 0.035,
    format: 'level1',
  },
  rentRunRateGrowth: {
    id: 'rentRunRateGrowth',
    label: 'Rent run-rate growth',
    definition: 'Q3 2026 vs Q3 2025 base rent',
    direction: 'higher-is-better',
    green: 0.03,
    amber: 0,
    format: 'signed1',
  },
  utilityGrowth: {
    id: 'utilityGrowth',
    label: 'Utility cost growth',
    definition: 'Jan-Sep 2026 vs 2025',
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
    direction: 'lower-is-better',
    green: 0.1,
    amber: 0.3,
    minPriorBase: 1000,
    format: 'signed0',
  },
};

/** Status of a finite value under one threshold (the single place the boundaries are applied). */
function statusUnder(t: EvaluationThreshold, value: number): Exclude<RagStatus, 'n'> {
  if (t.direction === 'higher-is-better') {
    if (value >= t.green) return 'g';
    if (value >= t.amber) return 'a';
    return 'r';
  }
  if (value <= t.green) return 'g';
  if (value <= t.amber) return 'a';
  return 'r';
}

/** RAG status of one value under one test. null / NaN / ±Infinity = 'n'. */
export function ragStatus(
  testId: EvaluationTestId,
  value: number | null | undefined,
  thresholds: Readonly<Record<EvaluationTestId, EvaluationThreshold>> = THRESHOLDS,
): RagStatus {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'n';
  return statusUnder(thresholds[testId], value);
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

// -------------------------------------------------------------------------------------------------
// Generated text + cell formatting (the definitions table is built from these, never hand-written)
// -------------------------------------------------------------------------------------------------

const signedFormat = (t: EvaluationThreshold): boolean => t.format === 'signed0' || t.format === 'signed1';
const textDigits = (t: EvaluationThreshold): number => (t.format === 'level1' ? 1 : 0);

/** Digits needed to print a boundary without misstating it (at least the format's own). */
function boundDigits(t: EvaluationThreshold, v: number): number {
  let d = textDigits(t);
  while (d < 4 && Math.abs(Number((v * 100).toFixed(d)) - v * 100) > 1e-9) d++;
  return d;
}

function num(t: EvaluationThreshold, v: number, signed: boolean): string {
  const d = boundDigits(t, v);
  const s = (v * 100).toFixed(d);
  const clean = Number(s) === 0 ? (0).toFixed(d) : s;
  return signed && v > 0 ? `+${clean}` : clean;
}

/** "Green ≥ 65%, amber 50-65%, red < 50%" — generated from direction / green / amber / format. */
export function thresholdText(t: EvaluationThreshold): string {
  const signed = signedFormat(t);
  const higher = t.direction === 'higher-is-better';
  const [lo, hi] = higher ? [t.amber, t.green] : [t.green, t.amber];
  const sep = lo < 0 ? ' to ' : '-';
  const range = `${num(t, lo, signed)}${sep}${num(t, hi, false)}%`;
  const g = `${num(t, t.green, signed)}%`;
  const r = `${num(t, t.amber, signed)}%`;
  return higher ? `Green ≥ ${g}, amber ${range}, red < ${r}` : `Green ≤ ${g}, amber ${range}, red > ${r}`;
}

/** The definition, plus the prior-base guard for growth tests (generated from minPriorBase). */
export function thresholdDefinition(t: EvaluationThreshold): string {
  if (t.minPriorBase === undefined) return t.definition;
  const floor = `$${Math.round(t.minPriorBase).toLocaleString('en-US')}`;
  return `${t.definition}; n/m when either period is partial or the prior-period base is ${floor} or less`;
}

const FORMAT_DIGITS: Readonly<Record<EvaluationThreshold['format'], number>> = { level0: 0, level1: 1, signed0: 0, signed1: 1 };

/**
 * A cell value printed by the test's format: 66% / 4.5% / +5.9% / -12%. When rounding would print
 * the value onto a boundary it sits on the other side of (a red 5.0114% fee shown as "5.0%" next to
 * "red > 5.0%"), digits are added until the printed figure carries the same status as the value.
 */
export function formatThresholdValue(t: EvaluationThreshold, v: number): string {
  const signed = signedFormat(t);
  const base = FORMAT_DIGITS[t.format];
  const truth = statusUnder(t, v);
  for (let d = base; d < base + 4; d++) {
    const shown = Number((v * 100).toFixed(d)) / 100;
    if (statusUnder(t, shown) === truth) return signed ? pct(v, d) : pctLevel(v, d);
  }
  return signed ? pct(v, base + 4) : pctLevel(v, base + 4);
}

export const RAG_LABEL: Readonly<Record<RagStatus, string>> = { g: 'Green', a: 'Amber', r: 'Red', n: 'Not meaningful' };
