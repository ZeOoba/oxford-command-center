# Zero-Click Role Auto-Detection — Design

**Date:** 2026-06-04
**Status:** Approved (design)
**Repo:** `oxford-command-center` (GitHub `ZeOoba/oxford-command-center`)

## Problem

The role-based views feature lets a user switch between the `acquisitions` and
`principal` view profiles via a header toggle (`src/shell/ViewToggle.tsx`). The
choice is stored in `localStorage` under `ora-view`, defaulting to
`acquisitions`. A first-time user always lands on `acquisitions` regardless of
who they are, and must manually toggle to `principal`.

The deployed mirror sits behind Cloudflare Access with exactly two identities:

- `ggoldberg@oxfordra.net` → should default to `acquisitions`
- `egoldberg@oxfordra.net` → should default to `principal`

We can read the authenticated identity server-side from the
`Cf-Access-Authenticated-User-Email` request header. The goal is **zero-click**:
when the user has not yet made an explicit manual choice, auto-pick the right
profile from their Access identity.

## Goals

- When **no explicit choice** is stored, auto-select the profile from the
  authenticated Access email.
- A **manual toggle always wins** and persists (an explicit `localStorage` value
  is never overridden by auto-detection).
- **Graceful no-op** on the local dev server and anywhere the header is absent —
  fall back to the existing `acquisitions` default, never throw.
- Keep `npm run gate` green: typecheck (3 tsconfigs incl. `functions/`), eslint
  `--max-warnings 0`, vitest, reconcile.

## Non-Goals

- No persistence of the auto-detected value. Auto-detection sets in-memory state
  only; `localStorage` stays empty until the user clicks the toggle. (Decision
  confirmed: re-detect every session until an explicit choice is made; an Access
  email reassignment is then reflected automatically.)
- No new local server (`server/index.ts`) route. Locally `GET /api/whoami` 404s
  and the client treats that as a no-op.
- No blocking/async render gate — first paint uses the existing default profile.
- No change to the secret-handling or snapshot-reading paths. `whoami` exposes
  only the already-authenticated email; no confidential data, no secrets.

## Architecture

Approach **A — auto-detect effect inside `ViewProfileProvider`**. Chosen over
(B) a render-blocking async gate (adds flicker/loading for no benefit — the
default profile is a fine first paint) and (C) server-side HTML/cookie injection
(heavier, touches the bake/build path, harder to test).

### 1. Pages Function — `functions/api/whoami.ts`

A new Cloudflare Pages Function, sibling to `functions/api/ai.ts`.

- Exports `onRequestGet(context)`.
- Reads `context.request.headers.get('Cf-Access-Authenticated-User-Email')`.
- Returns `Response.json({ email })` where `email` is the header string, or
  `null` when the header is absent.
- Sets `Cache-Control: no-store` (identity must not be cached).
- Reads no secrets, no body, no snapshot. Types: a local `PagesContext` shape
  exposing only `request: Request` (mirroring the style of `ai.ts`; `Env` is not
  needed since no bindings are used).
- Covered by `functions/tsconfig.json` typecheck.

Local behavior: there is no Pages Function locally and the Hono server has no
`/api/whoami` route, so `GET /api/whoami` returns 404 → client no-ops.

### 2. `src/brain/view-profile.tsx` — pure additions

- `readStoredProfile(): ViewProfile | null` — returns the stored profile, or
  `null` when absent/junk. `loadProfile()` becomes
  `readStoredProfile() ?? 'acquisitions'` (behavior unchanged for existing
  callers and tests).
- `profileForEmail(email: string | null | undefined): ViewProfile` — pure map:
  - `ggoldberg@oxfordra.net` → `acquisitions`
  - `egoldberg@oxfordra.net` → `principal`
  - anything else, including `null`/`undefined` → `acquisitions` (fallback)
  - Comparison is case-insensitive and trims surrounding whitespace.
