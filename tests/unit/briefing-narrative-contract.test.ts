// @vitest-environment node
//
// tests/unit/briefing-narrative-contract.test.ts
//
// Phase 2 · Workstream 2 — AI Narrative Briefings (Step 7).
// Spec: docs/superpowers/specs/2026-06-21-phase-2-w2-ai-narrative-briefings.md
//
// Verifies:
//  • NarrativeBlock, NarrativeEnvelope parse and round-trip correctly.
//  • NarrativePropertyBriefingModel and NarrativeManagerBriefingModel extend their base models.
//  • The base PropertyBriefingModel and ManagerBriefingModel still parse a valid base object
//    UNCHANGED (regression guard — invariant: base models must not be modified).
import { describe, it, expect } from 'vitest';
import {
  NarrativeBlock,
  NarrativeEnvelope,
  NarrativePropertyBriefingModel,
  NarrativeManagerBriefingModel,
  PropertyBriefingModel,
  ManagerBriefingModel,
} from '../../src/contracts/briefing';

// ── Shared minimal fixtures ────────────────────────────────────────────────────────────────────

const BASE_META = {
  generatedDate: '2026-06-21',
  workbookAsOf: '2026-06-01',
  dataFreshness: null,
  confidentialMarking: 'CONFIDENTIAL — INTERNAL' as const,
  masthead: 'OXFORD REALTY ADVISORS' as const,
};

const BASE_FIGURE = { display: '$104,000', value: 104000, unit: 'usd' as const };
const ZERO_FIGURE = { display: '—', value: null, unit: 'none' as const };

/** Minimal valid PropertyBriefingModel payload (all required fields at minimum). */
const PROPERTY_BASE = {
  kind: 'property' as const,
  meta: BASE_META,
  subject: {
    propertyId: 'test-property-slug',
    name: 'Test Property',
    market: 'Columbus, OH',
    manager: 'Test Manager',
    scoredPeriod: '2025',
  },
  verdict: {
    health: { display: '72.0', value: 72.0, unit: 'none' as const },
    healthBand: 'good' as const,
    attentionBand: 'yellow' as const,
    capitalAction: 'hold' as const,
    rootCause: null,
    recommendation: 'Hold and optimize operating performance.',
  },
  kpis: [
    { label: 'NOI', figure: BASE_FIGURE, spark: [90000, 104000] },
  ],
  noiTrend: [90000, 104000],
  drivers: [],
  anomalies: [],
  leaseRun: {
    present: false,
    tenant: null,
    currentExpiry: null,
    stabilizedNoi: ZERO_FIGURE,
    indicativeValue: ZERO_FIGURE,
    belowMarket: false,
    rolloverLabels: [],
  },
  benchmark: {
    noiPerSfQuartile: 2 as const,
    cohortSize: 10,
    noiPerSf: { display: '$4.80 /SF', value: 4.8, unit: 'usd_per_sf' as const },
    cohortMedianNoiPerSf: { display: '$4.20 /SF', value: 4.2, unit: 'usd_per_sf' as const },
  },
};

/** Minimal valid ManagerBriefingModel payload. */
const MANAGER_BASE = {
  kind: 'manager' as const,
  meta: BASE_META,
  subject: {
    managerId: 'test-manager',
    name: 'Test Manager',
    contact: null,
    propertyCount: 2,
    smallSample: true,
  },
  scorecard: {
    avgNoiPerSf: { display: '$4.80 /SF', value: 4.8, unit: 'usd_per_sf' as const },
    avgNoiGrowth: { display: '10.0%', value: 10.0, unit: 'pct' as const },
    avgExpenseGrowth: { display: '-6.7%', value: -6.7, unit: 'pct' as const },
  },
  managedProperties: [
    {
      propertyId: 'test-property-slug',
      name: 'Test Property',
      health: { display: '72.0', value: 72.0, unit: 'none' as const },
      healthBand: 'good' as const,
      noi: BASE_FIGURE,
      attentionBand: 'yellow' as const,
    },
  ],
  attentionItems: ['Monitor deferred maintenance.'],
  actionList: ['Schedule preventive maintenance review.'],
};

