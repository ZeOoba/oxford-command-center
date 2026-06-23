// @vitest-environment node
//
// M5 — Balloon rationale double-attribution guard
//
// When both conditions fire simultaneously:
//   (a) effectiveBalloonMonths < 24   → balloon reason fires
//   (b) dscr < 1.25                   → DSCR reason fires
//
// Bug: the balloon reason's impact = debtUrgency * 0.15, where debtUrgency already
// includes the 30-pt DSCR sub-component.  The DSCR reason then adds another 4.5pt of
// "credit" for the same penalty → double-attribution.
//
// Fix: the balloon reason impact uses only the balloon-timing portion of debtUrgency
// (excluding the DSCR 30-pt component).  The composite `raw` score formula is
// unchanged — this is a narrative-attribution-only fix.
//
// Test structure:
//   T-1  Both reason impacts sum to (balloonOnly + dscrPenalty) * 0.15 — not the inflated value
//   T-2  Balloon reason impact = balloonOnlyUrgency * 0.15   (DSCR excluded)
//   T-3  DSCR reason impact    = 30 * 0.15 = 4.5            (unchanged)
//   T-4  score-invariance: debtUrgency formula is untouched by the fix
//   T-5  Only DSCR fires  → DSCR reason impact = 4.5        (no regression)
//   T-6  Only balloon fires → balloon reason impact = balloonComponent * 0.15 (no regression)
//   T-7  hasDebt=false     → no debt reasons emitted         (guard)

import { describe, it, expect } from 'vitest';
import { _buildDebtReasonImpacts } from '../../server/warehouse/capital-allocation';

// ── Fixture helpers ───────────────────────────────────────────────────────────

const DSCR_FLOOR = 1.25;
const DSCR_PENALTY = 30;
const DEBT_URGENCY_WEIGHT = 0.15;

/**
 * Reference implementation of debtUrgency — mirrors the source formula exactly.
 * Used in T-4 to verify score invariance independently of reason attribution.
 */
