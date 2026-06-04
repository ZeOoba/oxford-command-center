# Zero-Click Role Auto-Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When no explicit view-profile choice is stored, auto-pick the user's profile from their Cloudflare Access identity (`ggoldberg@oxfordra.net`→`acquisitions`, `egoldberg@oxfordra.net`→`principal`), while a manual toggle still always wins and persists.

**Architecture:** A new `functions/api/whoami.ts` Pages Function echoes the `Cf-Access-Authenticated-User-Email` header as JSON. `ViewProfileProvider` gains a once-on-mount effect that — only when nothing explicit is stored — fetches `/api/whoami`, maps the email to a profile, and sets it **in memory only** (never persists). All failure paths (404 local, missing header, network error) no-op to the existing `acquisitions` default.

**Tech Stack:** React 19, TypeScript, Vite, Vitest + @testing-library/react (jsdom), Cloudflare Pages Functions.

**Spec:** `docs/superpowers/specs/2026-06-04-zero-click-role-auto-detection-design.md`

---

### Task 1: Pure helpers — `profileForEmail`, `readStoredProfile`, refactor `loadProfile`

**Files:**
- Modify: `src/brain/view-profile.tsx`
- Test: `tests/unit/view-profile.test.tsx`

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/view-profile.test.tsx`. Update the top import line to include the new names:

```tsx
import {
  loadProfile,
  saveProfile,
  readStoredProfile,
  profileForEmail,
  ViewProfileProvider,
  useViewProfile,
} from '../../src/brain/view-profile';
```

Add these `describe` blocks (after the existing `view-profile store` block):

```tsx
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/view-profile.test.tsx`
Expected: FAIL — `readStoredProfile`/`profileForEmail` are not exported (import error / undefined).

- [ ] **Step 3: Implement the helpers**

In `src/brain/view-profile.tsx`, replace the existing `loadProfile` function (lines 8-14) with the following, and add `profileForEmail` + its lookup table. Keep `KEY`, `PROFILES`, `saveProfile` as they are.

```tsx
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/view-profile.test.tsx`
Expected: PASS — all helper tests plus the unchanged existing tests.

- [ ] **Step 5: Commit**

```bash
git add src/brain/view-profile.tsx tests/unit/view-profile.test.tsx
git commit -m "feat(views): readStoredProfile + profileForEmail helpers"
```

---

### Task 2: `fetchIdentityProfile`

**Files:**
- Modify: `src/brain/view-profile.tsx`
- Test: `tests/unit/view-profile.test.tsx`

- [ ] **Step 1: Write the failing tests**

Add `vi` and `afterEach` to the vitest import at the top of the test file:

```tsx
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
```

Add `fetchIdentityProfile` to the import-from-view-profile list (the block edited in Task 1).

Add this `describe` block and an `afterEach` that clears global stubs:

```tsx
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/view-profile.test.tsx -t fetchIdentityProfile`
Expected: FAIL — `fetchIdentityProfile` is not exported.

- [ ] **Step 3: Implement `fetchIdentityProfile`**

In `src/brain/view-profile.tsx`, add below `profileForEmail`:

```tsx
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/view-profile.test.tsx -t fetchIdentityProfile`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/brain/view-profile.tsx tests/unit/view-profile.test.tsx
git commit -m "feat(views): fetchIdentityProfile maps whoami email to profile"
```

---

### Task 3: Auto-detect effect in `ViewProfileProvider`

**Files:**
- Modify: `src/brain/view-profile.tsx`
- Test: `tests/unit/view-profile.test.tsx`

- [ ] **Step 1: Write the failing tests**

Add `waitFor` to the testing-library import:

```tsx
import { renderHook, act, waitFor } from '@testing-library/react';
```

Add this `describe` block:

```tsx
describe('ViewProfileProvider auto-detection', () => {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ViewProfileProvider>{children}</ViewProfileProvider>
  );

  it('auto-detects principal from whoami when nothing is stored (no persist)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ email: 'egoldberg@oxfordra.net' }),
    }));
    const { result } = renderHook(() => useViewProfile(), { wrapper });
    await waitFor(() => expect(result.current.profile).toBe('principal'));
    expect(localStorage.getItem('ora-view')).toBeNull();
  });

  it('does not auto-detect when an explicit choice is stored', async () => {
    localStorage.setItem('ora-view', 'acquisitions');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ email: 'egoldberg@oxfordra.net' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useViewProfile(), { wrapper });
    await waitFor(() => expect(fetchMock).not.toHaveBeenCalled());
    expect(result.current.profile).toBe('acquisitions');
  });

  it('stays on the acquisitions default when whoami fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
    const { result } = renderHook(() => useViewProfile(), { wrapper });
    await waitFor(() => expect(result.current.profile).toBe('acquisitions'));
  });

  it('lets a manual toggle win over a late whoami resolve', async () => {
    let resolveFetch!: (v: unknown) => void;
    const pending = new Promise((r) => { resolveFetch = r; });
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(pending));
    const { result } = renderHook(() => useViewProfile(), { wrapper });

    // User toggles before whoami resolves — this persists.
    act(() => result.current.setProfile('acquisitions'));
    expect(localStorage.getItem('ora-view')).toBe('acquisitions');

    // whoami now resolves with principal — the race guard must reject it.
    await act(async () => {
      resolveFetch({ ok: true, json: async () => ({ email: 'egoldberg@oxfordra.net' }) });
      await pending;
    });
    expect(result.current.profile).toBe('acquisitions');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/view-profile.test.tsx -t "auto-detection"`
