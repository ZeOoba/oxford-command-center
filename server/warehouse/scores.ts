// server/warehouse/scores.ts
// Deterministic per-property health + attention scores and capital-allocation
// recommendations. Consumes PeriodMetrics[]; computes growth, benchmarks, and anomalies
// INTERNALLY so the output is a pure function of (db snapshot, metrics) — re-running on
// the same inputs deep-equals the prior result. All weights/bands/cutoffs come from
// INTEL_CONFIG (proposed, tunable — NOT governors).
import type { WarehouseDb } from './db';
import { detectAnomalies } from './anomalies';
import type { AnomalyFlag } from './anomalies';
import { benchmarkMetric, rankProperties } from './benchmarks';
import { growthSeries } from './growth';
import { INTEL_CONFIG } from './intel-config';
import type { AttentionBand, CapitalAction, HealthBand } from './intel-config';
import { latestFullYearPeriod } from './metrics';
import type { PeriodMetrics } from './metrics';

export interface PropertyScore {
  propertyId: string;
  propertyName: string | null;
  period: string;            // scoring period = latest FULL-YEAR period (raw latest only if YTD-only)
  health: number;            // 0..100
  healthBand: HealthBand;
  attentionBand: AttentionBand;
  capitalAction: CapitalAction;
  subScores: Record<string, number>; // each 0..100, keyed by healthWeights key
  noiPerSfQuartile: 1 | 2 | 3 | 4 | null;
  reasons: string[];
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Growth → 0..100 sub-score: linear clamp over ±cap; null growth → 50 (neutral). */
function growthScore(pct: number | null): number {
  const cap = INTEL_CONFIG.growthScoreCapPct;
  if (pct === null) return 50;
  return clamp(((pct + cap) / (2 * cap)) * 100, 0, 100);
}

/** Fraction of the portfolio whose value is strictly LESS than `value` (0..1). */
function percentileRank(value: number, population: number[]): number {
  if (population.length === 0) return 0.5;
  let below = 0;
  for (const v of population) if (v < value) below += 1;
  return below / population.length;
}

/** Efficiency sub-score: lower cost ratio ⇒ higher score → 100*(1 − percentileRank). */
function efficiencyScore(value: number | null, population: number[]): number {
  if (value === null) return 50;
  return 100 * (1 - percentileRank(value, population));
}

const stddev = (values: number[]): number => {
  if (values.length < 2) return 0;
  const m = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - m) ** 2, 0) / values.length;
  return Math.sqrt(variance);
};

const pctStr = (n: number | null): string => (n === null ? 'n/a' : `${(n * 100).toFixed(1)}%`);

/** Non-null numeric population of a per-SF cost ratio for a period (for percentile rank). */
function population(metrics: PeriodMetrics[], period: string, pick: (m: PeriodMetrics) => number | null): number[] {
  const out: number[] = [];
  for (const m of metrics) {
    if (m.period !== period) continue;
    const v = pick(m);
    if (typeof v === 'number' && Number.isFinite(v)) out.push(v);
  }
  return out;
}

/** Score every property on its latest FULL-YEAR period (level/benchmark) + latest same-grain
 *  transition (growth/attention). Deterministic in (db, metrics). */
