import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import {
  loadProfile,
  saveProfile,
  readStoredProfile,
  profileForEmail,
  fetchIdentityProfile,
  ViewProfileProvider,
  useViewProfile,
} from '../../src/brain/view-profile';

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe('fetchIdentityProfile', () => {
  it('returns the mapped profile from the whoami email', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ email: 'egoldberg@oxfordra.net' }),
    }));
    await expect(fetchIdentityProfile()).resolves.toBe('principal');
  });
  it('returns null when the response is not ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));
    await expect(fetchIdentityProfile()).resolves.toBeNull();
  });
  it('returns null when fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
    await expect(fetchIdentityProfile()).resolves.toBeNull();
  });
  it('maps a null email (absent header) to the acquisitions fallback', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ email: null }),
    }));
    await expect(fetchIdentityProfile()).resolves.toBe('acquisitions');
  });
});

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
