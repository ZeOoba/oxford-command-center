import { describe, it, expect } from 'vitest';
import { CapitalAllocationResponse, MarketIntelResponse } from '@contracts/capital';

describe('capital UI — contract shape', () => {
  it('CapitalAllocationResponse parses valid minimal response', () => {
    const raw = {
      asOf: '2026-06-21',
      advisoryOnly: true,
      hurdleRate: {
        hurdleRatePct: 0.08,
        ratification: 'proposed',
        ratifiedBy: null,
        ratifiedDate: null,
        capitalConfigVersion: 1,
      },
      portfolio: {
        asOf: '2026-06-21',
        hurdleRatePct: 0.08,
        advisoryOnly: true,
        verdicts: [],
        actionCounts: {},
        pipeline: [],
      },
    };
    expect(CapitalAllocationResponse.safeParse(raw).success).toBe(true);
  });

  it('CapitalAllocationResponse rejects invalid ratification', () => {
    const raw = {
      asOf: '2026-06-21',
      advisoryOnly: true,
      hurdleRate: { hurdleRatePct: 0.08, ratification: 'unknown', ratifiedBy: null, ratifiedDate: null, capitalConfigVersion: 1 },
      portfolio: { asOf: '2026-06-21', hurdleRatePct: 0.08, advisoryOnly: true, verdicts: [], actionCounts: {}, pipeline: [] },
    };
    expect(CapitalAllocationResponse.safeParse(raw).success).toBe(false);
  });

  it('MarketIntelResponse parses valid empty signals', () => {
    const raw = { asOf: '2026-06-21', signals: [] };
    expect(MarketIntelResponse.safeParse(raw).success).toBe(true);
  });

  it('actionColor/actionLabel round-trip — hooks module is importable', async () => {
    const { actionLabel, actionColor, riskBandTone } = await import('@/modules/capital/hooks');
    expect(actionLabel('buy')).toBe('Buy');
    expect(actionLabel('sell')).toBe('Sell');
    expect(typeof actionColor('hold')).toBe('string');
    expect(riskBandTone('high')).toBe('red');
    expect(riskBandTone('low')).toBe('green');
  });
});