export function scoreProperties(db: WarehouseDb, metrics: PeriodMetrics[]): PropertyScore[] {
  // Canonical property names from property_master (authoritative over the ledger join).
  const nameRows = db.prepare(`SELECT id, name FROM property_master`).all() as Array<{ id: string; name: string }>;
  const nameById = new Map<string, string>();
  for (const r of nameRows) nameById.set(r.id, r.name);

  // Group by property, latest period each.
  const byProperty = new Map<string, PeriodMetrics[]>();
  for (const m of metrics) {
    const arr = byProperty.get(m.propertyId) ?? [];
    arr.push(m);
    byProperty.set(m.propertyId, arr);
  }

  const anomalies = detectAnomalies(metrics);
  const anomaliesByKey = new Map<string, AnomalyFlag[]>();
  for (const f of anomalies) {
    const k = `${f.propertyId}|${f.period}`;
    const arr = anomaliesByKey.get(k) ?? [];
    arr.push(f);
    anomaliesByKey.set(k, arr);
  }

  const { healthWeights, healthBands } = INTEL_CONFIG;

  const scores: PropertyScore[] = [];
  for (const [propertyId, series] of byProperty) {
    const sorted = [...series].sort((a, b) => a.period.localeCompare(b.period));
    // LEVEL + BENCHMARK + EFFICIENCY period (spec §9 residual): score these against the property's
    // latest FULL-YEAR period, NEVER a trailing YTD partial. A 5-month YTD $/SF must not be ranked
    // against full-year peers (or, worse, a singleton 2026 self-cohort → spurious quartile 1). Fall
    // back to the raw latest only when the property has no full-year period (YTD-only coverage).
    const fyPeriod = latestFullYearPeriod(sorted);
    const levelRow = fyPeriod !== null
      ? sorted.find((m) => m.period === fyPeriod)!
      : sorted[sorted.length - 1]!;
    const period = levelRow.period;

    // GROWTH transition (spec §9): growth/attention/anomalies must use the latest SAME-GRAIN
    // pair (normally 2024→2025), NEVER the year→YTD pair — a 5-month-vs-12-month comparison
    // manufactures a spurious ≈−50% decline. growthSeries already nulls cross-grain growths and
    // flags them `comparable:false`; pick the most recent comparable point as the growth verdict.
    const growth = growthSeries(sorted);
    const latestComparable = [...growth].reverse().find((g) => g.comparable) ?? null;
    const noiGrowth = latestComparable?.noiGrowth ?? null;
    const revenueGrowth = latestComparable?.revenueGrowth ?? null;
    const noiPerSfGrowth = latestComparable?.noiPerSfGrowth ?? null;
    // The two metric periods behind that comparable transition (for revenue-per-SF growth and
    // the anomaly lookup). `growthCur` is the later (same-grain) period of the pair.
    const growthCurIdx = latestComparable ? sorted.findIndex((m) => m.period === latestComparable.period) : -1;
    const growthCur = growthCurIdx >= 0 ? sorted[growthCurIdx]! : null;
    const growthPrev = growthCurIdx > 0 ? sorted[growthCurIdx - 1]! : null;
    // revenue-per-SF growth (not on GrowthPoint) — derive from the same-grain transition.
    const revenuePerSfGrowth =
      growthPrev && growthCur && growthPrev.revenuePerSf !== null && growthPrev.revenuePerSf > 0 && growthCur.revenuePerSf !== null
        ? (growthCur.revenuePerSf - growthPrev.revenuePerSf) / growthPrev.revenuePerSf
        : null;

    // Efficiency populations (portfolio, SAME full-year period) — lower ratio is better. Built at
    // `period` (the full-year period above) so the percentile cohort is same-grain same-period.
    const expensePop = population(metrics, period, (m) => m.expenseRatio);
    const taxPop = population(metrics, period, (m) => m.taxesPerSf);
    const insPop = population(metrics, period, (m) => m.insurancePerSf);
    const repairPop = population(metrics, period, (m) => m.repairsPerSf);

    // Margin stability over the property's own history.
    const margins = sorted.map((m) => m.noiMargin).filter((v): v is number => v !== null && Number.isFinite(v));
    const marginStability = 100 - clamp(stddev(margins) * 200, 0, 100); // scale 200: 0.50 stddev ⇒ 0

    // Benchmark position from NOI/SF quartile at the full-year `period` — ranks this property's
    // full-year value against the cohort of OTHER properties' values AT THE SAME period (spec §9).
    // rankProperties already excludes properties lacking that period and returns quartile:null for a
    // low-confidence singleton cohort (n<2) — both map to the neutral benchmarkPosition (50).
    const ranking = rankProperties(metrics, period, 'noiPerSf');
    const myRank = ranking.find((r) => r.propertyId === propertyId);
    const quartile = myRank ? myRank.quartile : null;
    const benchmarkPosition = quartile === null ? 50 : { 1: 100, 2: 75, 3: 50, 4: 25 }[quartile];

    const subScores: Record<string, number> = {
      revenueGrowth: growthScore(revenueGrowth),
      revenuePerSfGrowth: growthScore(revenuePerSfGrowth),
      noiGrowth: growthScore(noiGrowth),
      noiPerSfGrowth: growthScore(noiPerSfGrowth),
      expenseEfficiency: efficiencyScore(levelRow.expenseRatio, expensePop),
      taxEfficiency: efficiencyScore(levelRow.taxesPerSf, taxPop),
      insuranceEfficiency: efficiencyScore(levelRow.insurancePerSf, insPop),
      repairEfficiency: efficiencyScore(levelRow.repairsPerSf, repairPop),
      marginStability,
      benchmarkPosition,
    };

    let health = 0;
    for (const key of Object.keys(healthWeights) as Array<keyof typeof healthWeights>) {
      health += healthWeights[key] * (subScores[key] ?? 0);
    }
    health = clamp(health, 0, 100);

    const healthBand: HealthBand =
      health >= healthBands.excellent ? 'excellent'
      : health >= healthBands.good ? 'good'
      : health >= healthBands.watch ? 'watch'
      : 'concern';

    // Anomaly inputs use the latest SAME-GRAIN transition (cross-grain pairs emit none anyway),
    // so a trailing YTD partial doesn't blank out the real 2024→2025 anomaly signal.
    const anomalyPeriod = growthCur?.period ?? period;
    const flags = anomaliesByKey.get(`${propertyId}|${anomalyPeriod}`) ?? [];
    const critical = flags.filter((f) => f.severity === 'critical').length;
    const high = flags.filter((f) => f.severity === 'high').length;
    const moderate = flags.filter((f) => f.severity === 'moderate').length;

    // Attention cascade — first match wins.
    let attentionBand: AttentionBand;
    if ((noiGrowth !== null && noiGrowth <= -0.10) || critical >= 1 || high >= 2) {
      attentionBand = 'red';
    } else if ((noiGrowth !== null && noiGrowth <= -0.05) || high >= 1 || health < healthBands.watch) {
      attentionBand = 'orange';
    } else if ((noiGrowth !== null && noiGrowth < 0) || moderate >= 1 || health < healthBands.good) {
      attentionBand = 'yellow';
    } else {
      attentionBand = 'green';
    }

    // Capital action — first match wins.
    let capitalAction: CapitalAction;
    if (
      (healthBand === 'excellent' || healthBand === 'good') &&
      quartile !== null && quartile <= 2 &&
      (attentionBand === 'green' || attentionBand === 'yellow')
    ) {
      capitalAction = 'invest';
    } else if (
      healthBand === 'concern' && quartile === 4 &&
      (attentionBand === 'orange' || attentionBand === 'red')
    ) {
      capitalAction = 'disposition-candidate';
    } else if (
      attentionBand === 'orange' || attentionBand === 'red' ||
      healthBand === 'watch' || healthBand === 'concern'
    ) {
      capitalAction = 'monitor';
    } else {
      capitalAction = 'hold';
    }

    scores.push({
      propertyId,
      propertyName: nameById.get(propertyId) ?? levelRow.propertyName,
      period,
      health: Math.round(health * 10) / 10,
      healthBand,
      attentionBand,
      capitalAction,
      subScores,
      noiPerSfQuartile: quartile,
      reasons: buildReasons({
        healthBand, attentionBand, capitalAction, health,
        noiGrowth, quartile, flags, critical, high, moderate,
        latest: levelRow,
      }),
    });
  }

  // Deterministic order.
  return scores.sort((a, b) => a.propertyId.localeCompare(b.propertyId));
}

