// tests/unit/insights-logic.test.ts
//
// Unit tests for src/modules/insights/insights.logic.ts. Pure functions only — no React,
// no network. Fixture style mirrors tests/unit/conditions.test.ts (self-contained snap()
// builder + typed row helpers), but avoids `as unknown as` by providing every
// PortfolioSnapshot field explicitly.
import { describe, it, expect } from 'vitest';
import type { PortfolioSnapshot, Lease, Loan } from '@contracts/index';
import type { Insight } from '@analytics/types';
import type { InsightCandidate } from '@contracts/insights';
import {
  mergeInsightSources,
  buildTiers,
  buildCategoryCounts,
  buildSummary,
  resolveInsightPropertyId,
  candidateSeverity,
  CATEGORY_TO_FAMILY,
  type MergedInsight,
} from '../../src/modules/insights/insights.logic';

// ── Fixture helpers ─────────────────────────────────────────────────────────────────────────

const ASOF = '2026-06-04';

function makeSnapshot(over: Partial<PortfolioSnapshot> = {}): PortfolioSnapshot {
  return {
    meta: { schemaVersion: '1.0.0', asOf: ASOF, generatedAt: '2026-06-04T00:00:00.000Z', source: 'test', scenario: 'Base' },
    assumptions: {
      activeScenario: 'Base',
      revenueFactor: 1,
      vacancyFactor: 1,
      exitCapFactor: 1,
      thresholds: { balloonAlertMonths: 18, concentrationYellow: 0.25, concentrationRed: 0.5 },
      asOf: ASOF,
    },
    properties: [],
    leases: [],
    loans: [],
    cash: { asOf: ASOF, totalCash: 0, activeEntities: 0, largestEntity: null, concentrationTopPct: null, cagr: null, entities: [], history: [] },
    insurance: [],
    deals: [],
    tasks: [],
    counterparties: [],
    renewalStages: {},
    tenantNotes: {},
    dealComps: {},
    acquisitionInputs: {},
    noiBudgets: {},
    tenantArrears: {},
    quickbooks: null,
    marketRents: {},
    dataQuality: [],
    ...over,
  };
}

function makeLoan(over: Partial<Loan> & Pick<Loan, 'id'>): Loan {
  return {
    name: 'Loan',
    counterparty: null,
    direction: 'borrower',
    originalPrincipal: null,
    currentBalance: -500_000,
    absBalance: 500_000,
    rate: null,
    monthlyPmt: null,
    annualInterest: null,
    annualPrincipal: null,
    loanType: null,
    status: null,
    isDemand: false,
    maturity: null,
    monthsToMaturity: null,
    ltv: null,
    lender: null,
    balloon: false,
    flags: [],
    collateralProperty: null,
    ...over,
  };
}

function makeLease(over: Partial<Lease> & Pick<Lease, 'id'>): Lease {
  return {
    propertyKey: 'Prop Key',
    propertyId: null,
    tenantName: 'Tenant',
    unit: null,
    company: null,
    sf: 1000,
    monthlyRent: 1000,
    rentPerSf: null,
    leaseStart: null,
    leaseEnd: null,
    escalationDate: null,
    escalationPct: null,
    status: 'Active',
    annualRent: 12_000,
    monthsToExpiry: null,
    flags: [],
    ...over,
  };
}

function makeInsight(over: Partial<Insight> & Pick<Insight, 'id' | 'category' | 'severity'>): Insight {
  return {
    title: 'Insight',
    detail: 'Detail',
    impactAnnualUsd: null,
    spine: 'A',
    provenance: 'derived',
    ...over,
  };
}

function makeCandidate(over: Partial<InsightCandidate> & Pick<InsightCandidate, 'id' | 'family' | 'propertyId'>): InsightCandidate {
  return {
    generatorId: 'test-gen',
    spine: 'A',
    attribution: { inputs: {} },
    confidence: 0.7,
    goal: 1,
    materialityUsd: null,
    title: 'Candidate',
    discovery: 'Candidate discovery narrative.',
    prov: { source: 'test', confidence: 'derived', asOf: ASOF },
    advisoryOnly: true,
    ...over,
  };
}

