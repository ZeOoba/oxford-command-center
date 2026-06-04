import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useNow } from '../../src/lib/useNow';

afterEach(() => { vi.useRealTimers(); });

describe('useNow', () => {
  it('advances on the given interval', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useNow(1000));
    const first = result.current;
    act(() => { vi.advanceTimersByTime(1100); });
    expect(result.current).toBeGreaterThan(first);
  });
});
