# Daily Brief + Same-Day Alerts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deterministic shared daily brief (06:45 ET) plus deduped same-day critical alerts, generated inside the hourly bake and emailed to both partners.

**Architecture:** New `server/brief/*` modules (pure where possible) compute extended insights, diff against a persisted `data/alert-state.json`, render deterministic HTML, and send via the local Outlook COM script (failure → outbox + health flag). `bake-mirror.ts` invokes the orchestrator when `BRIEF_ENABLED=1`. The Windows task runs hourly + a 06:45 trigger.

**Tech Stack:** TypeScript, Node, Vitest, Zod, existing `generateInsights`/`criticalDates` analytics, PowerShell Outlook COM send.

**Spec:** `docs/superpowers/specs/2026-06-04-daily-brief-alerts-design.md`

**Test commands:** single file → `npx vitest run tests/unit/<file>`; full gate → `npm run gate`.

---

### Task 1: Add `targetCloseDate` to the Deal contract (enables the LOI/PSA-deadline alert)

**Files:**
- Modify: `src/contracts/deal.ts`
- Modify: `src/data/seed-deals.ts` (add `targetCloseDate: null` to every deal object)
- Modify: `server/sources/notion-deals.ts` (map the date; preserve it in merge)
- Test: `tests/unit/notion-deals.test.ts` (extend)

- [ ] **Step 1: Write the failing test** — append to `tests/unit/notion-deals.test.ts` inside the `mapNotionPage` describe:

```ts
it('maps Target Close Date to targetCloseDate (ISO date)', () => {
  const d = mapNotionPage(page({ 'Target Close Date': { type: 'date', date: { start: '2026-06-15' } } }))!;
  expect(d.targetCloseDate).toBe('2026-06-15');
});

it('targetCloseDate is null when the Notion date is empty', () => {
  expect(mapNotionPage(page())!.targetCloseDate).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/notion-deals.test.ts`
Expected: FAIL — `targetCloseDate` is `undefined` / not a property.

- [ ] **Step 3: Implement**

In `src/contracts/deal.ts`, add the field after `owner` (line ~37), and import `IsoDateNullable`:

```ts
// at top with other imports
import { Market, IsoDateNullable } from './common';
// inside the Deal z.object, after owner:
  targetCloseDate: IsoDateNullable, // Notion "Target Close Date"; drives LOI/PSA-deadline alert
```

In `src/data/seed-deals.ts`, add `targetCloseDate: null,` to **each** deal object (place it next to `nextAction`). Every object in `SEED_DEALS` must have it (the array is typed `Deal[]`).

In `server/sources/notion-deals.ts`, add a date reader next to the other property readers (after `select`):

```ts
const dateProp = (p: Record<string, unknown>, k: string): string | null => {
  const v = p[k] as { date?: { start?: string | null } | null } | undefined;
  return v?.date?.start ?? null;
};
```

In `mapNotionPage`, add to the returned object (after `owner`):

```ts
    targetCloseDate: dateProp(p, 'Target Close Date'),
```

In `mergeDeals`, add `targetCloseDate` to the live-wins merge (in the returned object, with the other `pick(...)` lines):

```ts
      targetCloseDate: pick(live.targetCloseDate, s.targetCloseDate),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/notion-deals.test.ts`
Expected: PASS (all, including the two new cases).

- [ ] **Step 5: Commit**

```bash
git add src/contracts/deal.ts src/data/seed-deals.ts server/sources/notion-deals.ts tests/unit/notion-deals.test.ts
git commit -m "feat(deal): add targetCloseDate (Notion Target Close Date) for LOI/PSA alerts"
```

---

### Task 2: Extended alerts engine (`server/brief/alerts.ts`)

Adds DSCR<1.25 covenant watch, a 91–180d lease info tier, LOI/PSA deadline ≤14d, and deal-stage movement to the base `generateInsights`.

**Files:**
- Modify: `src/analytics/types.ts` (add `'deal'` to `InsightCategory`)
- Create: `server/brief/alerts.ts`
- Test: `tests/unit/brief-alerts.test.ts`