interface ReasonCtx {
  healthBand: HealthBand;
  attentionBand: AttentionBand;
  capitalAction: CapitalAction;
  health: number;
  noiGrowth: number | null;
  quartile: 1 | 2 | 3 | 4 | null;
  flags: AnomalyFlag[];
  critical: number;
  high: number;
  moderate: number;
  latest: PeriodMetrics;
}

/** Human-readable rationale strings, deterministic in the inputs. */
function buildReasons(ctx: ReasonCtx): string[] {
  const reasons: string[] = [];
  reasons.push(`Health ${Math.round(ctx.health * 10) / 10}/100 (${ctx.healthBand}).`);

  if (ctx.noiGrowth !== null) {
    const dir = ctx.noiGrowth >= 0 ? 'grew' : 'declined';
    reasons.push(`NOI ${dir} ${pctStr(ctx.noiGrowth)} period-over-period.`);
  } else {
    reasons.push('NOI growth unavailable (single period or non-positive base).');
  }

  if (ctx.quartile !== null) {
    const label = ctx.quartile === 1 ? 'top quartile' : ctx.quartile === 4 ? 'bottom quartile' : `quartile ${ctx.quartile}`;
    reasons.push(`NOI/SF ranks ${label} vs the portfolio.`);
  }

  if (ctx.critical > 0 || ctx.high > 0 || ctx.moderate > 0) {
    reasons.push(`Anomalies this period: ${ctx.critical} critical, ${ctx.high} high, ${ctx.moderate} moderate.`);
  } else if (ctx.flags.length === 0) {
    reasons.push('No anomalies flagged this period.');
  }

  reasons.push(`Attention band: ${ctx.attentionBand}.`);

  switch (ctx.capitalAction) {
    case 'invest':
      reasons.push('Capital recommendation: invest — healthy, top-half NOI/SF, low attention.');
      break;
    case 'disposition-candidate':
      reasons.push('Capital recommendation: disposition-candidate — concern band, bottom-quartile NOI/SF, elevated attention.');
      break;
    case 'monitor':
      reasons.push('Capital recommendation: monitor — elevated attention or sub-par health.');
      break;
    default:
      reasons.push('Capital recommendation: hold — stable, no action indicated.');
      break;
  }
  return reasons;
}