Expected: FAIL — the provider has no effect, so `auto-detects principal` stays `acquisitions` and times out.

- [ ] **Step 3: Implement the effect**

In `src/brain/view-profile.tsx`, add `useEffect` to the React import:

```tsx
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
```

Replace the `ViewProfileProvider` body so it runs the auto-detect effect once on mount:

```tsx
export function ViewProfileProvider({ children }: { children: ReactNode }) {
  const [profile, setProfileState] = useState<ViewProfile>(() => loadProfile());
  const setProfile = (p: ViewProfile) => { setProfileState(p); saveProfile(p); };

  useEffect(() => {
    // An explicit stored choice always wins — never auto-detect over it.
    if (readStoredProfile() !== null) return;
    let cancelled = false;
    void fetchIdentityProfile().then((detected) => {
      if (cancelled) return;
      // Re-check: the user may have toggled while the fetch was in flight.
      if (readStoredProfile() !== null) return;
      if (detected === null) return;
      setProfileState(detected); // in-memory only — do NOT persist
    });
    return () => { cancelled = true; };
  }, []);

  return <ViewProfileContext.Provider value={{ profile, setProfile }}>{children}</ViewProfileContext.Provider>;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/view-profile.test.tsx`
Expected: PASS — all blocks (helpers, fetch, auto-detection, and the original store/hook tests).

- [ ] **Step 5: Commit**

```bash
git add src/brain/view-profile.tsx tests/unit/view-profile.test.tsx
git commit -m "feat(views): auto-detect profile from Access identity on first load"
```

---

### Task 4: `whoami` Pages Function

**Files:**
- Create: `functions/api/whoami.ts`

No unit test — the only logic is reading one header; it is covered by the `functions/tsconfig.json` typecheck. The mapping logic is tested client-side (`profileForEmail`).

- [ ] **Step 1: Create the function**

Create `functions/api/whoami.ts`:

```ts
/**
 * Cloudflare Pages Function — returns the Access-authenticated identity.
 *
 * Cloudflare Access injects `Cf-Access-Authenticated-User-Email` on every
 * authenticated request to the mirror. This echoes it as JSON so the client can
 * auto-pick a view profile on first load. No secrets, no request body, no
 * snapshot — only the already-authenticated email. When the header is absent
 * (local dev / direct hit) it returns `{ email: null }`. Inherits Cloudflare
 * Access on the same hostname.
 */
interface PagesContext {
  request: Request;
}

export function onRequestGet(context: PagesContext): Response {
  const email = context.request.headers.get('Cf-Access-Authenticated-User-Email');
  return new Response(JSON.stringify({ email: email ?? null }), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}
```

- [ ] **Step 2: Typecheck the functions project**

Run: `npx tsc --noEmit -p functions/tsconfig.json`
Expected: PASS — no errors.

- [ ] **Step 3: Commit**

```bash
git add functions/api/whoami.ts
git commit -m "feat(views): whoami Pages Function returns Access identity email"
```

---

### Task 5: Full gate

**Files:** none (verification only)

- [ ] **Step 1: Run the full gate**

Run: `npm run gate`
Expected: PASS — typecheck (3 tsconfigs incl. `functions/`), eslint `--max-warnings 0`, vitest (all suites incl. the new view-profile tests), reconcile.

- [ ] **Step 2: Fix any failures**

If typecheck/lint/test fails, fix inline and re-run `npm run gate` until green. Do not proceed until green.

- [ ] **Step 3: Final verification commit (if any fixes were made)**

```bash
git add -A
git commit -m "chore(views): gate fixes for role auto-detection"
```

If the gate was green with no fixes needed, skip this step.

---

## Notes for the implementer

- **Do not persist auto-detected values.** Only `setProfile` (the manual toggle) calls `saveProfile`. The effect calls `setProfileState` directly.
- The empty `useEffect` dependency array is intentional (run once on mount). If eslint's `react-hooks/exhaustive-deps` flags it, that is expected for a mount-only effect; the referenced functions are module-level and stable, so no deps are required.
- `loadProfile` keeps its original signature and default — existing callers (`ViewToggle`, `App`, prior tests) are unaffected.
