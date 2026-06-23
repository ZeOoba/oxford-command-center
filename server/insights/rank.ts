/**
 * server/insights/rank.ts
 *
 * Non-gameable ranking model for the Oxford Command Center Insight Engine
 * (Phase 2 UnitC).
 *
 * Ranking formula:
 *   rankScore = w_novelty × noveltyNorm
 *             + w_confidence × candidate.confidence
 *             + w_materiality × materialityNorm
 *
 * Where:
 *   - noveltyNorm    = min-max normalised novelty within the n-gate-passing set
 *                      (all equal or empty → 0.5)
 *   - materialityNorm= min-max normalised |materialityUsd| within the set;
 *                      TR-family with null materialityUsd → fixed 0.5;
 *                      zero max → all 0.5
 *   - confidence is already 0..1; used directly (no normalisation)
 *
 * Hard display filter (n-gate):
 *   Candidates with n < MIN_PAIRS are REMOVED from output (not damped).
 *   Only n >= MIN_PAIRS rows are ranked.
 *
 * Tie-break (deterministic):
 *   1. rankScore DESC
 *   2. |materialityUsd| DESC  (null treated as 0)
 *   3. generatorId ASC        (stable lexicographic)
 *
 * No database access. No warehouse imports.
 */

import type { InsightCandidate } from '@contracts/insights';
import { MIN_PAIRS } from './stats';

// ---------------------------------------------------------------------------
// Extended types
// ---------------------------------------------------------------------------

/** Extended input — generators produce this shape */
export interface RankInput extends InsightCandidate {
  /** Sample count backing this signal */
  n: number;
  /** 0..1 — surprise vs subject's trailing baseline / market deviation */
  novelty: number;
}

/** Output — ranked + display-filtered with score attached */
export interface RankedCandidate extends RankInput {
  rankScore: number;
  sufficientData: boolean;
}

// ---------------------------------------------------------------------------
// INSIGHT_CONFIG — tunable weights
// ---------------------------------------------------------------------------

/**
 * Proposed weights — tunable by Gabriel; NOT a financial governor.
 * Ratification of these values is a RED (human event).
 */
export const INSIGHT_CONFIG = {
  weights: {
    novelty: 0.5,
    confidence: 0.3,
    materiality: 0.2,
  },
  displayTopN: 20,
} as const;

// ---------------------------------------------------------------------------
// Internal normalisation helpers
// ---------------------------------------------------------------------------

/**
 * Min-max normalise an array of numbers.
 * Returns 0.5 for all elements when max === min (degenerate or empty set).
 */
function minMaxNorm(values: number[]): number[] {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return values.map(() => 0.5);
  return values.map((v) => (v - min) / (max - min));
}

// ---------------------------------------------------------------------------
// rankCandidates
// ---------------------------------------------------------------------------

/**
 * Apply the n-gate display filter, then rank surviving candidates.
 *
 * Returns only `sufficientData: true` candidates sorted by rankScore DESC.
 * If all inputs fail the n-gate, returns [].
 *
 * Output is capped to `INSIGHT_CONFIG.displayTopN` (currently 20) entries.
 */
export function rankCandidates(inputs: RankInput[]): RankedCandidate[] {
  // ── Step 1: n-gate (hard filter) ────────────────────────────────────────
  const passing = inputs.filter((c) => c.n >= MIN_PAIRS);
  if (passing.length === 0) return [];

  const { weights } = INSIGHT_CONFIG;

  // ── Step 2: Normalise novelty ────────────────────────────────────────────
  const noveltyValues = passing.map((c) => c.novelty);
  const noveltyNorms = minMaxNorm(noveltyValues);

  // ── Step 3: Normalise materiality ────────────────────────────────────────
  // TR-family with null materialityUsd → fixed 0.5 (excluded from normalization pool)
  // All others: normalise |materialityUsd|; null non-TR treated as 0 for consistency
  const absMateriality = passing.map((c): number | 'tr-null' => {
    if (c.materialityUsd === null && c.family === 'TR') return 'tr-null';
    return Math.abs(c.materialityUsd ?? 0);
  });

  // Build pool of non-TR-null values for normalisation
  const pool = absMateriality.filter((v): v is number => v !== 'tr-null');
  const poolNorms = minMaxNorm(pool);

  // Map poolNorms back, inserting 0.5 for TR-null slots
  let poolIdx = 0;
  const materialityNorms = absMateriality.map((v): number => {
    if (v === 'tr-null') return 0.5;
    return poolNorms[poolIdx++] ?? 0.5;
  });

  // ── Step 4: Compute rankScore ─────────────────────────────────────────────
  const ranked: RankedCandidate[] = passing.map((candidate, i) => {
    const rankScore =
      weights.novelty * (noveltyNorms[i] ?? 0.5) +
      weights.confidence * candidate.confidence +
      weights.materiality * (materialityNorms[i] ?? 0.5);

    return {
      ...candidate,
      rankScore,
      sufficientData: true,
    };
  });

  // ── Step 5: Sort (deterministic tie-break) ───────────────────────────────
  ranked.sort((a, b) => {
    // Primary: rankScore DESC
    if (b.rankScore !== a.rankScore) return b.rankScore - a.rankScore;
    // Secondary: |materialityUsd| DESC (null → 0)
    const aMat = Math.abs(a.materialityUsd ?? 0);
    const bMat = Math.abs(b.materialityUsd ?? 0);
    if (bMat !== aMat) return bMat - aMat;
    // Tertiary: generatorId ASC
    return a.generatorId < b.generatorId ? -1 : a.generatorId > b.generatorId ? 1 : 0;
  });

  // ── Step 6: Apply displayTopN cap ────────────────────────────────────────
  return ranked.slice(0, INSIGHT_CONFIG.displayTopN);
}
