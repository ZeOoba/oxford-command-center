import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import {
  loadProfile,
  saveProfile,
  readStoredProfile,
  profileForEmail,
  ViewProfileProvider,
  useViewProfile,
} from '../../src/brain/view-profile';

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

describe('readStoredProfile', () => {
  it('returns null when nothing is stored', () => {
    expect(readStoredProfile()).toBeNull();
  });
  it('returns the stored profile when present', () => {
    localStorage.setItem('ora-view', 'principal');
    expect(readStoredProfile()).toBe('principal');
  });
  it('returns null for a junk stored value', () => {
    localStorage.setItem('ora-view', 'nonsense');
    expect(readStoredProfile()).toBeNull();
  });
});

describe('profileForEmail', () => {
  it('maps ggoldberg to acquisitions', () => {
    expect(profileForEmail('ggoldberg@oxfordra.net')).toBe('acquisitions');
  });
  it('maps egoldberg to principal', () => {
    expect(profileForEmail('egoldberg@oxfordra.net')).toBe('principal');
  });
  it('is case- and whitespace-insensitive', () => {
    expect(profileForEmail('  EGoldberg@Oxfordra.NET ')).toBe('principal');
  });
  it('falls back to acquisitions for unknown, null, or undefined', () => {
    expect(profileForEmail('someone@else.com')).toBe('acquisitions');
    expect(profileForEmail(null)).toBe('acquisitions');
    expect(profileForEmail(undefined)).toBe('acquisitions');
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