// ── resolveInsightPropertyId ──────────────────────────────────────────────────────────────────

describe('resolveInsightPropertyId', () => {
  it('entityType property: entityId IS the propertyId', () => {
    const snapshot = makeSnapshot();
    const insight = makeInsight({ id: 'i1', category: 'concentration', severity: 'info', entityType: 'property', entityId: 'prop-1' });
    expect(resolveInsightPropertyId(insight, snapshot)).toBe('prop-1');
  });

  it('entityType loan: resolves via loan.collateralProperty', () => {
    const snapshot = makeSnapshot({ loans: [makeLoan({ id: 'loan-1', collateralProperty: 'prop-9' })] });
    const insight = makeInsight({ id: 'i2', category: 'debt', severity: 'warning', entityType: 'loan', entityId: 'loan-1' });
    expect(resolveInsightPropertyId(insight, snapshot)).toBe('prop-9');
  });

  it('entityType loan with unmatched loan id resolves to null', () => {
    const snapshot = makeSnapshot({ loans: [makeLoan({ id: 'loan-1', collateralProperty: 'prop-9' })] });
    const insight = makeInsight({ id: 'i2b', category: 'debt', severity: 'warning', entityType: 'loan', entityId: 'no-such-loan' });
    expect(resolveInsightPropertyId(insight, snapshot)).toBeNull();
  });

  it('entityType lease: resolves via lease.propertyId', () => {
    const snapshot = makeSnapshot({ leases: [makeLease({ id: 'lease-1', propertyId: 'prop-5' })] });
    const insight = makeInsight({ id: 'i3', category: 'lease', severity: 'warning', entityType: 'lease', entityId: 'lease-1' });
    expect(resolveInsightPropertyId(insight, snapshot)).toBe('prop-5');
  });

  it('unmatched entityType (e.g. insurance) resolves to null', () => {
    const snapshot = makeSnapshot();
    const insight = makeInsight({ id: 'i4', category: 'insurance', severity: 'info', entityType: 'insurance', entityId: 'policy-1' });
    expect(resolveInsightPropertyId(insight, snapshot)).toBeNull();
  });

  it('no entityType at all (portfolio-wide insight) resolves to null', () => {
    const snapshot = makeSnapshot();
    const insight = makeInsight({ id: 'i5', category: 'concentration', severity: 'info' });
    expect(resolveInsightPropertyId(insight, snapshot)).toBeNull();
  });
});

// ── CATEGORY_TO_FAMILY ─────────────────────────────────────────────────────────────────────

describe('CATEGORY_TO_FAMILY', () => {
  it('covers every Insight category with a valid InsightFamily code', () => {
    const families = new Set(['CF', 'DR', 'TE', 'TR', 'CR']);
    for (const family of Object.values(CATEGORY_TO_FAMILY)) {
      expect(families.has(family)).toBe(true);
    }
  });
});

// ── candidateSeverity ──────────────────────────────────────────────────────────────────────

describe('candidateSeverity', () => {
  it('high confidence + quantified materiality -> critical', () => {
    const c = makeCandidate({ id: 'c1', family: 'CF', propertyId: 'p1', confidence: 0.9, materialityUsd: 50_000 });
    expect(candidateSeverity(c)).toBe('critical');
  });

  it('high confidence but null materiality -> not critical (falls to warning)', () => {
    const c = makeCandidate({ id: 'c2', family: 'CF', propertyId: 'p1', confidence: 0.9, materialityUsd: null });
    expect(candidateSeverity(c)).toBe('warning');
  });

  it('moderate confidence -> warning', () => {
    const c = makeCandidate({ id: 'c3', family: 'CF', propertyId: 'p1', confidence: 0.6, materialityUsd: 1000 });
    expect(candidateSeverity(c)).toBe('warning');
  });

  it('low confidence -> info', () => {
    const c = makeCandidate({ id: 'c4', family: 'CF', propertyId: 'p1', confidence: 0.2, materialityUsd: 1000 });
    expect(candidateSeverity(c)).toBe('info');
  });
});

