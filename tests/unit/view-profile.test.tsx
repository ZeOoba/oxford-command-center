import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { loadProfile, saveProfile, ViewProfileProvider, useViewProfile } from '../../src/brain/view-profile';

beforeEach(() => localStorage.clear());

describe('view-profile store', () => {
  it('defaults to acquisitions when nothing is stored', () => {
    expect(loadProfile()).toBe('acquisitions');
  });
  it('tolerates a junk stored value', () => {
    localStorage.setItem('ora-view', 'nonsense');
    expect(loadProfile()).toBe('acquisitions');
  });
  it('round-trips a saved profile', () => {
    saveProfile('principal');
    expect(loadProfile()).toBe('principal');
  });
});

describe('useViewProfile', () => {
  it('exposes the profile and persists changes', () => {
    const wrapper = ({ children }: { children: ReactNode }) => <ViewProfileProvider>{children}</ViewProfileProvider>;
    const { result } = renderHook(() => useViewProfile(), { wrapper });
    expect(result.current.profile).toBe('acquisitions');
    act(() => result.current.setProfile('principal'));
    expect(result.current.profile).toBe('principal');
    expect(localStorage.getItem('ora-view')).toBe('principal');
  });
});