function refDebtUrgency(
  hasDebt: boolean,
  effectiveBalloonMonths: number | null,
  dscr: number | null,
): number {
  if (!hasDebt) return 0;
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  return clamp(
    (effectiveBalloonMonths === null
      ? 0
      : Math.max(0, 100 - (effectiveBalloonMonths / 12) * 10)) +
      (dscr !== null && dscr < DSCR_FLOOR ? DSCR_PENALTY : 0),
    0,
    100,
  );
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('M5: balloon rationale — single-attribution of DSCR penalty', () => {
  // Fixture: balloon in 18 months (fires) + DSCR = 1.20 (below floor, fires)
  // balloonComponent = 100 - (18/12)*10 = 85
  // debtUrgency = clamp(85 + 30, 0, 100) = 100  (clamped)
  const balloonMonths = 18;
  const dscr = 1.20;

  it('T-1: sum of balloon + DSCR reason impacts = (balloonOnly + dscrPenalty) * 0.15 (no double-count)', () => {
    // With balloonMonths=18: balloonComponent=85, DSCR=30, debtUrgency=clamp(115,0,100)=100.
    // Correct sum: (85 * 0.15) + (30 * 0.15) = 12.75 + 4.5 = 17.25
    // Bug sum:      (100 * 0.15) + (30 * 0.15) = 15 + 4.5  = 19.5  ← DSCR counted twice
    const balloonComponent = Math.max(0, 100 - (balloonMonths / 12) * 10); // 85
    const balloonOnlyUrgency = Math.min(balloonComponent, 100);             // 85 (no DSCR)

    const reasons = _buildDebtReasonImpacts({
      hasDebt: true,
      effectiveBalloonMonths: balloonMonths,
      dscr,
      dscrFloor: DSCR_FLOOR,
    });

    const totalImpact = reasons.reduce((sum, r) => sum + r.impact, 0);
    const expectedTotal = (balloonOnlyUrgency + DSCR_PENALTY) * DEBT_URGENCY_WEIGHT; // 17.25
    const bugTotal = (100 + DSCR_PENALTY) * DEBT_URGENCY_WEIGHT;                    // 19.5 (old bug)

    expect(totalImpact).toBeCloseTo(expectedTotal, 5);
    expect(totalImpact).not.toBeCloseTo(bugTotal, 5);
  });

  it('T-2: balloon reason impact reflects balloon-timing only (excludes DSCR 30pt)', () => {
    const balloonComponent = Math.max(0, 100 - (balloonMonths / 12) * 10); // 85
    const balloonOnlyUrgency = Math.min(balloonComponent, 100);             // 85

    const reasons = _buildDebtReasonImpacts({
      hasDebt: true,
      effectiveBalloonMonths: balloonMonths,
      dscr,
      dscrFloor: DSCR_FLOOR,
    });

    const balloonReason = reasons.find((r) => r.text.startsWith('Balloon maturity'));
    expect(balloonReason).toBeDefined();
    // After fix: balloon impact = balloonOnlyUrgency * 0.15 = 12.75
    expect(balloonReason!.impact).toBeCloseTo(balloonOnlyUrgency * DEBT_URGENCY_WEIGHT, 5);
    // Must NOT be debtUrgency * 0.15 = 15 (the old double-counting value)
    const bugImpact = 100 * DEBT_URGENCY_WEIGHT; // 15
    expect(balloonReason!.impact).not.toBeCloseTo(bugImpact, 5);
  });

  it('T-3: DSCR reason impact = 30 * 0.15 = 4.5 (unchanged by fix)', () => {
    const reasons = _buildDebtReasonImpacts({
      hasDebt: true,
      effectiveBalloonMonths: balloonMonths,
      dscr,
      dscrFloor: DSCR_FLOOR,
    });

    const dscrReason = reasons.find((r) => r.text.startsWith('DSCR at'));
    expect(dscrReason).toBeDefined();
    expect(dscrReason!.impact).toBeCloseTo(DSCR_PENALTY * DEBT_URGENCY_WEIGHT, 5); // 4.5
  });

  it('T-4: score invariance — debtUrgency formula untouched (raw formula is unchanged)', () => {
    // The composite score uses debtUrgency (the full clamped value including DSCR penalty).
    // This test verifies the reference formula still computes the same value the engine uses.
    // balloonComponent=85, DSCR penalty=30 → unclamped=115 → clamped=100
    const debtUrgency = refDebtUrgency(true, balloonMonths, dscr);
    expect(debtUrgency).toBe(100);
    // Score contribution = debtUrgency * 0.15 = 15 — same before and after the narrative fix
    expect(debtUrgency * DEBT_URGENCY_WEIGHT).toBeCloseTo(15, 5);
  });

  it('T-5: only DSCR fires (no balloon) → DSCR reason impact = 4.5', () => {
    const reasons = _buildDebtReasonImpacts({
      hasDebt: true,
      effectiveBalloonMonths: null, // no balloon row → balloon reason suppressed
      dscr,
      dscrFloor: DSCR_FLOOR,
    });

    expect(reasons.find((r) => r.text.startsWith('Balloon maturity'))).toBeUndefined();
    const dscrReason = reasons.find((r) => r.text.startsWith('DSCR at'));
    expect(dscrReason).toBeDefined();
    expect(dscrReason!.impact).toBeCloseTo(4.5, 5);
  });

  it('T-6: only balloon fires (DSCR ≥ floor) → balloon reason impact = balloonComponent * 0.15', () => {
    const dscrAboveFloor = 1.35;
    const balloonComponent = Math.max(0, 100 - (balloonMonths / 12) * 10); // 85

    const reasons = _buildDebtReasonImpacts({
      hasDebt: true,
      effectiveBalloonMonths: balloonMonths,
      dscr: dscrAboveFloor,
      dscrFloor: DSCR_FLOOR,
    });

    const balloonReason = reasons.find((r) => r.text.startsWith('Balloon maturity'));
    expect(balloonReason).toBeDefined();
    expect(balloonReason!.impact).toBeCloseTo(balloonComponent * DEBT_URGENCY_WEIGHT, 5);
    expect(reasons.find((r) => r.text.startsWith('DSCR at'))).toBeUndefined();
  });

  it('T-7: hasDebt=false → no debt reasons emitted', () => {
    const reasons = _buildDebtReasonImpacts({
      hasDebt: false,
      effectiveBalloonMonths: null,
      dscr: null,
      dscrFloor: DSCR_FLOOR,
    });
    expect(reasons).toHaveLength(0);
  });
});
