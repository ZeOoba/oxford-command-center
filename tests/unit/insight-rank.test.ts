/**
 * tests/unit/insight-rank.test.ts
 *
 * TDD tests for server/insights/rank.ts (Phase 2 UnitC).
 * Written RED-first — all tests fail until rank.ts is implemented.
 */

import { describe, it, expect } from 'vitest';
import type { RankInput } from '../../server/insights/rank';
import { rankCandidates, INSIGHT_CONFIG } from '../../server/insights/rank';
import { MIN_PAIRS } from '../../server/insights/stats';

// ---------------------------------------------------------------------------
// Test fixture factory
// ---------------------------------------------------------------------------

function makeCandidate(overrides: Partial<RankInput> = {}): RankInput {
  return {
    // InsightCandidate required fields
    id: 'gen::prop-a',
    family: 'CF' as const,
    generatorId: 'test-generator',
    propertyId: 'prop-a',
    spine: 'A' as const,
    attribution: { inputs: { test: true } },
    confidence: 0.7,
    goal: 1,
    materialityUsd: 100_000,
    title: 'Test Insight',
    discovery: 'A test signal was detected.',
    prov: { source: 'test', confidence: 'estimated' as const },
    advisoryOnly: true as const,
    // RankInput extensions
    n: MIN_PAIRS,
    novelty: 0.5,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. n-gate filter
// ---------------------------------------------------------------------------

describe('rankCandidates — n-gate filter', () => {
  it('removes candidate with n < MIN_PAIRS and keeps n >= MIN_PAIRS', () => {
    const below = makeCandidate({ id: 'gen::below', n: MIN_PAIRS - 1, novelty: 0.8 });
    const above = makeCandidate({ id: 'gen::above', n: MIN_PAIRS, novelty: 0.8 });

    const result = rankCandidates([below, above]);

    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('gen::above');
  });

  it('returns empty array when all inputs fail n-gate', () => {
    const a = makeCandidate({ id: 'gen::a', n: 0 });
    const b = makeCandidate({ id: 'gen::b', n: MIN_PAIRS - 1 });

    const result = rankCandidates([a, b]);
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 2. novelty beats materiality
// ---------------------------------------------------------------------------

describe('rankCandidates — novelty beats materiality', () => {
  it('ranks a high-novelty low-materiality candidate above a low-novelty high-materiality one', () => {
    // Candidate A: big property, boring signal
    const candidateA = makeCandidate({
      id: 'gen::a',
      generatorId: 'gen',
      propertyId: 'prop-a',
      materialityUsd: 1_000_000,
      novelty: 0.1,
      confidence: 0.7,
      n: 10,
    });

    // Candidate B: small property, surprising signal
    const candidateB = makeCandidate({
      id: 'gen::b',
      generatorId: 'gen',
      propertyId: 'prop-b',
      materialityUsd: 50_000,
      novelty: 0.9,
      confidence: 0.7,
      n: 10,
    });

    const result = rankCandidates([candidateA, candidateB]);

    expect(result).toHaveLength(2);
    // B (high novelty) must outrank A (high materiality)
    expect(result[0]!.id).toBe('gen::b');
    expect(result[1]!.id).toBe('gen::a');
  });
});

// ---------------------------------------------------------------------------
// 3. Deterministic output
// ---------------------------------------------------------------------------

describe('rankCandidates — determinism', () => {
  it('produces identical rankScore values and order regardless of input order', () => {
    const inputs: RankInput[] = [
      makeCandidate({ id: 'gen::x', n: 10, novelty: 0.3, materialityUsd: 200_000, confidence: 0.6 }),
      makeCandidate({ id: 'gen::y', n: 8, novelty: 0.7, materialityUsd: 50_000, confidence: 0.8 }),
      makeCandidate({ id: 'gen::z', n: 6, novelty: 0.5, materialityUsd: 150_000, confidence: 0.5 }),
    ];

    const forward = rankCandidates([...inputs]);
    const reversed = rankCandidates([...inputs].reverse());

    // Same ids in same positions
    expect(forward.map((c) => c.id)).toEqual(reversed.map((c) => c.id));
    // Same rankScores
    expect(forward.map((c) => c.rankScore)).toEqual(reversed.map((c) => c.rankScore));
  });
});

// ---------------------------------------------------------------------------
// 4. sufficientData:false candidates are absent from output
// ---------------------------------------------------------------------------

describe('rankCandidates — sufficientData filtering', () => {
  it('does NOT include n < MIN_PAIRS candidates in the returned array (not just ranked last)', () => {
    const insufficient = makeCandidate({ id: 'gen::insufficient', n: MIN_PAIRS - 1, novelty: 1.0 });
    const sufficient = makeCandidate({ id: 'gen::sufficient', n: MIN_PAIRS, novelty: 0.1 });

    const result = rankCandidates([insufficient, sufficient]);

    const returnedIds = result.map((c) => c.id);
    // Must be absent entirely
    expect(returnedIds).not.toContain('gen::insufficient');
    // Sufficient candidate present
    expect(returnedIds).toContain('gen::sufficient');
    // sufficientData flag is true on all returned
    result.forEach((c) => expect(c.sufficientData).toBe(true));
  });
});

// ---------------------------------------------------------------------------
// 5. TR-family null-materiality uses 0.5 fixed weight
// ---------------------------------------------------------------------------

describe('rankCandidates — TR-family null-materiality', () => {
  it('assigns materialityNorm of 0.5 to TR candidates with null materialityUsd', () => {
    const trNull = makeCandidate({
      id: 'gen::tr-null',
      family: 'TR' as const,
      materialityUsd: null,
      novelty: 0.5,
      confidence: 0.5,
      n: MIN_PAIRS,
    });
    const trExplicit = makeCandidate({
      id: 'gen::tr-explicit',
      family: 'TR' as const,
      materialityUsd: 500_000,
      novelty: 0.5,
      confidence: 0.5,
      n: MIN_PAIRS,
    });

    const result = rankCandidates([trNull, trExplicit]);
    expect(result).toHaveLength(2);

    // The null-materiality TR candidate should have rankScore computed with
    // materialityNorm=0.5 and not be penalised as zero.
    // trNull with materialityNorm=0.5 should beat trExplicit with materialityNorm=0.0
    // (since trExplicit has higher absolute USD but normalised to 1.0... actually max)
    // Correct: trExplicit materialityNorm=1.0, trNull materialityNorm=0.5.
    // Both have same novelty+confidence so trExplicit has higher rankScore.
    const trNullResult = result.find((c) => c.id === 'gen::tr-null');
    const trExplicitResult = result.find((c) => c.id === 'gen::tr-explicit');
    expect(trNullResult).toBeDefined();
    expect(trExplicitResult).toBeDefined();
    // TR null gets 0.5 (not 0.0), so we confirm it is NOT zero-scored vs a non-null peer
    // materialityNorm for null = 0.5, materialityNorm for 500K (max) = 1.0
    // rankScore(null)     = 0.5*noveltyNorm + 0.3*confidence + 0.2*0.5
    // rankScore(explicit) = 0.5*noveltyNorm + 0.3*confidence + 0.2*1.0
    // explicit wins, null is not worst-possible (0.0)
    expect(trNullResult!.rankScore).toBeGreaterThan(
      INSIGHT_CONFIG.weights.novelty * 0.5 + INSIGHT_CONFIG.weights.confidence * 0.5 + INSIGHT_CONFIG.weights.materiality * 0,
    );
  });
});

// ---------------------------------------------------------------------------
// 6. INSIGHT_CONFIG constants sanity
// ---------------------------------------------------------------------------

describe('INSIGHT_CONFIG', () => {
  it('weights sum to 1.0', () => {
    const { novelty, confidence, materiality } = INSIGHT_CONFIG.weights;
    expect(novelty + confidence + materiality).toBeCloseTo(1.0, 10);
  });

  it('displayTopN is positive integer', () => {
    expect(INSIGHT_CONFIG.displayTopN).toBeGreaterThan(0);
    expect(Number.isInteger(INSIGHT_CONFIG.displayTopN)).toBe(true);
  });
});