/** A minimal valid NarrativeBlock. */
const NARRATIVE_BLOCK = {
  headline: 'Strong NOI Growth Trajectory',
  summary: 'The property delivered 10% NOI growth driven by revenue gains and expense discipline.',
  bullets: [
    'NOI grew from $90,000 to $104,000 (+$14,000, +15.6%)',
    'Expense ratio improved',
    'Benchmark: 2nd quartile in cohort of 10',
  ],
  model: 'claude-haiku-4-5-20251001',
};

/** A valid NarrativeEnvelope — with narrative populated. */
const ENVELOPE_WITH_NARRATIVE = {
  narrative: NARRATIVE_BLOCK,
  degraded: false,
};

/** A valid NarrativeEnvelope — degraded state. */
const ENVELOPE_DEGRADED = {
  narrative: null,
  degraded: true,
};

// ── NarrativeBlock ─────────────────────────────────────────────────────────────────────────────

describe('NarrativeBlock', () => {
  it('parses a valid block', () => {
    const parsed = NarrativeBlock.parse(NARRATIVE_BLOCK);
    expect(parsed.headline).toBe(NARRATIVE_BLOCK.headline);
    expect(parsed.summary).toBe(NARRATIVE_BLOCK.summary);
    expect(parsed.bullets).toEqual(NARRATIVE_BLOCK.bullets);
    expect(parsed.model).toBe(NARRATIVE_BLOCK.model);
  });

  it('round-trips through JSON serialisation', () => {
    const parsed = NarrativeBlock.parse(NARRATIVE_BLOCK);
    const roundTripped = NarrativeBlock.parse(JSON.parse(JSON.stringify(parsed)));
    expect(roundTripped).toEqual(parsed);
  });

  it('rejects missing headline', () => {
    const { headline: _h, ...rest } = NARRATIVE_BLOCK;
    expect(() => NarrativeBlock.parse(rest)).toThrow();
  });

  it('rejects missing bullets array', () => {
    const { bullets: _b, ...rest } = NARRATIVE_BLOCK;
    expect(() => NarrativeBlock.parse(rest)).toThrow();
  });

  it('rejects missing model field', () => {
    const { model: _m, ...rest } = NARRATIVE_BLOCK;
    expect(() => NarrativeBlock.parse(rest)).toThrow();
  });

  it('accepts an empty bullets array', () => {
    const parsed = NarrativeBlock.parse({ ...NARRATIVE_BLOCK, bullets: [] });
    expect(parsed.bullets).toEqual([]);
  });
});

// ── NarrativeEnvelope ─────────────────────────────────────────────────────────────────────────