- [ ] **Step 1: Write the failing test** — `tests/unit/brief-alerts.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { PortfolioSnapshot } from '../../src/contracts/index';
import { extendedInsights } from '../../server/brief/alerts';

function snap(over: Partial<PortfolioSnapshot> = {}): PortfolioSnapshot {
  const base = {
    meta: { schemaVersion: '1.0.0', asOf: '2026-06-04', generatedAt: '2026-06-04T00:00:00.000Z', source: 't', scenario: 'Base' },
    assumptions: { activeScenario: 'Base', revenueFactor: 1, vacancyFactor: 1, exitCapFactor: 1, thresholds: { balloonAlertMonths: 18, concentrationYellow: 0.25, concentrationRed: 0.5 }, asOf: '2026-06-04' },
    properties: [], leases: [], loans: [], deals: [], insurance: [], tasks: [], counterparties: [], dataQuality: [],
    cash: { asOf: '2026-06-04', totalCash: 0, activeEntities: 0, largestEntity: null, concentrationTopPct: null, cagr: null, entities: [], history: [] },
  };
  return { ...base, ...over } as unknown as PortfolioSnapshot;
}
const prop = (o: Record<string, unknown>) => ({ id: 'p1', index: 1, name: 'Prop One', address: null, city: null, state: null, market: 'Columbus OH', type: 'Flex', sf: 1000, tenantCount: 1, occPct: 1, acqDate: null, estValue100: 0, oxfordOwnPct: 1, oxfordValue: 0, grossIncome: 0, expenses: 0, noi: 0, noiScenarioAdj: 0, debtService: 0, netCashFlow: 0, capRate: 0, dscr: 2, lender: null, loanBalance: 0, ltv: 0, valuePerSf: null, rentPerSf: null, equityInvested: 0, cashOnCash: null, holdYrs: null, encumbered: false, flags: [], ...o });
const dealOf = (o: Record<string, unknown>) => ({ id: 'd1', name: 'Deal', shortName: null, location: null, market: null, sf: null, buildings: null, stage: 'LOI/PSA', estPrice: null, capRate: null, irr: null, equityMultiple: null, holdYrs: null, lender: null, status: null, nextAction: null, owner: null, targetCloseDate: null, confidential: false, estimatedFields: [], ...o });

describe('extendedInsights', () => {
  it('flags a property with DSCR below 1.25 (warning, category debt)', () => {
    const out = extendedInsights(snap({ properties: [prop({ id: 'p1', dscr: 1.1 })] as never }), {});
    const hit = out.find((i) => i.id === 'dscr-p1');
    expect(hit?.severity).toBe('warning');
    expect(hit?.category).toBe('debt');
  });

  it('does not flag DSCR when >= 1.25 or null', () => {
    const out = extendedInsights(snap({ properties: [prop({ id: 'p1', dscr: 1.25 }), prop({ id: 'p2', dscr: null })] as never }), {});
    expect(out.some((i) => i.id.startsWith('dscr-'))).toBe(false);
  });

  it('fires an LOI/PSA-deadline warning within 14 days for an LOI/PSA-stage deal', () => {
    const out = extendedInsights(snap({ deals: [dealOf({ id: 'd1', stage: 'LOI/PSA', targetCloseDate: '2026-06-10' })] as never }), {});
    expect(out.find((i) => i.id === 'loi-d1')?.severity).toBe('warning');
  });

  it('ignores LOI/PSA deadline beyond 14 days or with no date', () => {
    const out = extendedInsights(snap({ deals: [dealOf({ id: 'd1', targetCloseDate: '2026-09-01' }), dealOf({ id: 'd2', targetCloseDate: null })] as never }), {});
    expect(out.some((i) => i.id.startsWith('loi-'))).toBe(false);
  });

  it('reports deal-stage movement vs prior stages (info, category deal)', () => {
    const out = extendedInsights(snap({ deals: [dealOf({ id: 'd1', stage: 'Closing' })] as never }), { d1: 'Due Diligence' });
    const hit = out.find((i) => i.id === 'move-d1');
    expect(hit?.severity).toBe('info');
    expect(hit?.category).toBe('deal');
    expect(hit?.detail).toContain('Due Diligence');
    expect(hit?.detail).toContain('Closing');
  });

  it('suppresses movement on the first run (empty prior stages = baseline)', () => {
    const out = extendedInsights(snap({ deals: [dealOf({ id: 'd1', stage: 'Closing' })] as never }), {});
    expect(out.some((i) => i.id.startsWith('move-'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/brief-alerts.test.ts`
Expected: FAIL — `server/brief/alerts.ts` does not exist.

- [ ] **Step 3: Implement**

In `src/analytics/types.ts`, extend `InsightCategory`:

```ts
export type InsightCategory =
  | 'debt'
  | 'lease'
  | 'insurance'
  | 'concentration'
  | 'occupancy'
  | 'cash'
  | 'deal';
```

Create `server/brief/alerts.ts`:

```ts
import type { PortfolioSnapshot } from '../../src/contracts/index';
import type { Insight } from '../../src/analytics/types';
import { generateInsights } from '../../src/analytics/engine';

const DAY_MS = 86_400_000;
function daysUntil(iso: string, asOf: string): number {
  return Math.round((new Date(iso).getTime() - new Date(asOf).getTime()) / DAY_MS);
}

/** Base insights plus brief-only extensions. priorStages: dealId -> stage at last brief. */
export function extendedInsights(s: PortfolioSnapshot, priorStages: Record<string, string>): Insight[] {
  const out: Insight[] = [...generateInsights(s)];
  const asOf = s.meta.asOf;

  // DSCR covenant watch — distress signal only (high LTV is often by design, excluded).
  for (const p of s.properties) {
    if (p.dscr !== null && p.dscr < 1.25) {
      out.push({
        id: `dscr-${p.id}`, severity: 'warning', category: 'debt',
        title: `DSCR below 1.25 — ${p.name}`,
        detail: `Debt-service coverage is ${p.dscr.toFixed(2)}x (covenant watch). Review the loan.`,
        metric: `${p.dscr.toFixed(2)}x`, entityType: 'property', entityId: p.id,
      });
    }
  }

  // 91–180 day lease heads-up (info tier; the <=90d warning lives in generateInsights).
  for (const l of s.leases) {
    if (l.monthsToExpiry !== null && l.monthsToExpiry > 3 && l.monthsToExpiry <= 6) {
      out.push({
        id: `lease180-${l.id}`, severity: 'info', category: 'lease',
        title: `Lease expiring in <6 months — ${l.company ?? l.tenantName}`,
        detail: `${l.propertyKey} ${l.unit ?? ''} expires ${l.leaseEnd ?? ''}. Begin renewal planning.`,
        entityType: 'lease', entityId: l.id,
      });
    }
  }

  // LOI/PSA deadline within 14 days for deals in the LOI/PSA stage.
  for (const d of s.deals) {
    if (d.stage === 'LOI/PSA' && d.targetCloseDate) {
      const days = daysUntil(d.targetCloseDate, asOf);
      if (days >= 0 && days <= 14) {
        out.push({
          id: `loi-${d.id}`, severity: 'warning', category: 'deal',
          title: `LOI/PSA deadline — ${d.shortName ?? d.name}`,
          detail: `Target close ${d.targetCloseDate} (${days}d). ${d.nextAction ?? 'Confirm next step.'}`,
          metric: `${days}d`, entityType: 'deal', entityId: d.id,
        });
      }
    }
  }

  // Deal-stage movement since last brief. Empty priorStages = first run → baseline, no noise.
  if (Object.keys(priorStages).length > 0) {
    for (const d of s.deals) {
      const from = priorStages[d.id];
      if (from !== undefined && from !== d.stage) {
        out.push({
          id: `move-${d.id}`, severity: 'info', category: 'deal',
          title: `Deal advanced — ${d.shortName ?? d.name}`,
          detail: `${from} → ${d.stage}. ${d.nextAction ?? ''}`.trim(),
          entityType: 'deal', entityId: d.id,
        });
      }
    }
  }

  const rank: Record<Insight['severity'], number> = { critical: 0, warning: 1, info: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/brief-alerts.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/analytics/types.ts server/brief/alerts.ts tests/unit/brief-alerts.test.ts
git commit -m "feat(brief): extended alerts (DSCR<1.25, 180d lease, LOI/PSA deadline, stage movement)"
```