// ── mergeInsightSources ────────────────────────────────────────────────────────────────────

describe('mergeInsightSources', () => {
  it('resolves entityType loan via collateralProperty and carries it through to the merged propertyId', () => {
    const snapshot = makeSnapshot({ loans: [makeLoan({ id: 'loan-1', collateralProperty: 'prop-9' })] });
    const insight = makeInsight({
      id: 'balloon-loan-1',
      category: 'debt',
      severity: 'warning',
      entityType: 'loan',
      entityId: 'loan-1',
      impactAnnualUsd: 10_000,
    });
    const { merged, supersededCount } = mergeInsightSources([insight], [], snapshot);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.propertyId).toBe('prop-9');
    expect(supersededCount).toBe(0);
  });

  it('dedup: candidate wins over a matching Spine-A insight, supersededCount increments', () => {
    const snapshot = makeSnapshot({ loans: [makeLoan({ id: 'loan-1', collateralProperty: 'prop-9' })] });
    const insight = makeInsight({
      id: 'balloon-loan-1',
      category: 'debt', // maps to family CF via CATEGORY_TO_FAMILY
      severity: 'warning',
      entityType: 'loan',
      entityId: 'loan-1',
      impactAnnualUsd: 10_000,
      title: 'Spine A balloon insight',
    });
    const candidate = makeCandidate({
      id: 'cf-hurdle-drag::prop-9',
      family: 'CF',
      propertyId: 'prop-9', // same propertyId + family -> same dedup key as the Spine-A insight
      materialityUsd: 25_000,
      title: 'Richer warehouse candidate',
    });

    const { merged, supersededCount } = mergeInsightSources([insight], [candidate], snapshot);

    expect(supersededCount).toBe(1);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.title).toBe('Richer warehouse candidate');
    expect(merged[0]?.id).toBe('cf-hurdle-drag::prop-9');
  });

  it('no dedup when property or family differs — both survive', () => {
    const snapshot = makeSnapshot({ loans: [makeLoan({ id: 'loan-1', collateralProperty: 'prop-9' })] });
    const insight = makeInsight({
      id: 'balloon-loan-1',
      category: 'debt',
      severity: 'warning',
      entityType: 'loan',
      entityId: 'loan-1',
      impactAnnualUsd: 10_000,
    });
    const candidateDifferentProperty = makeCandidate({
      id: 'cf-hurdle-drag::prop-other',
      family: 'CF',
      propertyId: 'prop-other',
      materialityUsd: 25_000,
    });

    const { merged, supersededCount } = mergeInsightSources([insight], [candidateDifferentProperty], snapshot);
    expect(supersededCount).toBe(0);
    expect(merged).toHaveLength(2);
  });

  it('unmatched entityType falls back to entityId for the dedup key (and propertyId is null)', () => {
    const snapshot = makeSnapshot();
    const insight = makeInsight({
      id: 'insurance-policy-1',
      category: 'insurance', // maps to family DR
      severity: 'info',
      entityType: 'insurance',
      entityId: 'policy-1',
      impactAnnualUsd: null,
    });
    // A candidate that happens to key on the SAME fallback id (policy-1) + family (DR) collides.
    const candidate = makeCandidate({
      id: 'insurance-renewal::policy-1',
      family: 'DR',
      propertyId: null,
    });
    // Manually verify the key construction indirectly: since candidate.propertyId is null, its
    // dedup key falls back to its own id ('insurance-renewal::policy-1'), which does NOT match
    // the Spine-A insight's fallback ('policy-1') — so no supersession here...
    const resultNoMatch = mergeInsightSources([insight], [candidate], snapshot);
    expect(resultNoMatch.supersededCount).toBe(0);
    expect(resultNoMatch.merged.find((m) => m.id === 'insurance-policy-1')?.propertyId).toBeNull();

    // ...but a candidate whose OWN id equals the Spine-A insight's entityId fallback DOES collide,
    // proving the fallback-to-entityId path is exercised (not just resolvedPropertyId).
    const collidingCandidate = makeCandidate({ id: 'policy-1', family: 'DR', propertyId: null });
    const resultMatch = mergeInsightSources([insight], [collidingCandidate], snapshot);
    expect(resultMatch.supersededCount).toBe(1);
    expect(resultMatch.merged).toHaveLength(1);
  });
});

