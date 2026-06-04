# Live Auto-Refresh — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An open dashboard tab refreshes itself every 5 minutes (silent in-place swap) so the static mirror reflects the latest hourly bake, with an honest "updated _Xm_ ago" that ticks; and the dead `/sse` connection on the mirror stops retrying forever.

**Architecture:** Three small client-only changes — (1) add `refetchInterval` to the TanStack Query snapshot query, (2) bound the SSE reconnect in `connectBrainSSE`, (3) a `useNow` ticker so the existing freshness pill/banner recompute age between refetches. Reuses the existing `freshness.ts` + `StatusPill`/`StaleBanner`; no new deps.

**Tech Stack:** React 19, TanStack Query v5, TypeScript, Vitest (jsdom + @testing-library/react).

**Spec:** `docs/superpowers/specs/2026-06-04-live-auto-refresh-design.md`

**Test commands:** single file → `npx vitest run tests/unit/<file>`; full gate → `npm run gate`.

---

### Task 1: 5-minute refetch interval on the snapshot query

The snapshot query currently has no interval, so an open tab never re-fetches on its own. Add a 5-minute `refetchInterval`. (`refetchOnReconnect` is already TanStack Query v5's default, so it needs no change. `staleTime` stays 30s.)

**Files:**
- Modify: `src/data/queries.ts`
- Test: `tests/unit/queries.test.tsx` (new)

- [ ] **Step 1: Write the failing test** — `tests/unit/queries.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as client from '../../src/data/client';
import { useSnapshot, SNAPSHOT_REFETCH_MS } from '../../src/data/queries';

const wrap = (qc: QueryClient) =>
  ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('useSnapshot auto-refresh', () => {
  it('exposes a 5-minute refetch interval', () => {
    expect(SNAPSHOT_REFETCH_MS).toBe(300_000);
  });

  it('re-fetches on the interval while mounted', async () => {
    vi.useFakeTimers();
    const spy = vi
      .spyOn(client, 'fetchSnapshot')
      .mockResolvedValue({ snapshot: {} as never, state: {} as never });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => useSnapshot(), { wrapper: wrap(qc) });

    await vi.advanceTimersByTimeAsync(0); // initial fetch
    expect(spy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(SNAPSHOT_REFETCH_MS + 50); // one interval later
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/queries.test.tsx`
Expected: FAIL — `SNAPSHOT_REFETCH_MS` is not exported / interval not set.

- [ ] **Step 3: Implement** — in `src/data/queries.ts`, add the constant and use it in `useSnapshot`:

```ts
export const SNAPSHOT_KEY = ['snapshot'] as const;

/** An open tab re-fetches the snapshot this often, so the static mirror reflects the latest
 *  hourly bake without a manual reload. On the local Brain Server this is a backstop behind the
 *  instant SSE push. */
export const SNAPSHOT_REFETCH_MS = 5 * 60_000;
```

Then change `useSnapshot` to:

```ts
export function useSnapshot() {
  return useQuery({ queryKey: SNAPSHOT_KEY, queryFn: fetchSnapshot, refetchInterval: SNAPSHOT_REFETCH_MS });
}
```

(Leave the global `queryClient` defaults — `staleTime: 30_000`, `refetchOnWindowFocus: true`, `retry: 1` — unchanged.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/queries.test.tsx`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add src/data/queries.ts tests/unit/queries.test.tsx
git commit -m "feat(live): 5-minute snapshot refetch interval so open tabs auto-update"
```

---

### Task 2: Bounded SSE reconnect (stop retrying the mirror's missing /sse)

`connectBrainSSE` opens `EventSource('/sse')` and relies on the browser's built-in retry. On the static mirror there is no `/sse`, so the browser retries forever (console noise + wasted requests). Add an error counter that `close()`s the stream after 3 consecutive errors with no successful event; any delivered event (`open`/`state`/`snapshot`) resets the counter, so the local server reconnects normally.

**Files:**
- Modify: `src/data/sse.ts`
- Test: `tests/unit/sse.test.ts` (new)

- [ ] **Step 1: Write the failing test** — `tests/unit/sse.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { connectBrainSSE } from '../../src/data/sse';

class MockES {
  static instances: MockES[] = [];
  url: string;
  closed = false;
  listeners: Record<string, Array<(e: unknown) => void>> = {};
  constructor(url: string) { this.url = url; MockES.instances.push(this); }
  addEventListener(t: string, fn: (e: unknown) => void) { (this.listeners[t] ??= []).push(fn); }
  removeEventListener(t: string, fn: (e: unknown) => void) { this.listeners[t] = (this.listeners[t] ?? []).filter((f) => f !== fn); }
  close() { this.closed = true; }
  emit(t: string, e: unknown = {}) { (this.listeners[t] ?? []).forEach((fn) => fn(e)); }
}

afterEach(() => { vi.unstubAllGlobals(); MockES.instances = []; });

describe('connectBrainSSE bounded reconnect', () => {
  it('closes the stream after 3 consecutive errors with no successful event', () => {
    vi.stubGlobal('EventSource', MockES as unknown as typeof EventSource);
    connectBrainSSE({});
    const es = MockES.instances.at(-1)!;
    es.emit('error'); es.emit('error');
    expect(es.closed).toBe(false);
    es.emit('error'); // 3rd
    expect(es.closed).toBe(true);
  });

  it('a delivered event resets the error streak', () => {
    vi.stubGlobal('EventSource', MockES as unknown as typeof EventSource);
    connectBrainSSE({ onSnapshot: () => {} });
    const es = MockES.instances.at(-1)!;
    es.emit('error'); es.emit('error');
    es.emit('snapshot'); // healthy → reset
    es.emit('error'); es.emit('error');
    expect(es.closed).toBe(false); // only 2 since reset
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/sse.test.ts`
Expected: FAIL — no error handling / stream never closes on error.

- [ ] **Step 3: Implement** — replace the body of `connectBrainSSE` in `src/data/sse.ts` (keep the `SSEHandlers` interface and imports):

```ts
/** Subscribe to the Brain Server's live event stream. Returns an unsubscribe fn.
 *  Bounded reconnect: after MAX_ERRORS consecutive errors with no successful event we close the
 *  stream, so the static mirror (which has no /sse) stops the browser's forever-retry loop. Any
 *  delivered event resets the counter, so a real server reconnects normally. */
export function connectBrainSSE(handlers: SSEHandlers): () => void {
  const es = new EventSource('/sse');
  const MAX_ERRORS = 3;
  let errorStreak = 0;

  const onState = (e: MessageEvent) => {
    errorStreak = 0;
    try {
      handlers.onState?.(JSON.parse(e.data) as BrainState);
    } catch {
      /* ignore malformed frame */
    }
  };
  const onSnapshot = () => { errorStreak = 0; handlers.onSnapshot?.(); };
  const onOpen = () => { errorStreak = 0; };
  const onError = () => {
    errorStreak += 1;
    if (errorStreak >= MAX_ERRORS) es.close();
  };

  es.addEventListener('state', onState as EventListener);
  es.addEventListener('snapshot', onSnapshot);
  es.addEventListener('open', onOpen);
  es.addEventListener('error', onError);
  return () => {
    es.removeEventListener('state', onState as EventListener);
    es.removeEventListener('snapshot', onSnapshot);
    es.removeEventListener('open', onOpen);
    es.removeEventListener('error', onError);
    es.close();
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/sse.test.ts`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add src/data/sse.ts tests/unit/sse.test.ts
git commit -m "fix(live): bound SSE reconnect so the static mirror stops retrying a missing /sse"
```

---

### Task 3: `useNow` ticker so the freshness age stays honest between refetches

`computeFreshness(state, now)` already accepts a `now`, but `StatusPill` and `StaleBanner` call it once per render, so the "baked _Xm_ ago" string freezes between refetches and the 24h stale threshold isn't re-evaluated while a tab sits open. Add a tiny `useNow` hook (re-renders every 30s) and pass it in.

**Files:**
- Create: `src/lib/useNow.ts`
- Test: `tests/unit/useNow.test.tsx` (new)
- Modify: `src/primitives/StatusPill.tsx`, `src/shell/StaleBanner.tsx`

- [ ] **Step 1: Write the failing test** — `tests/unit/useNow.test.tsx`:

```tsx
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/useNow.test.tsx`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement** — create `src/lib/useNow.ts`:

```ts
import { useEffect, useState } from 'react';

/** Current epoch ms, re-rendering on an interval so relative-age UI ticks. Default 30s. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
```

Then wire it in. In `src/primitives/StatusPill.tsx`, add the import and pass `now`:

```ts
import { useNow } from '@/lib/useNow';
```
Change the freshness line from `const f = computeFreshness(state);` to:
```ts
  const f = computeFreshness(state, useNow());
```

In `src/shell/StaleBanner.tsx`, do the same — add `import { useNow } from '@/lib/useNow';` and change its `const f = computeFreshness(state);` to `const f = computeFreshness(state, useNow());`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/useNow.test.tsx`
Expected: PASS. (The StatusPill/StaleBanner edits are type-checked by the gate; their behavior is already covered by the existing `freshness.test.ts`, which tests `computeFreshness(state, now)` directly.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/useNow.ts tests/unit/useNow.test.tsx src/primitives/StatusPill.tsx src/shell/StaleBanner.tsx
git commit -m "feat(live): tick the freshness age (useNow) so open tabs show honest data age"
```

---

## Final verification

- [ ] Run `npm run gate` — expect typecheck clean (3 tsconfigs), lint 0 warnings, all tests pass (target ~125), reconcile $0.
- [ ] Run `npm run build && npm run check:bundle` — expect within budget (no new deps; client-only change, entry chunk unchanged).
- [ ] Push `main` (or the feature branch per the finishing step) and confirm CI green.
- [ ] Post-deploy smoke (manual): open the mirror, leave the tab open, confirm it reflects the next hourly bake within ~5 minutes and the freshness pill age ticks; in DevTools Network, confirm `/sse` is no longer retrying in a loop.