---

### Task 3: Alert state + dedup + scheduling gate (`server/brief/state.ts`)

**Files:**
- Create: `server/brief/state.ts`
- Test: `tests/unit/brief-state.test.ts`

- [ ] **Step 1: Write the failing test** — `tests/unit/brief-state.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { diffCriticalAlerts, shouldSendBrief, etNow, type AlertState } from '../../server/brief/state';

const emptyState: AlertState = { alertedCriticalIds: [], lastBriefDate: null, dealStages: {} };

describe('diffCriticalAlerts', () => {
  it('alerts only newly-appeared critical ids', () => {
    const r = diffCriticalAlerts(['a', 'b'], { ...emptyState, alertedCriticalIds: ['a'] });
    expect(r.toAlert).toEqual(['b']);
  });
  it('drops resolved ids so a recurrence re-alerts later', () => {
    const r = diffCriticalAlerts(['b'], { ...emptyState, alertedCriticalIds: ['a', 'b'] });
    expect(r.nextAlerted).toEqual(['b']); // 'a' resolved → cleared
  });
  it('no re-alert when nothing changed', () => {
    const r = diffCriticalAlerts(['a'], { ...emptyState, alertedCriticalIds: ['a'] });
    expect(r.toAlert).toEqual([]);
  });
});

describe('shouldSendBrief (06:45 ET, once per ET day)', () => {
  it('fires at/after 06:45 when not yet sent today', () => {
    expect(shouldSendBrief({ ...emptyState, lastBriefDate: '2026-06-03' }, { date: '2026-06-04', minutes: 405 })).toBe(true);
  });
  it('does not fire before 06:45', () => {
    expect(shouldSendBrief({ ...emptyState, lastBriefDate: '2026-06-03' }, { date: '2026-06-04', minutes: 404 })).toBe(false);
  });
  it('does not fire twice the same ET day', () => {
    expect(shouldSendBrief({ ...emptyState, lastBriefDate: '2026-06-04' }, { date: '2026-06-04', minutes: 600 })).toBe(false);
  });
});

describe('etNow', () => {
  it('returns an ET YYYY-MM-DD date and minutes-since-midnight', () => {
    const r = etNow(new Date('2026-06-04T12:00:00Z')); // noon UTC = 08:00 ET (EDT)
    expect(r.date).toBe('2026-06-04');
    expect(r.minutes).toBe(8 * 60);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/brief-state.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement** — `server/brief/state.ts`:

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface AlertState {
  alertedCriticalIds: string[];
  lastBriefDate: string | null; // ET YYYY-MM-DD
  dealStages: Record<string, string>; // dealId -> stage, snapshotted at last brief
}

const STATE_PATH = process.env.ALERT_STATE_PATH ?? 'data/alert-state.json';
const BRIEF_MINUTE = 6 * 60 + 45; // 06:45 ET

export function loadState(path = STATE_PATH): AlertState {
  try {
    if (existsSync(path)) {
      const j = JSON.parse(readFileSync(path, 'utf8')) as Partial<AlertState>;
      return { alertedCriticalIds: j.alertedCriticalIds ?? [], lastBriefDate: j.lastBriefDate ?? null, dealStages: j.dealStages ?? {} };
    }
  } catch { /* corrupt → fresh state */ }
  return { alertedCriticalIds: [], lastBriefDate: null, dealStages: {} };
}

export function saveState(state: AlertState, path = STATE_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2));
}

/** Which critical ids are newly appeared, and the set to persist (resolved ones dropped). */
export function diffCriticalAlerts(currentCriticalIds: string[], state: AlertState): { toAlert: string[]; nextAlerted: string[] } {
  const already = new Set(state.alertedCriticalIds);
  return {
    toAlert: currentCriticalIds.filter((id) => !already.has(id)),
    nextAlerted: [...currentCriticalIds],
  };
}

export function shouldSendBrief(state: AlertState, now: { date: string; minutes: number }): boolean {
  return now.minutes >= BRIEF_MINUTE && state.lastBriefDate !== now.date;
}

/** ET date (YYYY-MM-DD) + minutes since ET midnight. Injectable clock for tests. */
export function etNow(now: Date = new Date()): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const hour = get('hour') === '24' ? '00' : get('hour'); // Intl can emit 24 at midnight
  return { date: `${get('year')}-${get('month')}-${get('day')}`, minutes: Number(hour) * 60 + Number(get('minute')) };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/brief-state.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/brief/state.ts tests/unit/brief-state.test.ts
git commit -m "feat(brief): alert-state persistence, dedup diff, and 06:45-ET brief gate"
```