// ── buildTiers ─────────────────────────────────────────────────────────────────────────────

function m(over: Partial<MergedInsight> & Pick<MergedInsight, 'id' | 'severity'>): MergedInsight {
  return {
    spine: 'A',
    propertyId: null,
    title: over.id,
    detail: '',
    impactUsd: null,
    category: 'debt',
    advisoryOnly: true,
    ...over,
  };
}

describe('buildTiers', () => {
  it('groups by severity into Critical/Priority/Monitor with the right tones', () => {
    const tiers = buildTiers([
      m({ id: 'c1', severity: 'critical' }),
      m({ id: 'w1', severity: 'warning' }),
      m({ id: 'i1', severity: 'info' }),
    ]);
    expect(tiers.map((t) => t.title)).toEqual(['Critical', 'Priority', 'Monitor']);
    expect(tiers.map((t) => t.tone)).toEqual(['neg', 'warn', 'info']);
    expect(tiers[0]?.items).toHaveLength(1);
    expect(tiers[1]?.items).toHaveLength(1);
    expect(tiers[2]?.items).toHaveLength(1);
  });

  it('ranks items within a tier by impactUsd desc, nulls last', () => {
    const tiers = buildTiers([
      m({ id: 'a', severity: 'critical', impactUsd: 1000 }),
      m({ id: 'b', severity: 'critical', impactUsd: null }),
      m({ id: 'c', severity: 'critical', impactUsd: 5000 }),
    ]);
    const critical = tiers[0];
    expect(critical?.items.map((i) => i.id)).toEqual(['c', 'a', 'b']);
    expect(critical?.items.map((i) => i.rank)).toEqual([1, 2, 3]);
  });

  it('impactKind is risk for critical/warning and info for info-only', () => {
    const tiers = buildTiers([
      m({ id: 'c1', severity: 'critical' }),
      m({ id: 'w1', severity: 'warning' }),
      m({ id: 'i1', severity: 'info' }),
    ]);
    expect(tiers[0]?.items[0]?.impactKind).toBe('risk');
    expect(tiers[1]?.items[0]?.impactKind).toBe('risk');
    expect(tiers[2]?.items[0]?.impactKind).toBe('info');
  });

  it('per-spine subtotals are NEVER combined into one number', () => {
    const tiers = buildTiers([
      m({ id: 'a', severity: 'critical', spine: 'A', impactUsd: 1000 }),
      m({ id: 'b', severity: 'critical', spine: 'B', impactUsd: 2000 }),
      m({ id: 'c', severity: 'critical', spine: 'cross', impactUsd: 500 }),
    ]);
    const totals = tiers[0]?.totalsBySpine ?? [];
    expect(totals).toEqual([
      { label: 'Spine A', totalUsd: 1000 },
      { label: 'Spine B/cross', totalUsd: 2500 }, // B + cross combined under one non-A label, never folded into Spine A
    ]);
  });

  it('an empty tier renders as a well-formed Tier with an empty items array', () => {
    const tiers = buildTiers([m({ id: 'a', severity: 'critical' })]);
    const priority = tiers.find((t) => t.title === 'Priority');
    expect(priority).toBeDefined();
    expect(priority?.items).toEqual([]);
    expect(priority?.totalsBySpine).toEqual([
      { label: 'Spine A', totalUsd: 0 },
      { label: 'Spine B/cross', totalUsd: 0 },
    ]);
  });

  it('category is carried through as the chip value', () => {
    const tiers = buildTiers([m({ id: 'a', severity: 'critical', category: 'CF' })]);
    expect(tiers[0]?.items[0]?.category).toBe('CF');
  });

  // ── categoryTone population (end-to-end: proves buildTiers() actually CALLS categoryTone()
  //    and sets it on the emitted TierItem — the isolated categoryTone() unit test in
  //    insights-category-tone.test.ts only proves the mapping, not that it reaches the render path)
  it('populates TierItem.categoryTone from a real Insight category (debt -> red)', () => {
    const tiers = buildTiers([m({ id: 'a', severity: 'critical', category: 'debt' })]);
    expect(tiers[0]?.items[0]?.categoryTone).toBe('red');
  });

  it('populates categoryTone for other real categories too (deal -> blue, concentration -> amber)', () => {
    const tiers = buildTiers([
      m({ id: 'd', severity: 'warning', category: 'deal' }),
      m({ id: 'c', severity: 'warning', category: 'concentration' }),
    ]);
    const priority = tiers.find((t) => t.title === 'Priority');
    const byId = Object.fromEntries((priority?.items ?? []).map((i) => [i.id, i.categoryTone]));
    expect(byId['d']).toBe('blue');
    expect(byId['c']).toBe('amber');
  });

  it('leaves categoryTone undefined for warehouse family-code categories (CF/DR/TE/TR/CR) — no crash, no wrong tone; TierBoard falls back to neutral', () => {
    for (const family of ['CF', 'DR', 'TE', 'TR', 'CR']) {
      const tiers = buildTiers([m({ id: `x-${family}`, severity: 'critical', category: family })]);
      const item = tiers[0]?.items[0];
      expect(item?.category).toBe(family); // family code still rendered as the badge label
      expect(item?.categoryTone).toBeUndefined(); // no tone -> TierBoard applies `?? 'neutral'`
    }
  });
});

