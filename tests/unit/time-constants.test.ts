import { describe, it, expect } from 'vitest';
import { DAY_MS } from '../../server/warehouse/time-constants';

describe('time-constants', () => {
  it('DAY_MS should equal 86400000', () => {
    expect(DAY_MS).toBe(86400000);
  });

  it('DAY_MS should equal 24 * 60 * 60 * 1000 (derivation check)', () => {
    expect(DAY_MS).toBe(24 * 60 * 60 * 1000);
  });
});
