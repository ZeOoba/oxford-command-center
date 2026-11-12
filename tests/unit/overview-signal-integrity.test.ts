// Design review 2026-10-31, P1 (docs/design-review/2026-10-31-command-center-design-review.md):
// what reaches the 7 Overview rows, and what the header dollars add up to.
import { describe, expect, it } from 'vitest';
import { buildPriorityActionsTier } from '../../src/modules/overview/widgets';
import {
  buildSummary,
  isObservation,
  mergeInsightSources,
  mergedToTierItem,
  type MergedInsight,
} from '../../src/modules/insights/insights.logic';
import { groupByCause } from '../../src/lib/tier-group';
import { describeAlertCause } from '../../src/modules/alerts/cause-labels';
import { buildTiers } from '../../src/modules/insights/insights.logic';
import { causeAndDays } from '../../src/brain/alert-cause';
import type { Insight } from '../../src/analytics/types';
import type { InsightCandidate } from '../../src/contracts/insights';
import type { PortfolioSnapshot } from '../../src/contracts';

function m(over: Partial<MergedInsight> & Pick<MergedInsight, 'id'>): MergedInsight {
  return {
    spine: 'A',
    propertyId: null,
    title: over.id,
    detail: '',
    impactUsd: null,
    severity: 'critical',
    category: 'lease',
    advisoryOnly: true,
    ...over,
  };
}

// The live shape: cf-hurdle-drag emits `cf-hurdle-drag::<propertyId>`, family CF, spine A, warning.
const valuation = m({
  id: 'cf-hurdle-drag::fishel',
  category: 'CF',
  severity: 'warning',
  impactUsd: 61_840,
  title: 'Premium valuation: 7658 Fishel yields 6.10% vs 7.40% market median',
});
const holdover = m({ id: 'lease-lapsed-L9', severity: 'warning', impactUsd: 7_215, title: 'Lapsed — Tenant 9' });

describe('finding 1 — valuation observations are not actions', () => {
  it('recognises the hurdle-drag generator as an observation, and nothing else', () => {
    expect(isObservation(valuation)).toBe(true);
    expect(isObservation(holdover)).toBe(false);
    expect(isObservation(m({ id: 'debt-note-1', category: 'CF' }))).toBe(false);
  });

  it('keeps a valuation row out of Priority Actions, its held-back count and its header totals', () => {
    const tier = buildPriorityActionsTier([valuation, holdover], 7);
    expect(tier.items.map((i) => i.id)).toEqual(['lease-lapsed-L9']);
    expect(tier.heldBack).toEqual({ rows: 0, signals: 0 });
    expect(tier.totalsBySpine?.[0]?.totalUsd).toBe(7_215); // rent at risk only, no valuation spread
  });

  it('still ranks the holdover even when the valuation row carries more dollars', () => {
    const tier = buildPriorityActionsTier([valuation, holdover], 1);
    expect(tier.items[0]!.id).toBe('lease-lapsed-L9');
  });
});

describe('finding 2 — the Results summary counts actions, not observations', () => {
  it('excludes valuation rows from risk dollars and the action count, not from the board count', () => {
    const s = buildSummary([valuation, holdover]);
    expect(s.riskImpactBySpine[0]!.totalUsd).toBe(7_215);
    expect(s.actionCount).toBe(1);
    expect(s.count).toBe(2); // the Insights board still lists the valuation row
  });
});

describe('finding 3 — group labels and child numbering', () => {
  const expiring = (id: string, days: number, usd: number) =>
    mergedToTierItem(m({ id: `expiring-${id}`, severity: 'warning', impactUsd: usd, title: `Lease expiring — ${id}`, metric: `${days}d` }), 99);

  it('labels the expiring-soon band from the members it actually holds', () => {
    const members = [expiring('A', 120, 68_000), expiring('B', 92, 38_000), expiring('C', 151, 14_000)];
    expect(describeAlertCause('lease-expiring-soon', members).title).toBe('3 leases expiring in 92–151d');
  });

  it('falls back to the 180d window when a member has no day count', () => {
    const members = [expiring('A', 120, 1), mergedToTierItem(m({ id: 'expiring-X', severity: 'warning' }), 1)];
    expect(describeAlertCause('lease-expiring-soon', members).title).toBe('2 leases expiring within 180d');
  });

  it('numbers a group\'s children 1..n and orders lease children by days to act', () => {
    const items = [expiring('A', 120, 68_000), expiring('B', 92, 38_000), expiring('C', 151, 14_000)];
    const [group] = groupByCause(items, describeAlertCause);
    expect(group!.members!.map((c) => [c.id, c.rank])).toEqual([
      ['expiring-B', 1],
      ['expiring-A', 2],
      ['expiring-C', 3],
    ]);
  });

  it('keeps dollar order for children that carry no day count', () => {
    const lapsed = (n: number, usd: number) =>
      mergedToTierItem(m({ id: `ins-lapsed-P${n}`, category: 'insurance', spine: 'B', impactUsd: usd }), n);
    const [group] = groupByCause([lapsed(1, 30), lapsed(2, 20), lapsed(3, 10)], describeAlertCause);
    expect(group!.members!.map((c) => [c.id, c.rank])).toEqual([
      ['ins-lapsed-P1', 1],
      ['ins-lapsed-P2', 2],
      ['ins-lapsed-P3', 3],
    ]);
  });
});