// ── buildCategoryCounts ────────────────────────────────────────────────────────────────────

describe('buildCategoryCounts', () => {
  it('counts items per category, sorted alphabetically', () => {
    const counts = buildCategoryCounts([
      m({ id: 'a', severity: 'critical', category: 'lease' }),
      m({ id: 'b', severity: 'warning', category: 'debt' }),
      m({ id: 'c', severity: 'info', category: 'debt' }),
    ]);
    expect(counts).toEqual([
      { category: 'debt', count: 2 },
      { category: 'lease', count: 1 },
    ]);
  });

  it('empty input yields empty counts', () => {
    expect(buildCategoryCounts([])).toEqual([]);
  });
});

// ── buildSummary ───────────────────────────────────────────────────────────────────────────

describe('buildSummary', () => {
  it('splits risk (critical+warning) vs monitor (info) impact, per spine, and counts all items', () => {
    const summary = buildSummary([
      m({ id: 'a', severity: 'critical', spine: 'A', impactUsd: 1000 }),
      m({ id: 'b', severity: 'warning', spine: 'B', impactUsd: 2000 }),
      m({ id: 'c', severity: 'info', spine: 'A', impactUsd: 300 }),
    ]);
    expect(summary.riskImpactBySpine).toEqual([
      { label: 'Spine A', totalUsd: 1000 },
      { label: 'Spine B/cross', totalUsd: 2000 },
    ]);
    expect(summary.monitorImpactBySpine).toEqual([
      { label: 'Spine A', totalUsd: 300 },
      { label: 'Spine B/cross', totalUsd: 0 },
    ]);
    expect(summary.count).toBe(3);
  });
});