/** Portfolio-level benchmark snapshot for the latest common period (convenience export). */
export function benchmarkSnapshot(metrics: PeriodMetrics[], period: string): ReturnType<typeof benchmarkMetric>[] {
  const keys = ['noiPerSf', 'revenuePerSf', 'expenseRatio', 'noiMargin'] as const;
  return keys.map((k) => benchmarkMetric(metrics, period, k));
}

// ── Score-band distribution sanity ────────────────────────────────────────────────────────
// A healthy portfolio SCATTERS across the attention/health bands. When EVERY scored property
// collapses into a SINGLE band, that is not a portfolio signal — it is the fingerprint of a
// systemic scoring bug.
//   LESSON (PFI build, 2026-06-12): a cross-grain leak compared a partial-year YTD period
//   against a full prior year, so every property's growth read as a ≈−50% cliff and the whole
//   portfolio collapsed into one attention band (all red/concern). 414 green unit tests missed
//   it — each property passed in isolation; only the CROSS-property distribution exposed it. A
//   manual "live-backfill-then-diff" caught it. `warehouse:verify` now promotes that check into
//   the standing gate so this bug class cannot ship again.
// A >~90% share is the systemic-bug threshold, applied two ways: (a) a SINGLE band holding ≥90%
// (total collapse — any band, including a spurious all-green); and (b) the worst TWO bands
// combined holding ≥90% (a directional "distress smear" from a MILDER cross-grain leak that
// scatters across orange+red / watch+concern without fully collapsing into one band). A
// concentration in the BEST two bands is a healthy portfolio, not a bug, so the smear check is
// distress-directional only. Real backfill (2026-06-13) peaks at ~42% single-band / ~58%
// worst-two-bands — a comfortable margin below 0.90, so the gate has headroom on healthy data.
export const SINGLE_BAND_COLLAPSE_SHARE = 0.9;
// Below this many scored properties a single-band share is not yet meaningful (a 2-property
// portfolio can legitimately be all-green). Guard so the check fires only on a real roster.
export const MIN_PROPERTIES_FOR_COLLAPSE_CHECK = 5;

