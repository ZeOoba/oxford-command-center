/* eslint-disable react-refresh/only-export-components -- store helpers + context + Provider colocated by design */
import { createContext, useContext, useState, type ReactNode } from 'react';

export type ViewProfile = 'acquisitions' | 'principal';
const KEY = 'ora-view';
const PROFILES: ViewProfile[] = ['acquisitions', 'principal'];

export function readStoredProfile(): ViewProfile | null {
  try {
    const v = localStorage.getItem(KEY);
    if (v && (PROFILES as string[]).includes(v)) return v as ViewProfile;
  } catch { /* localStorage unavailable */ }
  return null;
}

export function loadProfile(): ViewProfile {
  return readStoredProfile() ?? 'acquisitions';
}

const EMAIL_PROFILE: Record<string, ViewProfile> = {
  'ggoldberg@oxfordra.net': 'acquisitions',
  'egoldberg@oxfordra.net': 'principal',
};

export function profileForEmail(email: string | null | undefined): ViewProfile {
  const e = (email ?? '').trim().toLowerCase();
  return EMAIL_PROFILE[e] ?? 'acquisitions';
}

/**
 * Fetch the Access-authenticated identity from the whoami Pages Function and map
 * it to a profile. Returns null on any failure (404 on local dev, network error,
 * unparseable body) — meaning "no detection signal, keep the current profile".
 */
export async function fetchIdentityProfile(): Promise<ViewProfile | null> {
  try {
    const res = await fetch('/api/whoami');
    if (!res.ok) return null;
    const data = (await res.json()) as { email?: unknown };
    const email = typeof data.email === 'string' ? data.email : null;
    return profileForEmail(email);
  } catch {
    return null;
  }
}

export function saveProfile(p: ViewProfile): void {
  try { localStorage.setItem(KEY, p); } catch { /* ignore */ }
}

interface Ctx { profile: ViewProfile; setProfile: (p: ViewProfile) => void }
const ViewProfileContext = createContext<Ctx | null>(null);

export function ViewProfileProvider({ children }: { children: ReactNode }) {
  const [profile, setProfileState] = useState<ViewProfile>(() => loadProfile());
  const setProfile = (p: ViewProfile) => { setProfileState(p); saveProfile(p); };
  return <ViewProfileContext.Provider value={{ profile, setProfile }}>{children}</ViewProfileContext.Provider>;
}

export function useViewProfile(): Ctx {
  const c = useContext(ViewProfileContext);
  if (!c) throw new Error('useViewProfile must be used within ViewProfileProvider');
  return c;
}
