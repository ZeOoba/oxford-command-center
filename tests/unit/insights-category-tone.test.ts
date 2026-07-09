import { describe, it, expect } from 'vitest';
import { categoryTone } from '../../src/modules/insights/insights.logic';

describe('categoryTone', () => {
  it('maps every real Insight category to a real BadgeTone', () => {
    const expected: Record<string, string> = {
      debt: 'red',
      deal: 'blue',
      concentration: 'amber',
      lease: 'green',
      occupancy: 'green',
      collections: 'amber',
      insurance: 'blue',
      cash: 'green',
      anomaly: 'red',
      data: 'neutral',
    };
    for (const [category, tone] of Object.entries(expected)) {
      expect(categoryTone(category as never)).toBe(tone);
    }
  });
});
