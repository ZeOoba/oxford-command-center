/* eslint-disable react-refresh/only-export-components -- store helpers + context + Provider colocated by design */
import { createContext, useContext, useState, type ReactNode } from 'react';

export type ViewProfile = 'acquisitions' | 'principal';
const KEY = 'ora-view';
const PROFILES: ViewProfile[] = ['acquisitions', 'principal'];

export function loadProfile(): ViewProfile {
  try {
    const v = localStorage.getItem(KEY);
    if (v && (PROFILES as string[]).includes(v)) return v as ViewProfile;
  } catch { /* localStorage unavailable */ }
  return 'acquisitions';
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
