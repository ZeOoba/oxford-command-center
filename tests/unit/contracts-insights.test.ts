// tests/unit/contracts-insights.test.ts
//
// TDD: write tests FIRST, run to RED, then implement src/contracts/insights.ts.
// Every test here exercises the published contract shape — no implementation code runs.
import { describe, expect, it } from 'vitest';
import {
  InsightCandidateSchema,
  InsightReportSchema,
} from '@contracts/insights';

// ── Shared minimal valid fixture ─────────────────────────────────────────────

const VALID_CANDIDATE = {
  id: 'cf-hurdle-drag::prop-westbelt-a',
  family: 'CF',
  generatorId: 'cf-hurdle-drag',
  propertyId: 'prop-westbelt-a',
  spine: 'A',
  attribution: { inputs: { noiPerSf: 4.27, hurdleRate: 0.08 } },
  confidence: 0.85,
  goal: 1,
  materialityUsd: 42000,
  title: 'NOI below hurdle threshold',
  discovery: 'Property NOI/SF ($4.27) trails the 8% hurdle-rate implied minimum by ~$0.60/SF.',
  prov: { source: 'Master Workbook › Property NOI!N20', confidence: 'confirmed' as const },
  advisoryOnly: true as const,
};

// ── 1. Parse valid candidate ─────────────────────────────────────────────────

describe('InsightCandidateSchema', () => {
  it('parses a minimal valid candidate', () => {
    const result = InsightCandidateSchema.parse(VALID_CANDIDATE);
    expect(result.id).toBe(VALID_CANDIDATE.id);
    expect(result.family).toBe('CF');
    expect(result.spine).toBe('A');
    expect(result.advisoryOnly).toBe(true);
  });

  // ── 2. Reject confidence > 1 ──────────────────────────────────────────────

  it('rejects confidence > 1', () => {
    expect(() =>
      InsightCandidateSchema.parse({ ...VALID_CANDIDATE, confidence: 1.1 }),
    ).toThrow();
  });

  // ── 3. Reject goal > 5 ───────────────────────────────────────────────────

  it('rejects goal > 5', () => {
    expect(() =>
      InsightCandidateSchema.parse({ ...VALID_CANDIDATE, goal: 6 }),
    ).toThrow();
  });

  // ── 4. Reject missing spine ───────────────────────────────────────────────

  it('rejects missing spine', () => {
    const { spine: _omit, ...noSpine } = VALID_CANDIDATE as Record<string, unknown>;
    expect(() => InsightCandidateSchema.parse(noSpine)).toThrow();
  });

  // ── 5. Reject cross-spine without attribution.method ────────────────────

  it('rejects cross-spine without attribution.method', () => {
    expect(() =>
      InsightCandidateSchema.parse({
        ...VALID_CANDIDATE,
        spine: 'cross',
        attribution: { inputs: {} }, // method absent
      }),
    ).toThrow();
  });

  // ── 6. Accept cross-spine with attribution.method ─────────────────────

  it('accepts cross-spine with attribution.method present', () => {
    const result = InsightCandidateSchema.parse({
      ...VALID_CANDIDATE,
      spine: 'cross',
      attribution: {
        inputs: { spineANoi: 180000, spineBNoi: 175000 },
        method: 'NOI basis-matched: both legs use Oxford-share oxfordNoi',
      },
    });
    expect(result.spine).toBe('cross');
    expect(result.attribution.method).toBe(
      'NOI basis-matched: both legs use Oxford-share oxfordNoi',
    );
  });
});

// ── 7. Round-trip InsightReport ──────────────────────────────────────────────

describe('InsightReportSchema', () => {
  it('round-trips a full InsightReport and checks key fields', () => {
    const report = InsightReportSchema.parse({
      candidates: [VALID_CANDIDATE],
      dataReadiness: [
        { generatorId: 'cf-hurdle-drag', status: 'live', sampleN: 27 },
        { generatorId: 'dr-regime-shift', status: 'dormant-low-n', sampleN: 3 },
      ],
      generatedAt: '2026-06-22T00:00:00Z',
      advisoryOnly: true,
    });

    expect(report.candidates.length).toBe(1);
    expect(report.dataReadiness[0]?.status).toBe('live');
    expect(report.advisoryOnly).toBe(true);
  });
});