describe('finding 4 — a lease ending within 7 days is never folded into a group', () => {
  const noSignal = (id: string, days: number, usd: number) =>
    m({ id: `lease-expiry-${id}`, impactUsd: usd, title: `Expiring, no renewal signal — ${id}`, metric: `${days}d` });

  it('gives a ≤7d expiry its own cause and carries the day count', () => {
    const row = mergedToTierItem(noSignal('T0', 0, 38_000), 1);
    expect(row.cause).toBe('lease-expiry-imminent');
    expect(row.daysToAct).toBe(0);
    expect(mergedToTierItem(noSignal('T8', 8, 1), 1).cause).toBe('lease-expiry-no-signal');
  });

  it('shows the day-0 lease as its own Priority Actions row while the 61d leases stay grouped', () => {
    const tier = buildPriorityActionsTier(
      [noSignal('T0', 0, 38_000), noSignal('A', 61, 58_000), noSignal('B', 61, 48_000), noSignal('C', 61, 13_000)],
      7,
    );
    expect(tier.items.map((i) => i.id)).toEqual(['group:critical:lease-expiry-no-signal', 'lease-expiry-T0']);
    expect(tier.items[0]!.members).toHaveLength(3);
  });

  it('carries the condition metric through the merge', () => {
    const insight: Insight = {
      id: 'lease-expiry-L1',
      severity: 'critical',
      category: 'lease',
      title: 'Expiring, no renewal signal — T',
      detail: '',
      metric: '0d',
      impactAnnualUsd: 1,
      spine: 'A',
      provenance: 'real',
    };
    const snapshot = { properties: [], leases: [] } as unknown as PortfolioSnapshot;
    const { merged } = mergeInsightSources([insight], [], snapshot);
    expect(merged[0]!.metric).toBe('0d');
  });
});

// Adversarial review 2026-10-31 (round 1) — fixes to the first cut.
describe('review fixes', () => {
  const snapshot = { properties: [], leases: [], loans: [] } as unknown as PortfolioSnapshot;
  const valuationCandidate = {
    id: 'cf-hurdle-drag::P1',
    family: 'CF',
    generatorId: 'cf-hurdle-drag',
    propertyId: 'P1',
    spine: 'A',
    attribution: { inputs: {} },
    confidence: 0.7,
    goal: 1,
    materialityUsd: 61_840,
    title: 'Premium valuation: P1',
    discovery: '',
    prov: { source: 'capital-allocation-report', confidence: 'derived', asOf: '2026-10-30' },
    advisoryOnly: true,
  } as unknown as InsightCandidate;
  const dscrBreach: Insight = {
    id: 'dscr-floor-P1',
    severity: 'critical',
    category: 'debt',
    title: 'DSCR below floor — P1',
    detail: '',
    entityType: 'property',
    entityId: 'P1',
    impactAnnualUsd: null,
    spine: 'A',
    provenance: 'real',
  };

  it('never lets an observation supersede a same-property debt breach (A1)', () => {
    const { merged, supersededCount } = mergeInsightSources([dscrBreach], [valuationCandidate], snapshot);
    expect(supersededCount).toBe(0);
    expect(merged.map((x) => x.id).sort()).toEqual(['cf-hurdle-drag::P1', 'dscr-floor-P1']);
    expect(buildPriorityActionsTier(merged, 7).items.map((i) => i.id)).toEqual(['dscr-floor-P1']);
  });

  it('keeps observation dollars out of the Insights board tier totals, matching the banner (A2b)', () => {
    const tiers = buildTiers([valuation, holdover]);
    const priority = tiers.find((t) => t.key === 'priority')!;
    expect(priority.items.map((i) => i.id)).toContain('cf-hurdle-drag::fishel'); // still listed
    expect(priority.totalsBySpine?.[0]?.totalUsd).toBe(7_215);
    expect(buildSummary([valuation, holdover]).riskImpactBySpine[0]!.totalUsd).toBe(7_215);
  });

  it('builds a group preview in the same order as its children (A3)', () => {
    const exp = (id: string, days: number, usd: number) =>
      mergedToTierItem(m({ id: `expiring-${id}`, severity: 'warning', impactUsd: usd, title: `Lease expiring — ${id}`, metric: `${days}d` }), 1);
    const [group] = groupByCause([exp('Far', 151, 90), exp('Near', 92, 10), exp('Mid', 120, 50)], describeAlertCause);
    expect(group!.detail).toBe('Near, Mid, Far');
  });

  it('derives cause and day count the same way for every board (A4: the Alerts board too)', () => {
    expect(causeAndDays({ id: 'lease-expiry-L1', metric: '0d' })).toEqual({ cause: 'lease-expiry-imminent', daysToAct: 0 });
    expect(causeAndDays({ id: 'lease-expiry-L1', metric: '8d' })).toEqual({ cause: 'lease-expiry-no-signal', daysToAct: 8 });
    expect(causeAndDays({ id: 'expiring-L2', metric: '92d' })).toEqual({ cause: 'lease-expiring-soon', daysToAct: 92 });
    expect(causeAndDays({ id: 'dscr-floor-P1', metric: '1.10x' })).toEqual({ cause: 'dscr-floor', daysToAct: null });
    expect(causeAndDays({ id: 'ins-lapsed-P1' })).toEqual({ cause: 'insurance-lapsed', daysToAct: null });
  });
});