export interface BandDistribution {
  total: number;
  attentionHist: Record<AttentionBand, number>;
  healthHist: Record<HealthBand, number>;
  quartileHist: Record<string, number>; // keys '1'..'4' plus 'null' (null $/SF) — null-safe
  collapsed: boolean;
  reason: string | null;
}

/** Largest bucket's share of the total (0..1) and which bucket, deterministic in iteration order. */
function dominant(hist: Record<string, number>, total: number): { band: string; share: number } {
  let band = '';
  let max = 0;
  for (const [k, v] of Object.entries(hist)) {
    if (v > max) {
      max = v;
      band = k;
    }
  }
  return { band, share: total === 0 ? 0 : max / total };
}

/**
 * Tabulate attention/health/NOI-per-SF-quartile band histograms across scored properties and
 * flag a COLLAPSE — ≥ SINGLE_BAND_COLLAPSE_SHARE of properties in one attention OR one health
 * band (total collapse), OR in the worst TWO attention/health bands combined (a directional
 * distress smear). Only evaluated once the roster is large enough to be meaningful. Pure and
 * deterministic in its input; null-safe — a null noiPerSfQuartile is bucketed under 'null'.
 */
export function scoreBandDistribution(scores: PropertyScore[]): BandDistribution {
  const attentionHist: Record<AttentionBand, number> = { green: 0, yellow: 0, orange: 0, red: 0 };
  const healthHist: Record<HealthBand, number> = { excellent: 0, good: 0, watch: 0, concern: 0 };
  const quartileHist: Record<string, number> = { '1': 0, '2': 0, '3': 0, '4': 0, null: 0 };
  for (const s of scores) {
    attentionHist[s.attentionBand] += 1;
    healthHist[s.healthBand] += 1;
    const qk = s.noiPerSfQuartile === null ? 'null' : String(s.noiPerSfQuartile);
    quartileHist[qk] = (quartileHist[qk] ?? 0) + 1;
  }
  const total = scores.length;

  let collapsed = false;
  let reason: string | null = null;
  if (total >= MIN_PROPERTIES_FOR_COLLAPSE_CHECK) {
    const pct = Math.round(SINGLE_BAND_COLLAPSE_SHARE * 100);
    const a = dominant(attentionHist, total);
    const h = dominant(healthHist, total);
    // Worst-two-band ("distress smear") shares — directional. A milder cross-grain leak shifts the
    // whole portfolio distressward without fully collapsing into one band; a best-bands concentration
    // is healthy and deliberately NOT flagged.
    const attnSmear = (attentionHist.red + attentionHist.orange) / total;
    const healthSmear = (healthHist.concern + healthHist.watch) / total;
    if (a.share >= SINGLE_BAND_COLLAPSE_SHARE) {
      collapsed = true;
      reason = `attentionBand collapse: ${Math.round(a.share * 100)}% of ${total} scored properties in '${a.band}' (>= ${pct}%) — systemic scoring-bug signal (e.g. a cross-grain YTD-vs-full-year leak), not a portfolio signal`;
    } else if (h.share >= SINGLE_BAND_COLLAPSE_SHARE) {
      collapsed = true;
      reason = `healthBand collapse: ${Math.round(h.share * 100)}% of ${total} scored properties in '${h.band}' (>= ${pct}%) — systemic scoring-bug signal, not a portfolio signal`;
    } else if (attnSmear >= SINGLE_BAND_COLLAPSE_SHARE) {
      collapsed = true;
      reason = `attentionBand distress smear: ${Math.round(attnSmear * 100)}% of ${total} scored properties in the worst two bands (orange+red) (>= ${pct}%) — a milder cross-grain leak or a genuine portfolio-wide distress shift; investigate before overriding`;
    } else if (healthSmear >= SINGLE_BAND_COLLAPSE_SHARE) {
      collapsed = true;
      reason = `healthBand distress smear: ${Math.round(healthSmear * 100)}% of ${total} scored properties in the worst two bands (watch+concern) (>= ${pct}%) — a milder cross-grain leak or a genuine portfolio-wide distress shift; investigate before overriding`;
    }
  }
  return { total, attentionHist, healthHist, quartileHist, collapsed, reason };
}
