import { describe, it, expect } from 'vitest';
import { MarketIntelResponse } from '@contracts/capital';

describe('market UI — contract shape', () => {
  it('MarketIntelResponse parses valid signal with all fields', () => {
    const raw = {
      asOf: '2026-06-21',
      signals: [
        {
          cluster: 'Columbus OH',
          asOf: '2026-06-21',
          marketScore: 72.5,
          action: 'maintain',
          confidence01: 0.5,
          confidenceTier: 'estimated',
          advisoryOnly: true,
          oraPropertyCount: 5,
          sources: [
            { source: 'fred', metric: 'composite-fred', value: 4.2, confidence01: 1.0, asOf: '2026-06-21', stale: false },
          ],
          reasons: ['Market score 72.5/100'],
          dataQuality: [],
        },
      ],
    };
    expect(MarketIntelResponse.safeParse(raw).success).toBe(true);
  });

  it('hooks module exports useMarketIntel + display helpers', async () => {
    const { marketActionLabel, marketActionTone } = await import('@/modules/market/hooks');
    expect(marketActionLabel('enter')).toBe('Enter');
    expect(marketActionLabel('exit')).toBe('Exit');
    expect(marketActionTone('enter')).toBe('green');
    expect(marketActionTone('exit')).toBe('red');
    expect(marketActionTone('maintain')).toBe('neutral');
  });
});