- `fetchIdentityProfile(): Promise<ViewProfile | null>` —
  `fetch('/api/whoami')`; on non-ok response, thrown error, or unparseable body
  returns `null`; otherwise parses `{ email }` and returns
  `profileForEmail(email)`. Returning `null` means "no detection signal — keep
  current profile" and is distinct from a detected `acquisitions`.

### 3. `ViewProfileProvider` — auto-detect effect

- State still initializes from `loadProfile()` (default `acquisitions`) — instant
  first paint, unchanged.
- A `useEffect(() => { ... }, [])` running once on mount:
  1. If `readStoredProfile() !== null`, return immediately — an explicit choice
     already wins.
  2. Otherwise call `fetchIdentityProfile()`. On resolve:
     - Bail if a `cancelled` flag is set (provider unmounted).
     - Bail if `readStoredProfile() !== null` now (race guard: the user toggled
       while the fetch was in flight — the explicit choice must win).
     - Bail if the result is `null` (no signal).
     - Otherwise `setProfileState(detected)` — **no `saveProfile`**.
  3. Cleanup sets `cancelled = true`.
- Manual `setProfile` is unchanged: sets state **and** persists via
  `saveProfile`.

## Data Flow

```
mount
  └─ state = loadProfile()            // default 'acquisitions', paints immediately
  └─ effect (once):
       readStoredProfile() != null ?  ── yes ──► done (explicit choice wins)
                  │ no
                  ▼
       fetch('/api/whoami') → { email }
                  │
                  ▼
       profileForEmail(email)
                  │
       still no explicit choice & not cancelled & non-null ?
                  │ yes
                  ▼
       setProfileState(detected)      // in-memory only, NOT persisted

toggle click → setProfile(p) → setState + saveProfile(p)   // persists, wins forever after
```

## Error Handling

Every failure path collapses to "keep the current profile," never throwing into
render:

- 404 (local dev / no Function) → `fetchIdentityProfile` returns `null` → no-op.
- Missing `Cf-Access-Authenticated-User-Email` header → `{ email: null }` →
  `profileForEmail(null)` → `acquisitions` (already the default; effectively a
  no-op).
- Network error / non-ok status / unparseable JSON → `null` → no-op.

## Testing (vitest)

- `profileForEmail`: both known emails; unknown email; `null`/`undefined`;
  whitespace and mixed-case variants of the known emails.
- `readStoredProfile`: value present → returns it; absent → `null`; junk → `null`.
- `loadProfile`: unchanged behavior (regression — existing tests stay green).
- `ViewProfileProvider` (mock `fetch`):
  - (a) stored value present → whoami result is **not** applied.
  - (b) nothing stored + whoami returns `egoldberg@oxfordra.net` → profile
    becomes `principal`, and `localStorage` `ora-view` stays empty.
  - (c) whoami fails (reject / non-ok) → profile stays `acquisitions`.
  - (d) manual toggle persists and is not overwritten by a late whoami resolve
    (race guard).

The Pages Function's only logic is reading one header; the testable mapping
(`profileForEmail`) lives on the client and is unit-tested there. The CF runtime
handler is not unit-tested.

## Gate Impact

- **typecheck:** new `functions/api/whoami.ts` covered by `functions/tsconfig.json`;
  client changes by the app tsconfig.
- **eslint (max-warnings 0):** no unused locals/params; effect deps correct.
- **vitest:** additions above.
- **reconcile:** untouched.

## Files

- **New:** `functions/api/whoami.ts`
- **Modify:** `src/brain/view-profile.tsx`
- **New/Modify tests:** `tests/unit/view-profile.test.tsx` (extend)

## Security / Confidentiality

- `whoami` returns only the email Cloudflare Access already authenticated — no
  secrets, no portfolio/snapshot data, no E. Fulton or confidential content.
- All credentials remain server-side, consistent with `functions/api/ai.ts`.
- Free tier: Cloudflare Access + Pages Functions — no cost to run.