---

### Task 4: Deterministic email rendering (`server/brief/render.ts`)

**Files:**
- Create: `server/brief/render.ts`
- Test: `tests/unit/brief-render.test.ts`

- [ ] **Step 1: Write the failing test** — `tests/unit/brief-render.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { Insight } from '../../src/analytics/types';
import { renderBrief, renderAlert } from '../../server/brief/render';

const insight = (o: Partial<Insight>): Insight => ({ id: 'x', severity: 'critical', category: 'debt', title: 'T', detail: 'D', ...o });

describe('renderBrief', () => {
  const out = renderBrief({
    asOf: '2026-06-04', freshness: 'live',
    insights: [insight({ id: 'a', severity: 'critical', title: 'Balloon due — X', detail: '$1M' })],
    criticalDates: [{ date: '2026-06-20', label: 'Expiration: REDACTED-659', days: 16 }],
    dealCounts: [{ stage: 'LOI/PSA', count: 2 }],
    kpis: { noi: '$3.9M', value: '$59.6M', occupancy: '94%', cash: '$7.8M', dscrSummary: 'min 1.10x' },
    tasks: [{ label: 'Send estoppel', status: 'overdue' }],
    dashboardUrl: 'https://ora-command-center.pages.dev',
  });
  it('includes a dated subject', () => expect(out.subject).toContain('2026-06-04'));
  it('renders the action-items section with the alert title', () => expect(out.html).toContain('Balloon due — X'));
  it('renders the critical-dates section', () => { expect(out.html).toContain('Critical dates'); expect(out.html).toContain('Expiration: REDACTED-659'); });
  it('renders the portfolio at-a-glance figures', () => { expect(out.html).toContain('$3.9M'); expect(out.html).toContain('94%'); });
  it('links to the live dashboard', () => expect(out.html).toContain('https://ora-command-center.pages.dev'));
});

describe('renderAlert', () => {
  it('renders a single-item critical email with a CRITICAL subject', () => {
    const out = renderAlert(insight({ title: 'Policy cancelled — Y', detail: 'Bind coverage' }));
    expect(out.subject).toMatch(/CRITICAL/);
    expect(out.html).toContain('Policy cancelled — Y');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/brief-render.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement** — `server/brief/render.ts`. ORA palette inline (email-safe), sections from the spec:

```ts
import type { Insight } from '../../src/analytics/types';

export interface BriefInput {
  asOf: string;
  freshness: string;
  insights: Insight[];
  criticalDates: { date: string; label: string; days: number }[];
  dealCounts: { stage: string; count: number }[];
  kpis: { noi: string; value: string; occupancy: string; cash: string; dscrSummary: string };
  tasks: { label: string; status: string }[];
  dashboardUrl: string;
}
export interface Email { subject: string; html: string }

const NAVY = '#1B2A4A', GOLD = '#C9A96E', CREAM = '#F5F0E8', INK = '#222';
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const sevColor = (s: Insight['severity']) => (s === 'critical' ? '#B3261E' : s === 'warning' ? GOLD : '#5A6B8C');

function section(title: string, body: string): string {
  return `<tr><td style="padding:18px 24px 4px;font:600 13px DM Sans,Arial,sans-serif;letter-spacing:.04em;text-transform:uppercase;color:${NAVY}">${esc(title)}</td></tr><tr><td style="padding:0 24px 8px;font:14px/1.5 Georgia,serif;color:${INK}">${body}</td></tr>`;
}

function alertRows(insights: Insight[]): string {
  if (insights.length === 0) return '<em>No open items.</em>';
  return insights.map((i) =>
    `<div style="border-left:3px solid ${sevColor(i.severity)};padding:6px 10px;margin:6px 0;background:${CREAM}">
      <strong>${esc(i.title)}</strong>${i.metric ? ` <span style="color:${NAVY}">· ${esc(i.metric)}</span>` : ''}<br>
      <span style="font-size:13px;color:#444">${esc(i.detail)}</span></div>`).join('');
}

function dateRows(items: { date: string; label: string; days: number }[]): string {
  if (!items.length) return '<em>Nothing in the next 90 days.</em>';
  return `<ul style="margin:4px 0;padding-left:18px">${items.map((i) =>
    `<li>${esc(i.date)} — ${esc(i.label)} <span style="color:#999">(${i.days}d)</span></li>`).join('')}</ul>`;
}

