# Oxford Command Center — Live Auto-Refresh (Design)

**Date:** 2026-06-04
**Status:** Approved (design) — pending implementation plan
**Owner:** Gabriel Goldberg (ORA)

## Goal

Make an open dashboard tab update itself, so the mirror that Eric (and Gabriel) leave open reflects
the latest hourly bake without a manual reload — with an honest freshness indicator so the displayed
data age is always visible.

## Background / current state

- **Local Brain Server: already live.** `src/data/provider.tsx` wires `connectBrainSSE` (`/sse`); on a
  `snapshot` event it invalidates the snapshot query → instant refetch. Bakes/writes push immediately.
- **Static Cloudflare mirror (what Eric sees): not live.** No server, so `/sse` 404s (and the browser
  retries it forever), and the snapshot query (`useSnapshot`) fetches `/snapshot.json` once at load
  with `staleTime: 30s` + `refetchOnWindowFocus: true` — but **no interval**. A passively-open tab
  never reflects a new hourly bake until the window is re-focused.

## Decisions (locked)

| Decision | Choice |
|---|---|
| Mechanism | TanStack Query `refetchInterval` (not a custom interval or SSE-on-mirror) |
| Cadence | **5 minutes**, applied universally (live mechanism on the mirror; harmless backstop on the local server behind SSE) |
| Update UX | **Silent in-place swap** (structural sharing) + the existing freshness pill reflects the new timestamp. No toast, no "click to refresh" banner. |
| Dead SSE on mirror | **Bounded reconnect** — stop retrying `/sse` after ~3 consecutive failures with no successful event |
| Background tabs | Do **not** poll when hidden (default); `refetchOnWindowFocus` covers return-to-tab |

## Components

### 1. `src/data/queries.ts` — interval polling
Add `refetchInterval: 5 * 60_000` and `refetchOnReconnect: true` to the snapshot query (keep
`staleTime: 30_000`). A failed poll keeps the previous data (TanStack retains last success), so there
is no flicker; the freshness age simply grows — honest staleness rather than a blank.

### 2. `src/data/sse.ts` — bounded reconnect
`connectBrainSSE` currently opens `EventSource('/sse')` and relies on the browser's built-in retry,
which loops forever on the static mirror (no `/sse`). Change: track whether the stream has ever
delivered an event; count consecutive errors; after a small threshold (3) with no successful event,
`close()` and stop. A stream that opens successfully (local server) resets the counter and keeps
reconnecting normally. Net: local server unaffected; mirror stops the forever-retry (no console noise
or wasted requests).

### 3. Freshness indicator (surface, don't reinvent)
Reuse the existing freshness model (`src/lib/freshness.ts`: `computeFreshness`, `formatAge`,
`STALENESS_HOURS=24`) and `StatusPill`. Ensure a relative "Updated _Xm_ ago" is visible in the shell
header and recomputes on each refetch; the existing `StaleBanner` continues to fire at the 24h
threshold. This is a small surfacing enhancement, not new freshness logic.

## Data flow

Open tab → snapshot query refetches `/snapshot.json` every 5 min (or on window focus / reconnect) →
structural sharing swaps only changed values in place → derived analytics + freshness pill recompute
→ user sees current figures and an honest age. The local server additionally refetches instantly on
each SSE `snapshot` event (unchanged).

## Error handling

- **Failed poll:** keep prior data; freshness age increases; `StaleBanner` eventually warns at 24h.
- **Mirror `/sse` absent:** bounded reconnect closes the stream after 3 failed attempts; the interval
  poll is the live path there.
- **No new failure modes** introduced; no new dependencies.

## Testing

- `queries`: the snapshot query exposes `refetchInterval === 300000`; a fake-timer behavioral check
  that advancing time past the interval triggers a refetch.
- `sse`: with a mock `EventSource`, N error events with no successful message → `close()` called and
  no further reopen; a successful `open`/event resets the counter and normal reconnect continues.
- `freshness`: the header renders a relative age derived from the snapshot's `generatedAt` (extends
  existing freshness tests).
- `npm run gate` stays green; bundle budget unaffected (no new deps; client-only change).

## Out of scope (deferred, as agreed)

- True SSE push on the mirror (requires the always-on hosting decision, deferred to the hourly-bake interim).
- Role-based views (you vs. Eric) — separate track.

## Rollout

Pure client change shipped via the normal bake+deploy. After deploy, leave a mirror tab open and
confirm it reflects the next hourly bake within ~5 minutes and that the freshness age ticks; confirm
the browser is no longer retrying `/sse` on the mirror (Network tab).
