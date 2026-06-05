# Alerts Inbox (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent in-app Alerts Inbox (`/alerts` module) plus a header bell with an unread badge, with per-alert read/unread/snooze state, built over the existing client-side insight engine.

**Architecture:** The alert *list* is already computed client-side by `generateInsights` (exposed as `analytics.insights` via `useAnalytics()`), so this plan adds no server engine. It adds (1) a small persisted **inbox state** (`read[]` + `snoozed{}`) with a live-server endpoint and a localStorage fallback, (2) a pure `buildAlertView` that joins insights with that state — implementing the snooze-escalation rule and the stat-strip counts — and (3) the UI: a `/alerts` module and a header bell. Writes follow the existing overlay-action pattern (live-server-only; mirror falls back to localStorage).

**Tech Stack:** React 19, TypeScript, Zod, @tanstack/react-query, Hono (server), Vitest, Tailwind v4, Lucide icons.

**Scope — explicitly deferred (tracked, not dropped):**
- **Threshold reconciliation** (balloon 180d, lease 60d, cash 30%, LTV>65%, tenant>15% NOI, DSCR<1.10). Edits the shared, partly data-driven `generateInsights`/`assumptions.thresholds` + the brief + `analytics.test.ts`. Its own follow-up plan. The inbox auto-inherits any change since it reads `analytics.insights`.
- **Extended insights in the inbox** (DSCR / LOI / stage-move from `server/brief/alerts.ts`). Surfacing these client-side means relocating `extendedInsights` into `src/analytics` and changing app-wide `analytics.insights`. Deferred. This plan shows the base `generateInsights` set (balloon, expiring/expired lease, insurance, cash concentration, low occupancy).
- **Background monitor (⑧):** already satisfied by the existing `server/brief/run.ts` firing inside the hourly bake. No new process. This plan adds only the inbox surface over it.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/contracts/alerts.ts` (create) | Zod types: `AlertInboxState`, `SnoozeEntry`, `AlertActionInput`; `EMPTY_INBOX_STATE` |
| `src/brain/alerts-view.ts` (create) | Pure: `applyAlertAction(state, input, now)` + `buildAlertView(insights, state, now)` |
| `server/alerts/store.ts` (create) | Load/save `data/alert-inbox.json` IO; thin wrappers over `applyAlertAction` |
| `server/index.ts` (modify) | `GET /api/alerts/state`, `POST /api/actions/alert` |
| `src/data/alerts.ts` (create) | `useAlertState()` query, `useAlertAction()` mutation (localStorage fallback), `useAlertView()` |
| `src/shell/AlertBell.tsx` (create) | Header bell + unread badge → navigates to `/alerts` |
| `src/shell/TopBar.tsx` (modify) | Render `<AlertBell/>` next to Search/Ask |
| `src/modules/alerts/AlertsModule.tsx` (create) | Stat strip + severity-grouped list + per-alert actions |
| `src/shell/modules.tsx` (modify) | Lazy import + `MODULES` registration (group `Command`) |
| `tests/unit/alerts-view.test.ts` (create) | Pure-core tests (the logic-heavy ones) |
| `tests/unit/alerts-store.test.ts` (create) | Store IO round-trip + transitions |

---

## Task 1: Inbox state contract

**Files:**
- Create: `src/contracts/alerts.ts`
- Test: `tests/unit/alerts-view.test.ts` (shared file; this task adds the contract block)

- [ ] **Step 1: Write the failing test**

Create `tests/unit/alerts-view.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { AlertInboxState, EMPTY_INBOX_STATE } from '../../src/contracts/alerts';