export function renderBrief(b: BriefInput): Email {
  const deals = b.dealCounts.map((d) => `${esc(d.stage)}: <strong>${d.count}</strong>`).join(' &nbsp;·&nbsp; ') || '—';
  const tasks = b.tasks.length ? b.tasks.map((t) => `<li>${esc(t.label)} <span style="color:#999">(${esc(t.status)})</span></li>`).join('') : '<li>None due</li>';
  const kpis = `NOI <strong>${esc(b.kpis.noi)}</strong> &nbsp;·&nbsp; Value <strong>${esc(b.kpis.value)}</strong> &nbsp;·&nbsp; Occupancy <strong>${esc(b.kpis.occupancy)}</strong> &nbsp;·&nbsp; Cash <strong>${esc(b.kpis.cash)}</strong> &nbsp;·&nbsp; DSCR ${esc(b.kpis.dscrSummary)}`;
  const html =
    `<table width="640" cellpadding="0" cellspacing="0" style="margin:0 auto;background:#fff;border:1px solid #e3ddcd">
      <tr><td style="background:${NAVY};padding:18px 24px;color:#fff;font:700 18px DM Sans,Arial,sans-serif">Oxford Command Center — Daily Brief
        <div style="font:400 12px DM Sans,Arial;color:${GOLD};margin-top:2px">As of ${esc(b.asOf)} · data ${esc(b.freshness)}</div></td></tr>
      ${section('Action items', alertRows(b.insights))}
      ${section('Critical dates — next 90 days', dateRows(b.criticalDates))}
      ${section('Deal pipeline', deals)}
      ${section('Portfolio at-a-glance', kpis)}
      ${section('Tasks', `<ul style="margin:4px 0;padding-left:18px">${tasks}</ul>`)}
      <tr><td style="padding:16px 24px;background:${CREAM};font:13px DM Sans,Arial"><a href="${esc(b.dashboardUrl)}" style="color:${NAVY};font-weight:600">Open the live dashboard →</a></td></tr>
    </table>`;
  return { subject: `[ORA Command Center] Daily Brief — ${b.asOf}`, html };
}

