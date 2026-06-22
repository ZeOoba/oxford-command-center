import { describe, it, expect } from 'vitest';
import { clamp } from '../../server/warehouse/clamp';

describe('clamp utility', () => {
  it('should return the value when it is within bounds', () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });

  it('should return min when value is below range', () => {
    expect(clamp(-1, 0, 10)).toBe(0);
  });

  it('should return max when value is above range', () => {
    expect(clamp(15, 0, 10)).toBe(10);
  });

  it('should return min when value equals min (boundary)', () => {
    expect(clamp(0, 0, 10)).toBe(0);
  });

  it('should return max when value equals max (boundary)', () => {
    expect(clamp(10, 0, 10)).toBe(10);
  });
});
