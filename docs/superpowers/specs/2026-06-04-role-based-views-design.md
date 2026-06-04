# Oxford Command Center — Role-Based Views (Design)

**Date:** 2026-06-04
**Status:** Approved (design) — pending implementation plan
**Owner:** Gabriel Goldberg (ORA)

## Goal

Give the two principals a role-appropriate dashboard from the same data: Gabriel's **acquisitions
cockpit** (pipeline-first) and Eric's **principal/oversight** view (portfolio health, capital,
decisions) — switchable per device, with Eric's home usable on a phone.

## Decisions (locked)

| Decision | Choice |
|---|---|
| Mechanism | **Manual view switcher**, remembered per device (`localStorage`), default `acquisitions`. No auth/identity. |
| What the view changes | **Default landing module + rail ordering per role**, plus a **tailored Principal landing**. |
| Module visibility | **No hiding** — reordering de-emphasizes; all 12 modules remain reachable. |
| Mobile | **Principal landing only** is made responsive; full-app mobile pass is a separate track. |
| Acquisitions home | Reuses existing modules — lands on `pipeline`, Command group first. The one *new* surface is the Principal home. |
| Access auto-detect | Deferred (can layer `Cf-Access-Authenticated-User-Email` later). |

## Components

### 1. `src/brain/view-profile.tsx` — the profile flag
- `export type ViewProfile = 'acquisitions' | 'principal'`.
- Pure helpers (no React): `loadProfile(): ViewProfile` (reads `localStorage['ora-view']`, default
  `'acquisitions'`, tolerates bad values) and `saveProfile(p: ViewProfile): void`.
- A React context + `useViewProfile(): { profile, setProfile }`; `setProfile` updates state and
  persists. Provider seeds from `loadProfile()`.

### 2. `src/shell/ViewToggle.tsx` — header control
A small segmented toggle in `TopBar` ("Acquisitions ⇄ Principal") bound to `useViewProfile()`.
Switching re-renders instantly (no reload).

### 3. `src/shell/module-order.ts` — config (pure)
- `MODULE_ORDER: Record<ViewProfile, string[]>` — ordered module ids per profile.
  - `acquisitions`: `overview, pipeline, tasks, portfolio, leases, debt, cash, insurance, market, relationships, documents, health`.
  - `principal`: `principal, overview, portfolio, cash, debt, insurance, leases, tasks, market, relationships, documents, health`.
- `PROFILE_HOME: Record<ViewProfile, string>` — `acquisitions → 'pipeline'`, `principal → 'principal'`.
- `orderedModules(profile, modules = MODULES): ModuleDef[]` — returns the registry sorted by the
  profile's order; any id not listed falls to the end (so a newly-added module never disappears).

### 4. `src/modules/principal/PrincipalModule.tsx` — the Principal home (new, route `principal`)
Tailored, **responsive** (Tailwind grid stacks to one column on small screens). Composes existing
primitives/analytics — no duplicated logic:
- Portfolio KPIs (NOI, value, occupancy, consolidated cash) via the existing `KpiStat`/analytics.
- Debt maturities + DSCR/covenant watch; cash concentration.
- **"Needs your attention"** decision queue from `principalDigest`.

### 5. `src/brain/principal-digest.ts` — decision queue (pure)
`principalDigest(snapshot, analytics): DigestItem[]` — the items a principal should act on:
critical/warning insights (from the existing analytics `insights`) plus deals in `LOI/PSA` or
`Closing` stages. Sorted by severity then stage. Pure + fixture-tested; the module only renders it.

### Wiring
- `AppShell` rail renders `orderedModules(profile)` instead of the static `MODULES` order.
- The index route (`/`) redirects to `PROFILE_HOME[profile]` instead of the static `DEFAULT_MODULE`.
- `PrincipalModule` is registered in `MODULES` (group `Command`, label e.g. "Principal Home") so it
  is reachable from any profile; it is merely the *default* for the principal profile.

## Data flow

`useViewProfile()` (localStorage-backed) → `AppShell` orders the rail and the index route redirects
to the profile home → `PrincipalModule` renders `principalDigest(snapshot, analytics)` from the same
snapshot/analytics every module uses (so it inherits live auto-refresh + freshness automatically).
Toggling updates context + localStorage and re-renders in place.

## Error handling / edge cases

- Unknown/legacy `localStorage` value → falls back to `'acquisitions'`.
- A module id present in `MODULE_ORDER` but absent from `MODULES` (or vice-versa) → `orderedModules`
  ignores unknown ids and appends unlisted modules, so the rail never breaks.
- No snapshot yet (loading) → `PrincipalModule` shows the normal loading state; `principalDigest`
  returns `[]` for an empty snapshot.

## Out of scope (deferred)

- Cloudflare Access identity auto-detection (zero-click role).
- Hiding modules per role.
- Full-app mobile responsive pass (only the Principal landing is responsive here).
- A bespoke *Acquisitions* landing (Gabriel's profile reuses the existing pipeline/overview modules).

## Testing

- `view-profile`: `loadProfile` default + bad-value tolerance; `saveProfile`→`loadProfile` round-trip (localStorage mocked).
- `module-order`: `orderedModules('principal')` and `'acquisitions')` produce the expected order; unlisted ids append; `PROFILE_HOME` correct.
- `principal-digest`: queue includes critical/warning insights + `LOI/PSA`/`Closing` deals, excludes info/other; severity-then-stage sort; empty snapshot → `[]`.
- `ViewToggle`: render in jsdom, click flips the profile (and persists).
- `PrincipalModule`: render with a fixture snapshot/analytics; asserts KPI + "Needs your attention" sections appear.
- `npm run gate` green; the `principal` route is its own lazy chunk → bundle budget holds.

## Rollout

Pure client change shipped via the normal bake+deploy (the hourly task republishes the mirror).
After deploy: confirm the toggle persists per device; Acquisitions lands on the pipeline, Principal
lands on the Principal home; verify the Principal home stacks cleanly on a phone width.