describe('AlertInboxState contract', () => {
  it('defaults missing fields to empty', () => {
    const s = AlertInboxState.parse({});
    expect(s).toEqual({ read: [], snoozed: {} });
  });

  it('parses a populated state', () => {
    const s = AlertInboxState.parse({
      read: ['balloon-l1'],
      snoozed: { 'cash-concentration': { until: '2026-07-01T00:00:00.000Z', severityAtSnooze: 'info' } },
    });
    expect(s.read).toContain('balloon-l1');
    expect(s.snoozed['cash-concentration'].severityAtSnooze).toBe('info');
  });

  it('exposes a frozen-ish EMPTY_INBOX_STATE default', () => {
    expect(EMPTY_INBOX_STATE).toEqual({ read: [], snoozed: {} });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/alerts-view.test.ts`
Expected: FAIL — cannot find module `../../src/contracts/alerts`.

- [ ] **Step 3: Write minimal implementation**

Create `src/contracts/alerts.ts`:

```typescript
import { z } from 'zod';

export const InsightSeverityZ = z.enum(['critical', 'warning', 'info']);
export type InsightSeverityZ = z.infer<typeof InsightSeverityZ>;

export const SnoozeEntry = z.object({
  until: z.string(), // ISO timestamp; snooze expires at/after this
  severityAtSnooze: InsightSeverityZ, // escalation past this re-shows the alert
});
export type SnoozeEntry = z.infer<typeof SnoozeEntry>;

export const AlertInboxState = z.object({
  read: z.array(z.string()).default([]),
  snoozed: z.record(z.string(), SnoozeEntry).default({}),
});
export type AlertInboxState = z.infer<typeof AlertInboxState>;

export const EMPTY_INBOX_STATE: AlertInboxState = { read: [], snoozed: {} };

/** POST /api/actions/alert body. */
export const AlertActionInput = z.object({
  alertId: z.string().min(1),
  action: z.enum(['read', 'unread', 'snooze']),
  days: z.union([z.literal(7), z.literal(30)]).optional(),
  severity: InsightSeverityZ.optional(), // required for snooze (current severity)
});
export type AlertActionInput = z.infer<typeof AlertActionInput>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/alerts-view.test.ts`
Expected: PASS (3 passing).

- [ ] **Step 5: Commit**

```bash
git add src/contracts/alerts.ts tests/unit/alerts-view.test.ts
git commit -m "feat(alerts): inbox state contract (read/snooze)"
```

---

## Task 2: Pure alert-view core (the logic)

**Files:**
- Create: `src/brain/alerts-view.ts`
- Test: `tests/unit/alerts-view.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/alerts-view.test.ts`:

```typescript
import { applyAlertAction, buildAlertView } from '../../src/brain/alerts-view';
import type { Insight } from '../../src/analytics/types';
import type { AlertInboxState } from '../../src/contracts/alerts';

const ins = (id: string, severity: Insight['severity']): Insight => ({
  id, severity, category: 'debt', title: id, detail: id,
});
const NOW = Date.parse('2026-06-04T12:00:00.000Z');
const DAY = 86_400_000;

describe('applyAlertAction', () => {
  const base: AlertInboxState = { read: [], snoozed: {} };

  it('marks read and unread', () => {
    const r = applyAlertAction(base, { alertId: 'a', action: 'read' }, NOW);
    expect(r.read).toEqual(['a']);
    const u = applyAlertAction(r, { alertId: 'a', action: 'unread' }, NOW);
    expect(u.read).toEqual([]);
  });

  it('snoozes for 7 or 30 days with the current severity recorded', () => {
    const r = applyAlertAction(base, { alertId: 'a', action: 'snooze', days: 30, severity: 'warning' }, NOW);
    expect(r.snoozed['a'].severityAtSnooze).toBe('warning');
    expect(Date.parse(r.snoozed['a'].until)).toBe(NOW + 30 * DAY);
  });

  it('defaults snooze to 7 days and info severity when omitted', () => {
    const r = applyAlertAction(base, { alertId: 'a', action: 'snooze' }, NOW);
    expect(Date.parse(r.snoozed['a'].until)).toBe(NOW + 7 * DAY);
    expect(r.snoozed['a'].severityAtSnooze).toBe('info');
  });
});

describe('buildAlertView', () => {
  it('groups by severity, counts, and computes unread', () => {
    const insights = [ins('a', 'info'), ins('b', 'critical'), ins('c', 'warning')];
    const v = buildAlertView(insights, { read: ['c'], snoozed: {} }, NOW);
    expect(v.items.map((i) => i.insight.id)).toEqual(['b', 'c', 'a']); // critical → warning → info
    expect(v.counts).toEqual({ critical: 1, warning: 1, info: 1, snoozed: 0 });
    expect(v.unread).toBe(2); // a + b unread; c is read
  });

  it('hides a still-snoozed alert and counts it as snoozed', () => {
    const state: AlertInboxState = {
      read: [],
      snoozed: { a: { until: new Date(NOW + DAY).toISOString(), severityAtSnooze: 'warning' } },
    };
    const v = buildAlertView([ins('a', 'warning')], state, NOW);
    expect(v.items).toHaveLength(0);
    expect(v.counts.snoozed).toBe(1);
  });

  it('re-shows a snoozed alert once its severity escalates', () => {
    const state: AlertInboxState = {
      read: [],
      snoozed: { a: { until: new Date(NOW + DAY).toISOString(), severityAtSnooze: 'warning' } },
    };
    const v = buildAlertView([ins('a', 'critical')], state, NOW); // escalated warning → critical
    expect(v.items).toHaveLength(1);
    expect(v.counts.snoozed).toBe(0);
  });

  it('re-shows a snoozed alert after the window expires', () => {
    const state: AlertInboxState = {
      read: [],
      snoozed: { a: { until: new Date(NOW - DAY).toISOString(), severityAtSnooze: 'warning' } },
    };
    const v = buildAlertView([ins('a', 'warning')], state, NOW);
    expect(v.items).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/alerts-view.test.ts`
Expected: FAIL — cannot find module `../../src/brain/alerts-view`.

- [ ] **Step 3: Write the implementation**

Create `src/brain/alerts-view.ts`:

```typescript
import type { Insight, InsightSeverity } from '../analytics/types';
import type { AlertInboxState, AlertActionInput } from '../contracts/alerts';

const DAY_MS = 86_400_000;
/** Higher rank = more severe. Escalation past the snoozed rank re-shows the alert. */
const RANK: Record<InsightSeverity, number> = { critical: 3, warning: 2, info: 1 };
/** Display order: critical first. */
const ORDER: Record<InsightSeverity, number> = { critical: 0, warning: 1, info: 2 };

/** Pure state transition for a read/unread/snooze action. */
export function applyAlertAction(state: AlertInboxState, input: AlertActionInput, now: number): AlertInboxState {
  if (input.action === 'snooze') {
    const days = input.days === 30 ? 30 : 7;
    return {
      ...state,
      snoozed: {
        ...state.snoozed,
        [input.alertId]: {
          until: new Date(now + days * DAY_MS).toISOString(),
          severityAtSnooze: input.severity ?? 'info',
        },
      },
    };
  }
  const read = new Set(state.read);
  if (input.action === 'read') read.add(input.alertId);
  else read.delete(input.alertId);
  return { ...state, read: [...read] };
}

export interface AlertViewItem {
  insight: Insight;
  read: boolean;
  snoozedUntil: string | null;
}

export interface AlertView {
  items: AlertViewItem[]; // visible (snoozed-hidden removed), severity-sorted
  counts: { critical: number; warning: number; info: number; snoozed: number };
  unread: number;
}

export function buildAlertView(insights: Insight[], state: AlertInboxState, now: number): AlertView {
  const readSet = new Set(state.read);
  const visible: AlertViewItem[] = [];
  let snoozed = 0;

  for (const insight of insights) {
    const snz = state.snoozed[insight.id];
    const hidden =
      !!snz &&
      now < Date.parse(snz.until) &&
      RANK[insight.severity] <= RANK[snz.severityAtSnooze]; // not escalated → stay hidden
    if (hidden) {
      snoozed += 1;
      continue;
    }
    visible.push({ insight, read: readSet.has(insight.id), snoozedUntil: snz ? snz.until : null });
  }

  visible.sort((a, b) => ORDER[a.insight.severity] - ORDER[b.insight.severity]);

  const counts = { critical: 0, warning: 0, info: 0, snoozed };
  for (const v of visible) counts[v.insight.severity] += 1;

  return { items: visible, counts, unread: visible.filter((v) => !v.read).length };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/alerts-view.test.ts`
Expected: PASS (all alert-view + contract tests).

- [ ] **Step 5: Commit**

```bash
git add src/brain/alerts-view.ts tests/unit/alerts-view.test.ts
git commit -m "feat(alerts): pure alert-view core with snooze-escalation"
```

---

## Task 3: Server inbox-state store

**Files:**
- Create: `server/alerts/store.ts`
- Test: `tests/unit/alerts-store.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/alerts-store.test.ts`:

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { rmSync, existsSync } from 'node:fs';
import { loadInboxState, saveInboxState, runAlertAction } from '../../server/alerts/store';

const TMP = 'data/__test-alert-inbox.json';
afterEach(() => { if (existsSync(TMP)) rmSync(TMP); });

describe('inbox store', () => {
  it('returns empty state when the file is absent', () => {
    expect(loadInboxState(TMP)).toEqual({ read: [], snoozed: {} });
  });

  it('round-trips a saved state', () => {
    saveInboxState({ read: ['x'], snoozed: {} }, TMP);
    expect(loadInboxState(TMP).read).toEqual(['x']);
  });

  it('applies an action and persists it', () => {
    const next = runAlertAction({ alertId: 'a', action: 'read' }, TMP);
    expect(next.read).toEqual(['a']);
    expect(loadInboxState(TMP).read).toEqual(['a']);
  });

  it('tolerates a corrupt file by returning empty state', () => {
    saveInboxState({ read: ['x'], snoozed: {} }, TMP);
    // corrupt it
    require('node:fs').writeFileSync(TMP, '{ not json');
    expect(loadInboxState(TMP)).toEqual({ read: [], snoozed: {} });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/alerts-store.test.ts`
Expected: FAIL — cannot find module `../../server/alerts/store`.

- [ ] **Step 3: Write the implementation**

Create `server/alerts/store.ts`:

```typescript
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { AlertInboxState, EMPTY_INBOX_STATE, type AlertActionInput } from '../../src/contracts/alerts';
import { applyAlertAction } from '../../src/brain/alerts-view';

const DEFAULT_PATH = process.env.ALERT_INBOX_PATH ?? 'data/alert-inbox.json';

export function loadInboxState(path = DEFAULT_PATH): AlertInboxState {
  if (!existsSync(path)) return { ...EMPTY_INBOX_STATE };
  try {
    return AlertInboxState.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return { ...EMPTY_INBOX_STATE };
  }
}

export function saveInboxState(state: AlertInboxState, path = DEFAULT_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2));
}

/** Load → apply → save. Returns the new state. */
export function runAlertAction(input: AlertActionInput, path = DEFAULT_PATH): AlertInboxState {
  const next = applyAlertAction(loadInboxState(path), input, Date.now());
  saveInboxState(next, path);
  return next;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/alerts-store.test.ts`
Expected: PASS (4 passing).

- [ ] **Step 5: Commit**

```bash
git add server/alerts/store.ts tests/unit/alerts-store.test.ts
git commit -m "feat(alerts): server inbox-state store"
```

---

## Task 4: Wire the inbox endpoints

**Files:**
- Modify: `server/index.ts` (add two routes near the existing `/api/actions/*` routes, ~line 61–87)

- [ ] **Step 1: Add the imports**

At the top of `server/index.ts`, alongside the other server imports, add:

```typescript
import { loadInboxState, runAlertAction } from './alerts/store';
import { AlertActionInput } from '../src/contracts/alerts';
```

- [ ] **Step 2: Add the routes**

Immediately after the existing `app.post('/api/actions/task', ...)` handler, add:

```typescript
app.get('/api/alerts/state', (c) => c.json(loadInboxState()));

app.post('/api/actions/alert', async (c) => {
  const parsed = AlertActionInput.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ ok: false, error: 'Invalid alert action' }, 400);
  const state = runAlertAction(parsed.data);
  return c.json({ ok: true, state });
});
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 4: Verify the endpoints live**

Start the server if not running: `node_modules\.bin\tsx server/index.ts` (or rely on the running dev server), then:

```bash
curl -s http://localhost:8911/api/alerts/state
# Expected: {"read":[],"snoozed":{}}  (or existing state)

curl -s -X POST http://localhost:8911/api/actions/alert \
  -H "content-type: application/json" \
  -d "{\"alertId\":\"cash-concentration\",\"action\":\"snooze\",\"days\":7,\"severity\":\"info\"}"
# Expected: {"ok":true,"state":{...,"snoozed":{"cash-concentration":{...}}}}

curl -s http://localhost:8911/api/alerts/state
# Expected: the snoozed entry persisted
```

Then remove the test entry so it doesn't linger:

```bash
curl -s -X POST http://localhost:8911/api/actions/alert -H "content-type: application/json" -d "{\"alertId\":\"cash-concentration\",\"action\":\"unread\"}" >NUL
```

- [ ] **Step 5: Commit**

```bash
git add server/index.ts
git commit -m "feat(alerts): inbox-state endpoints (GET state, POST action)"
```

---

## Task 5: Client data hooks

**Files:**
- Create: `src/data/alerts.ts`

- [ ] **Step 1: Write the implementation**

Create `src/data/alerts.ts`:

```typescript
import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertInboxState, EMPTY_INBOX_STATE, type AlertActionInput } from '../contracts/alerts';
import { applyAlertAction, buildAlertView, type AlertView } from '../brain/alerts-view';
import { useAnalytics } from './queries';

export const ALERT_STATE_KEY = ['alert-state'] as const;
const LS_KEY = 'ora-alert-state';

function readLocal(): AlertInboxState {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return AlertInboxState.parse(JSON.parse(raw));
  } catch {
    /* ignore */
  }
  return { ...EMPTY_INBOX_STATE };
}

async function fetchAlertState(): Promise<AlertInboxState> {
  try {
    const res = await fetch('/api/alerts/state');
    if (res.ok) return AlertInboxState.parse(await res.json());
  } catch {
    /* server offline — fall back to localStorage (mirror) */
  }
  return readLocal();
}

export function useAlertState() {
  return useQuery({ queryKey: ALERT_STATE_KEY, queryFn: fetchAlertState, staleTime: 30_000 });
}

export function useAlertAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: AlertActionInput): Promise<AlertInboxState> => {
      try {
        const res = await fetch('/api/actions/alert', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        });
        if (res.ok) {
          const json = (await res.json()) as { state: unknown };
          return AlertInboxState.parse(json.state);
        }
      } catch {
        /* offline — mutate locally below */
      }
      const cur = qc.getQueryData<AlertInboxState>(ALERT_STATE_KEY) ?? readLocal();
      const next = applyAlertAction(cur, input, Date.now());
      try {
        localStorage.setItem(LS_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    },
    onSuccess: (state) => qc.setQueryData(ALERT_STATE_KEY, state),
  });
}

/** Joins the client-computed insights with persisted read/snooze state. */
export function useAlertView(): AlertView {
  const { analytics } = useAnalytics();
  const stateQ = useAlertState();
  const insights = analytics?.insights ?? [];
  const state = stateQ.data ?? EMPTY_INBOX_STATE;
  return useMemo(() => buildAlertView(insights, state, Date.now()), [insights, state]);
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors. (If `analytics.insights` is reported missing, confirm the property name in `src/analytics/types.ts` `AnalyticsBundle` and use the correct one — it is the array returned by `generateInsights`.)

- [ ] **Step 3: Commit**

```bash
git add src/data/alerts.ts
git commit -m "feat(alerts): client hooks (state query, action mutation, view)"
```

---

## Task 6: Header alert bell

**Files:**
- Create: `src/shell/AlertBell.tsx`

- [ ] **Step 1: Write the implementation**

Create `src/shell/AlertBell.tsx`. Match the existing TopBar button styling (CSS vars, `text-2xs`, `rounded-[var(--radius-sm)]`). Navigation uses the same mechanism the sidebar uses — `useUi().setActiveModule` (the UI context exposes it; the Ask button uses `ui.toggleAi` from the same context):

```tsx
import { Bell } from 'lucide-react';
import { useAlertView } from '../data/alerts';
import { useUi } from './ui-context';

export function AlertBell() {
  const view = useAlertView();
  const ui = useUi();
  const unread = view.unread;

  return (
    <button
      onClick={() => ui.setActiveModule('alerts')}
      aria-label={`Alerts${unread ? ` (${unread} unread)` : ''}`}
      className="relative flex items-center justify-center rounded-[var(--radius-sm)] p-1.5 transition-colors"
      style={{ background: 'var(--surface-overlay)', border: '1px solid var(--border-subtle)', color: 'var(--text-tertiary)' }}
    >
      <Bell size={14} />
      {unread > 0 && (
        <span
          className="absolute -right-1 -top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-1 text-[9px] font-bold"
          style={{ background: 'var(--danger, #e05c5c)', color: '#fff' }}
        >
          {unread > 9 ? '9+' : unread}
        </span>
      )}
    </button>
  );
}
```

- [ ] **Step 2: Confirm the UI-context API**

Open `src/shell/ui-context.ts` (or wherever `useUi` is defined — the TopBar imports it for `ui.toggleAi`). Confirm the setter name for the active module. If it is named differently (e.g. `setActive`, `navigate`), use that exact name in `AlertBell.tsx`. Do not invent a name.

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors once the setter name matches.

- [ ] **Step 3: Commit**

```bash
git add src/shell/AlertBell.tsx
git commit -m "feat(alerts): header bell with unread badge"
```

---

## Task 7: Mount the bell in the TopBar

**Files:**
- Modify: `src/shell/TopBar.tsx` (button cluster, ~line 57)

- [ ] **Step 1: Import the bell**

Add to the imports at the top of `src/shell/TopBar.tsx`:

```typescript
import { AlertBell } from './AlertBell';
```

- [ ] **Step 2: Render it**

Inside the `<div className="flex items-center gap-2.5">` button cluster, immediately **before** the Ask button (after the Search button block), add:

```tsx
<AlertBell />
```

- [ ] **Step 3: Verify in the browser**

With the dev server running (`:5273`), open the app. Expected: a bell icon appears between Search and Ask in the header; if there are active unread alerts a red badge shows the count.

Use the preview tools to confirm: take a snapshot, check there are no console errors.

- [ ] **Step 4: Commit**

```bash
git add src/shell/TopBar.tsx
git commit -m "feat(alerts): mount alert bell in the top bar"
```

---

## Task 8: Alerts module

**Files:**
- Create: `src/modules/alerts/AlertsModule.tsx`

- [ ] **Step 1: Write the implementation**

Create `src/modules/alerts/AlertsModule.tsx`. Mirrors the existing module layout (a header, a stat strip, a list). Uses `useAlertView()` + `useAlertAction()`:

```tsx
import { useAlertView, useAlertAction } from '../../data/alerts';
import type { AlertViewItem } from '../../brain/alerts-view';

const SEV_COLOR: Record<string, string> = {
  critical: '#e05c5c',
  warning: '#e0a85c',
  info: '#5c9fe0',
};

export function AlertsModule() {
  const view = useAlertView();
  const action = useAlertAction();

  return (
    <div className="mx-auto max-w-4xl p-4">
      <h2 className="mb-3 text-lg font-semibold">Alerts</h2>

      <div className="mb-4 grid grid-cols-4 gap-2">
        <Stat label="Critical" value={view.counts.critical} color={SEV_COLOR.critical} />
        <Stat label="Warning" value={view.counts.warning} color={SEV_COLOR.warning} />
        <Stat label="Info" value={view.counts.info} color={SEV_COLOR.info} />
        <Stat label="Snoozed" value={view.counts.snoozed} />
      </div>

      {view.items.length === 0 ? (
        <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>No active alerts.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {view.items.map((item) => (
            <AlertRow
              key={item.insight.id}
              item={item}
              onRead={() => action.mutate({ alertId: item.insight.id, action: item.read ? 'unread' : 'read' })}
              onSnooze={(days) =>
                action.mutate({ alertId: item.insight.id, action: 'snooze', days, severity: item.insight.severity })
              }
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div className="rounded-md p-2.5" style={{ background: 'var(--surface-overlay)' }}>
      <div className="text-lg font-bold" style={{ color: color ?? 'var(--text-primary)' }}>{value}</div>
      <div className="text-2xs" style={{ color: 'var(--text-tertiary)' }}>{label}</div>
    </div>
  );
}

function AlertRow({ item, onRead, onSnooze }: { item: AlertViewItem; onRead: () => void; onSnooze: (days: 7 | 30) => void }) {
  const c = SEV_COLOR[item.insight.severity];
  return (
    <li
      className="rounded-md p-3"
      style={{
        background: 'var(--surface-overlay)',
        borderLeft: `2px solid ${c}`,
        opacity: item.read ? 0.55 : 1,
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-sm font-semibold">{item.insight.title}</div>
          <div className="text-2xs" style={{ color: 'var(--text-tertiary)' }}>{item.insight.detail}</div>
        </div>
        <div className="flex shrink-0 gap-1.5">
          <button className="text-2xs" style={{ color: 'var(--text-tertiary)' }} onClick={() => onSnooze(7)}>Snooze 7d</button>
          <button className="text-2xs" style={{ color: 'var(--text-tertiary)' }} onClick={() => onSnooze(30)}>30d</button>
          <button className="text-2xs" style={{ color: 'var(--accent)' }} onClick={onRead}>{item.read ? 'Unread' : 'Mark read'}</button>
        </div>
      </div>
    </li>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/modules/alerts/AlertsModule.tsx
git commit -m "feat(alerts): alerts module (stat strip + grouped list + actions)"
```

---

## Task 9: Register the module

**Files:**
- Modify: `src/shell/modules.tsx` (lazy import block ~line 20–32; `MODULES` array ~line 46–59)

- [ ] **Step 1: Add the lazy import**

In the lazy-import block at the top of `src/shell/modules.tsx`, matching the existing pattern, add:

```typescript
const AlertsModule = lazy(() => import('../modules/alerts/AlertsModule').then((m) => ({ default: m.AlertsModule })));
```

(If the file uses a different lazy pattern — e.g. a `mod()` helper — match it exactly.)

- [ ] **Step 2: Add the Lucide icon import**

Ensure `Bell` is imported from `lucide-react` at the top of the file (add to the existing `lucide-react` import list):

```typescript
import { Bell } from 'lucide-react';
```

- [ ] **Step 3: Register in MODULES**

Add this entry to the `MODULES` array, in the `Command` group (place it after `tasks`):

```typescript
{ id: 'alerts', label: 'Alerts', icon: Bell, group: 'Command', Component: AlertsModule },
```

- [ ] **Step 4: Typecheck + gate**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

Run: `npm run gate`
Expected: typecheck + lint + tests + reconcile all green.

- [ ] **Step 5: Verify end-to-end in the browser**

With dev server running, open the app:
- The sidebar shows an **Alerts** item in the Command group.
- Clicking the header bell navigates to `/alerts`.
- The module shows the stat strip + the current alerts.
- Click **Snooze 7d** on an alert → it disappears from the list and the Snoozed count increments; the bell unread count drops.
- Reload → the snooze persists (served from `/api/alerts/state`).

Confirm with the preview tools: snapshot the `/alerts` route, check console for errors, click a snooze button and re-snapshot to confirm the item leaves the list.

- [ ] **Step 6: Commit**

```bash
git add src/shell/modules.tsx
git commit -m "feat(alerts): register /alerts module in the rail"
```

---

## Final verification

- [ ] `npm run gate` is green.
- [ ] `data/alert-inbox.json` is gitignored (confirm it sits under `data/`, which the repo already ignores alongside `overlay.json` / `alert-state.json`; if not, add `data/alert-inbox.json` to `.gitignore`).
- [ ] The bell badge, the `/alerts` module, snooze (with escalation), mark-read, and persistence all work against the live server; the module still renders on the static mirror using the localStorage fallback (no crash when `/api/alerts/state` 404s).

## Deferred to follow-up plans (tracked)

1. **Threshold reconciliation** — update `generateInsights` (`src/analytics/engine.ts`) + `assumptions.thresholds` to the approved catalog (balloon 180d, lease 60d, cash 30%, LTV>65%, tenant>15% NOI, DSCR<1.10); update `extendedInsights` and `tests/unit/analytics.test.ts`. Its own plan because it edits a shared, partly data-driven engine and the brief.
2. **Extended insights in the inbox** — relocate `extendedInsights` (DSCR/LOI/stage-move/lease180) from `server/brief/alerts.ts` into `src/analytics` and append (with `priorStages = {}`) in `buildAnalytics`, so the inbox and the whole app surface them. Touches app-wide `analytics.insights`.
3. **Per-alert deep-link + draft CTA** — wire each alert row's entity to open the existing entity drawer and the matching draft-email CTA (the `InsightAction.kind` already carries `draft-renewal`/`open-refi`/`review`).