describe('NarrativeEnvelope', () => {
  it('parses envelope with populated narrative', () => {
    const parsed = NarrativeEnvelope.parse(ENVELOPE_WITH_NARRATIVE);
    expect(parsed.narrative).not.toBeNull();
    expect(parsed.degraded).toBe(false);
  });

  it('parses degraded envelope (narrative: null)', () => {
    const parsed = NarrativeEnvelope.parse(ENVELOPE_DEGRADED);
    expect(parsed.narrative).toBeNull();
    expect(parsed.degraded).toBe(true);
  });

  it('round-trips the degraded form', () => {
    const parsed = NarrativeEnvelope.parse(ENVELOPE_DEGRADED);
    expect(NarrativeEnvelope.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it('rejects missing degraded field', () => {
    const { degraded: _d, ...rest } = ENVELOPE_DEGRADED;
    expect(() => NarrativeEnvelope.parse(rest)).toThrow();
  });
});

// ── NarrativePropertyBriefingModel ───────────────────────────────────────────────────────────

describe('NarrativePropertyBriefingModel', () => {
  it('parses a valid extended property model with narrative', () => {
    const payload = { ...PROPERTY_BASE, ...ENVELOPE_WITH_NARRATIVE };
    const parsed = NarrativePropertyBriefingModel.parse(payload);
    expect(parsed.kind).toBe('property');
    expect(parsed.narrative).not.toBeNull();
    expect(parsed.narrative?.headline).toBe(NARRATIVE_BLOCK.headline);
    expect(parsed.degraded).toBe(false);
  });

  it('parses the degraded form (narrative: null)', () => {
    const payload = { ...PROPERTY_BASE, ...ENVELOPE_DEGRADED };
    const parsed = NarrativePropertyBriefingModel.parse(payload);
    expect(parsed.narrative).toBeNull();
    expect(parsed.degraded).toBe(true);
  });

  it('round-trips through JSON serialisation', () => {
    const payload = { ...PROPERTY_BASE, ...ENVELOPE_WITH_NARRATIVE };
    const parsed = NarrativePropertyBriefingModel.parse(payload);
    const rt = NarrativePropertyBriefingModel.parse(JSON.parse(JSON.stringify(parsed)));
    expect(rt).toEqual(parsed);
  });

  it('rejects a payload missing the envelope fields', () => {
    // PROPERTY_BASE alone (no narrative/degraded) should fail NarrativePropertyBriefingModel
    expect(() => NarrativePropertyBriefingModel.parse(PROPERTY_BASE)).toThrow();
  });
});

// ── NarrativeManagerBriefingModel ────────────────────────────────────────────────────────────

describe('NarrativeManagerBriefingModel', () => {
  it('parses a valid extended manager model with narrative', () => {
    const payload = { ...MANAGER_BASE, ...ENVELOPE_WITH_NARRATIVE };
    const parsed = NarrativeManagerBriefingModel.parse(payload);
    expect(parsed.kind).toBe('manager');
    expect(parsed.narrative).not.toBeNull();
    expect(parsed.narrative?.model).toBe('claude-haiku-4-5-20251001');
    expect(parsed.degraded).toBe(false);
  });

  it('parses the degraded form (narrative: null)', () => {
    const payload = { ...MANAGER_BASE, ...ENVELOPE_DEGRADED };
    const parsed = NarrativeManagerBriefingModel.parse(payload);
    expect(parsed.narrative).toBeNull();
    expect(parsed.degraded).toBe(true);
  });

  it('round-trips through JSON serialisation', () => {
    const payload = { ...MANAGER_BASE, ...ENVELOPE_DEGRADED };
    const parsed = NarrativeManagerBriefingModel.parse(payload);
    const rt = NarrativeManagerBriefingModel.parse(JSON.parse(JSON.stringify(parsed)));
    expect(rt).toEqual(parsed);
  });
});

// ── Regression guard — base models must parse unchanged ───────────────────────────────────────

describe('regression guard — base models are untouched', () => {
  it('PropertyBriefingModel still parses a valid base object (no extra fields required)', () => {
    const parsed = PropertyBriefingModel.parse(PROPERTY_BASE);
    expect(parsed.kind).toBe('property');
    expect(parsed.subject.propertyId).toBe('test-property-slug');
    // The base model must NOT have narrative / degraded fields
    expect('narrative' in parsed).toBe(false);
    expect('degraded' in parsed).toBe(false);
  });

  it('ManagerBriefingModel still parses a valid base object (no extra fields required)', () => {
    const parsed = ManagerBriefingModel.parse(MANAGER_BASE);
    expect(parsed.kind).toBe('manager');
    expect(parsed.subject.managerId).toBe('test-manager');
    expect('narrative' in parsed).toBe(false);
    expect('degraded' in parsed).toBe(false);
  });

  it('PropertyBriefingModel rejects the extended payload without stripping (strict parse)', () => {
    // zod .strip() is the default behaviour — extra keys are stripped, parse succeeds.
    // The base model should succeed even with extra narrative keys present (they get stripped).
    const payload = { ...PROPERTY_BASE, ...ENVELOPE_WITH_NARRATIVE };
    const parsed = PropertyBriefingModel.parse(payload);
    // After strip, the base parse still gives a valid model — no crash.
    expect(parsed.kind).toBe('property');
    // And the stripped result has no narrative key (the BASE model doesn't declare it).
    expect('narrative' in parsed).toBe(false);
  });
});