export function renderAlert(i: Insight): Email {
  const html =
    `<table width="560" cellpadding="0" cellspacing="0" style="margin:0 auto;background:#fff;border:1px solid #e3ddcd">
      <tr><td style="background:${sevColor(i.severity)};padding:14px 20px;color:#fff;font:700 16px DM Sans,Arial">${i.severity.toUpperCase()} ALERT</td></tr>
      <tr><td style="padding:18px 20px;font:15px/1.6 Georgia,serif;color:${INK}">
        <strong>${esc(i.title)}</strong>${i.metric ? ` · ${esc(i.metric)}` : ''}<br><br>${esc(i.detail)}</td></tr>
    </table>`;
  return { subject: `[ORA Command Center] ${i.severity.toUpperCase()}: ${i.title}`, html };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/brief-render.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/brief/render.ts tests/unit/brief-render.test.ts
git commit -m "feat(brief): deterministic ORA-styled brief + critical-alert email rendering"
```

---

### Task 5: Delivery with fail-loud fallback (`server/brief/send.ts`)

Primary = Outlook COM via the existing PowerShell helper. On failure → write to `data/outbox/` and a health flag (never silent). Composio is documented as the manual escalation (not callable from a headless node bake).

**Files:**
- Create: `server/brief/send.ts`
- Test: `tests/unit/brief-send.test.ts`

- [ ] **Step 0 (verify before coding):** Read `_shared/send-via-outlook.ps1` and confirm its parameter names. The implementation below assumes `-To`, `-Subject`, `-HtmlBody`. If the script uses different names (e.g. `-Body`/`-Html`), adjust the `args` array in `runOutlookCom` to match. Find it: `Get-ChildItem -Recurse -Filter send-via-outlook.ps1` under the workspace, or check `reference_tech.md`.

- [ ] **Step 1: Write the failing test** — `tests/unit/brief-send.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { sendEmail } from '../../server/brief/send';

const out = mkdtempSync(join(tmpdir(), 'brief-'));

describe('sendEmail', () => {
  beforeEach(() => { process.env.BRIEF_OUTBOX_DIR = out; });

  it('reports via "com" when the COM sender succeeds', async () => {
    const r = await sendEmail({ subject: 'S', html: '<p>x</p>' }, ['a@b.com'], { send: async () => true, outboxDir: out });
    expect(r.ok).toBe(true);
    expect(r.via).toBe('com');
  });

  it('falls back to the outbox + flags failure when COM fails', async () => {
    const r = await sendEmail({ subject: 'S', html: '<p>x</p>' }, ['a@b.com'], { send: async () => { throw new Error('com down'); }, outboxDir: out });
    expect(r.ok).toBe(false);
    expect(r.via).toBe('outbox');
    expect(readdirSync(out).some((f) => f.endsWith('.html'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/brief-send.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement** — `server/brief/send.ts`:

```ts
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Email } from './render';

const SEND_SCRIPT = process.env.BRIEF_SEND_SCRIPT ?? '_shared/send-via-outlook.ps1';
const OUTBOX = process.env.BRIEF_OUTBOX_DIR ?? 'data/outbox';

export interface SendResult { ok: boolean; via: 'com' | 'outbox'; error?: string }
interface SendDeps { send?: (email: Email, to: string[]) => Promise<boolean>; outboxDir?: string }

/** Real Outlook COM send via PowerShell. Throws on non-zero exit. */
async function runOutlookCom(email: Email, to: string[]): Promise<boolean> {
  const args = ['-NoProfile', '-File', SEND_SCRIPT, '-To', to.join(';'), '-Subject', email.subject, '-HtmlBody', email.html];
  const r = spawnSync('powershell', args, { encoding: 'utf8', timeout: 60_000 });
  if (r.status !== 0) throw new Error(`Outlook COM exit ${r.status}: ${(r.stderr || '').slice(0, 200)}`);
  return true;
}

function toOutbox(email: Email, dir: string, kind: string): void {
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  writeFileSync(join(dir, `${stamp}-${kind}.html`), `<!-- subject: ${email.subject} -->\n${email.html}`);
}

export async function sendEmail(email: Email, to: string[], deps: SendDeps = {}): Promise<SendResult> {
  const send = deps.send ?? runOutlookCom;
  const outboxDir = deps.outboxDir ?? OUTBOX;
  const kind = email.subject.includes('CRITICAL') ? 'alert' : 'brief';
  try {
    await send(email, to);
    return { ok: true, via: 'com' };
  } catch (e) {
    toOutbox(email, outboxDir, kind);
    return { ok: false, via: 'outbox', error: e instanceof Error ? e.message : String(e) };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/brief-send.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/brief/send.ts tests/unit/brief-send.test.ts
git commit -m "feat(brief): Outlook COM delivery with fail-loud outbox fallback"
```

---

### Task 6: Orchestrator (`server/brief/run.ts`)

Wires state → extended insights → (brief gate / critical diff) → render → send → persist. Recipients fixed to the two partners. A health-flag file records the last run for System Health.

**Files:**
- Create: `server/brief/run.ts`
- Test: `tests/unit/brief-run.test.ts`

- [ ] **Step 1: Write the failing test** — `tests/unit/brief-run.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PortfolioSnapshot } from '../../src/contracts/index';
import { runBrief } from '../../server/brief/run';

const dir = () => mkdtempSync(join(tmpdir(), 'run-'));
function baseSnap(): PortfolioSnapshot {
  return {
    meta: { schemaVersion: '1.0.0', asOf: '2026-06-04', generatedAt: '2026-06-04T00:00:00Z', source: 't', scenario: 'Base' },
    assumptions: { activeScenario: 'Base', revenueFactor: 1, vacancyFactor: 1, exitCapFactor: 1, thresholds: { balloonAlertMonths: 18, concentrationYellow: 0.25, concentrationRed: 0.5 }, asOf: '2026-06-04' },
    properties: [], leases: [], loans: [], deals: [], insurance: [], tasks: [], counterparties: [], dataQuality: [],
    cash: { asOf: '2026-06-04', totalCash: 0, activeEntities: 0, largestEntity: null, concentrationTopPct: null, cagr: null, entities: [], history: [] },
  } as unknown as PortfolioSnapshot;
}

describe('runBrief', () => {
  it('sends the brief once when the gate is open and records lastBriefDate', async () => {
    const statePath = join(dir(), 'state.json');
    const sent: string[] = [];
    const res = await runBrief(baseSnap(), {
      statePath, now: new Date('2026-06-04T11:00:00Z'), // 07:00 ET
      send: async (email) => { sent.push(email.subject); return { ok: true, via: 'com' }; },
    });
    expect(res.briefSent).toBe(true);
    expect(sent.some((s) => s.includes('Daily Brief'))).toBe(true);
    // Second run same ET day → no second brief.
    const res2 = await runBrief(baseSnap(), { statePath, now: new Date('2026-06-04T15:00:00Z'), send: async () => ({ ok: true, via: 'com' }) });
    expect(res2.briefSent).toBe(false);
  });

  it('emits a same-day alert only for a newly-appeared critical item', async () => {
    const statePath = join(dir(), 'state.json');
    const snap = baseSnap();
    (snap.insurance as unknown[]) = [{ id: 'i1', property: 'P', coverage: 'GL', carrier: 'C', expires: null, premium: 0, daysToExpiry: null, status: 'Cancelled', notes: null, flags: [] }];
    const subjects: string[] = [];
    const send = async (email: { subject: string }) => { subjects.push(email.subject); return { ok: true as const, via: 'com' as const }; };
    await runBrief(snap, { statePath, now: new Date('2026-06-04T01:00:00Z'), send }); // pre-06:45 → no brief, alert fires
    expect(subjects.some((s) => s.includes('CRITICAL'))).toBe(true);
    subjects.length = 0;
    await runBrief(snap, { statePath, now: new Date('2026-06-04T02:00:00Z'), send }); // same critical → deduped
    expect(subjects.some((s) => s.includes('CRITICAL'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/brief-run.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement** — `server/brief/run.ts`:

```ts
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PortfolioSnapshot } from '../../src/contracts/index';
import { buildAnalytics } from '../../src/analytics/engine';
import { extendedInsights } from './alerts';
import { loadState, saveState, diffCriticalAlerts, shouldSendBrief, etNow, type AlertState } from './state';
import { renderBrief, renderAlert, type Email } from './render';
import { sendEmail, type SendResult } from './send';
import { fmtUsdCompact } from '../../src/analytics/format';

const DAY_MS = 86_400_000;

const RECIPIENTS = ['ggoldberg@oxfordra.net', 'egoldberg@oxfordra.net'];
const DASHBOARD_URL = process.env.BRIEF_DASHBOARD_URL ?? 'https://ora-command-center.pages.dev';
const HEALTH_PATH = process.env.BRIEF_HEALTH_PATH ?? 'data/brief-health.json';

interface RunDeps {
  statePath?: string;
  now?: Date;
  send?: (email: Email, to: string[]) => Promise<SendResult>;
}

export async function runBrief(snapshot: PortfolioSnapshot, deps: RunDeps = {}): Promise<{ briefSent: boolean; alertsSent: number }> {
  const now = deps.now ?? new Date();
  const send = deps.send ?? ((e: Email, to: string[]) => sendEmail(e, to));
  const state: AlertState = loadState(deps.statePath);

  const insights = extendedInsights(snapshot, state.dealStages);
  const criticalIds = insights.filter((i) => i.severity === 'critical').map((i) => i.id);
  const { toAlert, nextAlerted } = diffCriticalAlerts(criticalIds, state);

  // Same-day critical alerts (deduped).
  let alertsSent = 0;
  const failures: string[] = [];
  for (const id of toAlert) {
    const ins = insights.find((i) => i.id === id)!;
    const r = await send(renderAlert(ins), RECIPIENTS);
    if (r.ok) alertsSent++; else failures.push(`alert ${id}: ${r.error ?? r.via}`);
  }

  // Daily brief (once per ET day at/after 06:45).
  const nowEt = etNow(now);
  let briefSent = false;
  if (shouldSendBrief(state, nowEt)) {
    const a = buildAnalytics(snapshot, 'Base');
    const dscrs = snapshot.properties.map((p) => p.dscr).filter((d): d is number => d !== null);
    const dealCounts = countByStage(snapshot);
    const criticalDates = upcomingDates(snapshot, a.criticalDates);
    const r = await send(renderBrief({
      asOf: snapshot.meta.asOf,
      freshness: snapshot.dataQuality.length ? 'has data-quality flags' : 'clean',
      insights,
      criticalDates,
      dealCounts,
      kpis: {
        noi: a.kpis.noi.display ?? '—', value: a.kpis.value.display ?? '—', occupancy: a.kpis.occupancy.display ?? '—',
        cash: fmtUsdCompact(snapshot.cash.totalCash),
        dscrSummary: dscrs.length ? `min ${Math.min(...dscrs).toFixed(2)}x` : '—',
      },
      tasks: snapshot.tasks.filter((t) => t.status === 'overdue' || t.status === 'pending').slice(0, 12).map((t) => ({ label: t.label, status: t.status })),
      dashboardUrl: DASHBOARD_URL,
    }), RECIPIENTS);
    if (r.ok) { briefSent = true; state.lastBriefDate = nowEt.date; state.dealStages = Object.fromEntries(snapshot.deals.map((d) => [d.id, d.stage])); }
    else failures.push(`brief: ${r.error ?? r.via}`);
  }

  state.alertedCriticalIds = nextAlerted;
  saveState(state, deps.statePath);
  writeHealth({ ranAt: now.toISOString(), briefSent, alertsSent, failures });
  return { briefSent, alertsSent };
}

function countByStage(s: PortfolioSnapshot): { stage: string; count: number }[] {
  const m = new Map<string, number>();
  for (const d of s.deals) m.set(d.stage, (m.get(d.stage) ?? 0) + 1);
  return [...m.entries()].map(([stage, count]) => ({ stage, count }));
}

/** Forward calendar (≤90d): lease dates + loan maturities + deal target-close dates. */
function upcomingDates(
  s: PortfolioSnapshot,
  leaseDates: { date: string; daysToDate: number; kind: string; tenant: string }[],
): { date: string; label: string; days: number }[] {
  const fromLeases = leaseDates
    .filter((c) => c.daysToDate >= 0 && c.daysToDate <= 90)
    .map((c) => ({ date: c.date, label: `${c.kind}: ${c.tenant}`, days: c.daysToDate }));
  const fromLoans = s.loans
    .filter((l) => l.maturity && l.monthsToMaturity !== null && l.monthsToMaturity >= 0 && l.monthsToMaturity <= 3)
    .map((l) => ({ date: l.maturity as string, label: `Loan maturity: ${l.name}`, days: Math.round((l.monthsToMaturity ?? 0) * 30) }));
  const fromDeals = s.deals
    .filter((d) => d.targetCloseDate)
    .map((d) => ({ date: d.targetCloseDate as string, label: `Target close: ${d.shortName ?? d.name}`, days: Math.round((new Date(d.targetCloseDate as string).getTime() - new Date(s.meta.asOf).getTime()) / DAY_MS) }))
    .filter((x) => x.days >= 0 && x.days <= 90);
  return [...fromLeases, ...fromLoans, ...fromDeals].sort((a, b) => a.days - b.days);
}

function writeHealth(h: object): void {
  try { mkdirSync(dirname(HEALTH_PATH), { recursive: true }); writeFileSync(HEALTH_PATH, JSON.stringify(h, null, 2)); } catch { /* non-fatal */ }
}
```

- [ ] **Step 3a: Verify formatter names.** Confirm `fmtUsdCompact` and `fmtPct` are exported from `src/analytics/format` and that `Cell` has a `.display` field. If the export names differ, adjust the imports (check `src/analytics/format.ts` and the `Cell` type in `src/contracts/common.ts`). Adjust `a.kpis.*.display` if the field is named differently (e.g. `.formatted`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/brief-run.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/brief/run.ts tests/unit/brief-run.test.ts
git commit -m "feat(brief): orchestrator — brief gate + critical-alert dedup + health flag"
```

---

### Task 7: Wire into the bake + ignore state/outbox

**Files:**
- Modify: `scripts/bake-mirror.ts`
- Modify: `.gitignore`

- [ ] **Step 1: Implement** — in `scripts/bake-mirror.ts`, after `const { snapshot: raw } = await parseWorkbook(WORKBOOK_PATH);` and before the redaction line, add (the brief uses the FULL snapshot — internal email):

```ts
  if (process.env.BRIEF_ENABLED === '1') {
    const { runBrief } = await import('../server/brief/run');
    const r = await runBrief(raw);
    console.log(`  Brief: sent=${r.briefSent}, alerts=${r.alertsSent}`);
  }
```

In `.gitignore`, add:

```
data/alert-state.json
data/outbox/
data/brief-health.json
```

- [ ] **Step 2: Verify typecheck + full gate**

Run: `npm run gate`
Expected: typecheck clean, lint clean, all tests pass, reconcile $0.

- [ ] **Step 3: Dry-run the brief to the outbox (no real send).** This proves end-to-end rendering against the live workbook without emailing:

Run (PowerShell): `$env:BRIEF_ENABLED='1'; $env:BRIEF_SEND_SCRIPT='nonexistent.ps1'; npx tsx scripts/bake-mirror.ts`
Expected: console shows `Brief: sent=...`; a `.html` file appears in `data/outbox/` (COM fails → outbox fallback). Open it and visually confirm the sections render with real figures. Then delete the outbox file.

- [ ] **Step 4: Commit**

```bash
git add scripts/bake-mirror.ts .gitignore
git commit -m "feat(brief): run brief/alerts inside the bake behind BRIEF_ENABLED"
```

---

### Task 8: Schedule — hourly + 06:45 ET trigger, brief enabled

**Files:**
- Modify: `scripts/register-mirror-task.ps1`

- [ ] **Step 1: Read the current script** to learn how the trigger + action are defined (`Get-Content scripts/register-mirror-task.ps1`). It currently registers a single daily 06:30 trigger.

- [ ] **Step 2: Implement** — change the trigger to **two** triggers (hourly repetition + an explicit daily 06:45) and ensure the action's environment includes `BRIEF_ENABLED=1`. Replace the single-trigger block with:

```powershell
# Hourly all day + a guaranteed 06:45 ET brief trigger. The lastBriefDate gate makes the brief fire once/day.
$hourly = New-ScheduledTaskTrigger -Once -At 12:00am -RepetitionInterval (New-TimeSpan -Hours 1) -RepetitionDuration (New-TimeSpan -Days 3650)
$morning = New-ScheduledTaskTrigger -Daily -At 6:45am
$triggers = @($hourly, $morning)
```

Then pass `-Trigger $triggers` to `Register-ScheduledTask` (replacing the old single `$trigger`). Ensure the action runs the deploy script with `BRIEF_ENABLED=1` set — if the action calls `deploy-mirror.ps1`, add `$env:BRIEF_ENABLED='1'` at the top of `deploy-mirror.ps1`, or set it inside the `-Argument` the action runs. (Confirm where the bake is invoked and set the env var there.)

- [ ] **Step 3: Verify the script parses (dry, no register).** Run with the actual register line temporarily commented, or run `powershell -NoProfile -Command "& { . ./scripts/register-mirror-task.ps1 }"` in a scratch copy. Confirm no syntax errors and `$triggers` builds.

- [ ] **Step 4: Commit**

```bash
git add scripts/register-mirror-task.ps1 scripts/deploy-mirror.ps1
git commit -m "chore(schedule): hourly bake + 06:45 ET brief trigger, BRIEF_ENABLED"
```

- [ ] **Step 5 (manual, operator):** Re-register the task by running `scripts/register-mirror-task.ps1` under pwsh, then confirm with `Get-ScheduledTask -TaskName 'ORA Command Center - Mirror Deploy'` that both triggers exist. (This is an operator action — not part of automated execution.)

---

### Task 9: Surface send health in System Health

**Files:**
- Modify: `server/index.ts` (the `/api/health` route)
- Modify: `src/modules/health/HealthModule.tsx`

- [ ] **Step 1: Read** `server/index.ts` `/api/health` handler and `HealthModule.tsx` to match existing shape/patterns.

- [ ] **Step 2: Implement** — in `/api/health`, read `data/brief-health.json` if present and include it as `brief: { ranAt, briefSent, alertsSent, failures }` (omit/`null` when absent). In `HealthModule.tsx`, add a "Daily brief" row showing last-run time, brief/alert counts, and any `failures` in a warning tone.

```ts
// server/index.ts — inside the /api/health JSON
import { existsSync, readFileSync } from 'node:fs';
const briefHealth = existsSync('data/brief-health.json')
  ? JSON.parse(readFileSync('data/brief-health.json', 'utf8'))
  : null;
// add `brief: briefHealth` to the response object
```

- [ ] **Step 3: Verify gate**

Run: `npm run gate`
Expected: green (typecheck includes `functions/` + server + client).

- [ ] **Step 4: Commit**

```bash
git add server/index.ts src/modules/health/HealthModule.tsx
git commit -m "feat(health): surface daily-brief run status + send failures"
```

---

## Final verification

- [ ] `npm run gate` green (target ~100+ tests; reconcile $0; bundle unaffected — all new code is server-only).
- [ ] Dry-run outbox HTML reviewed (Task 7 Step 3).
- [ ] Push: `git push origin main`; confirm CI green.
- [ ] Operator: re-register the scheduled task (Task 8 Step 5) and confirm the first live brief next morning + that a forced critical de-dupes across two consecutive hourly bakes.
