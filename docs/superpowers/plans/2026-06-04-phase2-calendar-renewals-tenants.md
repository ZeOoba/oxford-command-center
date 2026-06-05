# Command Center Phase 2 — Calendar · Renewals · Tenants Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship three spine-derived operational modules — a 12-month **Critical Dates Calendar** (`/calendar`), a 75-day **Lease Renewal Pipeline** kanban (`/renewals`), and a **Tenant Scorecard** (`/tenants`) — each registered in the rail, each with its pure data-shaping logic unit-tested, and the two write-back modules persisting through the existing `data/overlay.json` overlay.

**Architecture:** Pure selectors live under `src/brain/` (`critical-dates.ts`, `renewals.ts`, `tenants.ts`), mirroring `src/brain/alerts-view.ts` — fixture-tested, no React, server-importable. Calendar is read-only (no overlay). Renewals and Tenants extend the overlay exactly like `dealStages`: a new additive key in `server/overlay.ts`, merged in `applyOverlay`, surfaced as a new top-level field on `PortfolioSnapshot` (so the static mirror reads it from the baked snapshot), written via a new `POST /api/actions/*` endpoint + a `brain` mutator. The workbook stays canonical/read-only; the overlay is the only write surface.

**Tech Stack:** React 19, TypeScript (`noUncheckedIndexedAccess` ON), Zod, @tanstack/react-query, Hono (server), Vitest, Tailwind v4, Lucide icons.

**Three independent tracks, one branch (`feat/cc-phase2-calendar-renewals-tenants`).** Each track ends gate-green and is independently shippable. Recommended order: **A (Calendar) → B (Renewals) → C (Tenants)** — Calendar is simplest/highest-value and touches no shared files; B and C each add one additive overlay key.

## Key facts learned from the codebase (read before starting)

- **Modules** consume data via `useSnapshot()` (raw `data.snapshot`) and/or `useAnalytics()` (`analytics.*` bundle) from `src/data/queries.ts`, plus `useUi()` from `src/brain/ui-context.ts`. Deep-link to the entity drawer with `ui.openEntity({ type, id })`. Open a draft email with `ui.openDraft({ kind: 'renewal', entity: { type: 'lease', id } })`.
- **Primitives:** `Card`/`CardHeader` (`src/primitives/Card`), `KpiStat` (`src/primitives/KpiStat`), `DataTable` + `Column<T>` (`src/primitives/DataTable`), `Badge` + `BadgeTone` (`'neutral'|'gold'|'green'|'amber'|'red'|'blue'|'purple'`), `Button`. Formatters from `@analytics/index`: `fmtUsd`, `fmtUsdCompact`, `fmtPct`, `fmtNum`, `fmtSf`, `fmtDate`, `fmtMonths`.
- **Overlay pattern** (`server/overlay.ts`): `Overlay` interface + `EMPTY_OVERLAY` + `loadOverlay()` (reads each key with `?? default`) + `applyOverlay(s, o)` (pure merge, **never mutates base**). `server/brain.ts` holds `this.overlay`, exposes mutators (`setDealStage`) that update the overlay key and call `this.rederive(...)`. Endpoints in `server/index.ts` parse the body, call the mutator, return `{ ok, state }`. Client wrappers in `src/data/actions.ts` `POST` to `/api/actions/*`.
- **Snapshot field additions are safe:** `parse.ts:518` builds the snapshot via `PortfolioSnapshot.parse({...})`, so a new field declared `.default({})` is optional on input and fills automatically — **no parse.ts edit required**. `applyOverlay` overrides the field from the overlay. The baked mirror snapshot therefore carries the overlay data (read-only on the mirror; writes require the live Brain Server, exactly like `dealStages`).
- **Leases have no `tenantId`.** Tenant identity is `company ?? tenantName` (as in `topTenants`). We derive a stable slug id from that string for overlay note keys.
- **The Acquisitions module is a *table*, not a kanban** (`src/modules/acquisitions/AcquisitionsModule.tsx`). There is no existing kanban primitive. The Renewals kanban is therefore net-new, built from `Card` + CSS-var styling; "mirrors Acquisitions Pipeline" refers to the stage-advance + draft-CTA *mechanism*, which we reuse.
- **`data/` is gitignored** (`data/overlay.json` already ignored). No new gitignore entry needed (the overlay file is the same file).
- **Engine `criticalDates()`** (`src/analytics/engine.ts`) covers **leases only** (Expiration/Notice/Escalation). The Calendar aggregator is a superset that also folds in loan maturities and insurance renewals; it is a new module-facing function, not a replacement.

## File Structure

| File | Track | Responsibility |
|---|---|---|
| `src/brain/critical-dates.ts` (create) | A | Pure: `portfolioCriticalDates(snapshot, horizonMonths)` → `DatedEvent[]` across leases/loans/insurance/escalations; `criticalDateKpis(events)` counts |
| `src/modules/calendar/CalendarModule.tsx` (create) | A | KPI strip + type/window filters + month-grouped, color-coded list; rows deep-link |
| `tests/unit/critical-dates.test.ts` (create) | A | Aggregation, horizon windowing, overdue retention, KPI counts, month grouping |
| `src/contracts/renewal.ts` (create) | B | Zod `RenewalStage` enum, `RENEWAL_STAGES`, `nextRenewalStage`, `RenewalStageInput` |
| `src/contracts/index.ts` (modify) | B+C | Re-export `renewal.ts`; add `renewalStages` + `tenantNotes` fields to `PortfolioSnapshot` |
| `server/overlay.ts` (modify) | B+C | Add `renewalStages` + `tenantNotes` overlay keys; merge in `applyOverlay`; `nextRenewalStage` not needed here |
| `server/brain.ts` (modify) | B+C | `setRenewalStage(leaseId, stage)`, `setTenantNote(tenantId, note)` |
| `server/index.ts` (modify) | B+C | `POST /api/actions/renewal-stage`, `POST /api/actions/tenant-note` |
| `src/data/actions.ts` (modify) | B+C | `advanceRenewalStage(...)`, `saveTenantNote(...)` client wrappers |
| `src/brain/renewals.ts` (create) | B | Pure: `RENEWAL_WINDOW_DAYS`, `renewalBoard(snapshot)` → `Record<RenewalStage, RenewalCard[]>` |
| `src/modules/renewals/RenewalsModule.tsx` (create) | B | 5-column kanban; per-card advance + draft CTA |
| `tests/unit/renewals.test.ts` (create) | B | 75-day window, holdover inclusion, out-of-window-with-stage, grouping, default Expiring |
| `src/brain/tenants.ts` (create) | C | Pure: `tenantSlug`, `tenantScorecards(snapshot)` → rollup w/ pro-rata `pctNoi`, null health |
| `src/modules/tenants/TenantsModule.tsx` (create) | C | Sortable table (% NOI bar, Health "—") + selected-tenant detail panel w/ notes |
| `tests/unit/tenants.test.ts` (create) | C | Rollup, pro-rata NOI (linked + unlinked fallback), expiry, stage rollup, notes join |
| `tests/unit/overlay.test.ts` (modify) | B+C | `applyOverlay` merges `renewalStages` + `tenantNotes`; base unmutated |
| `src/shell/modules.tsx` (modify) | A+B+C | Lazy import + `MODULES` entry for each (Calendar/Renewals → Command, Tenants → Assets) |

---

# TRACK A — Critical Dates Calendar (`/calendar`)

## Task A1: Pure calendar aggregator

**Files:**
- Create: `src/brain/critical-dates.ts`
- Test: `tests/unit/critical-dates.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/critical-dates.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import type { PortfolioSnapshot } from '../../src/contracts/index';
import { portfolioCriticalDates, criticalDateKpis } from '../../src/brain/critical-dates';

const ASOF = '2026-06-04';
const day = (iso: string) => iso;

// Minimal snapshot — only the fields the aggregator reads. Cast through unknown.
const snap = {
  meta: { asOf: ASOF },
  leases: [
    // expiring in ~50 days
    { id: 'L1', company: 'Acme', tenantName: 'Acme LLC', propertyKey: '100 A', unit: '1', annualRent: 120000, leaseEnd: '2026-07-24', escalationDate: null },
    // overdue holdover (expired 30 days ago) — kept
    { id: 'L2', company: null, tenantName: 'Beta', propertyKey: '200 B', unit: null, annualRent: 60000, leaseEnd: '2026-05-05', escalationDate: null },
    // escalation in ~100 days — kept; expiry far out (800d) — dropped
    { id: 'L3', company: 'Gamma', tenantName: 'Gamma', propertyKey: '300 C', unit: '2', annualRent: 90000, leaseEnd: '2028-08-12', escalationDate: '2026-09-12' },
  ],
  loans: [
    // maturity in ~120 days
    { id: 'LN1', name: 'Rarig note', maturity: '2026-10-02', absBalance: 980000, isDemand: false },
    // demand — no maturity date — dropped
    { id: 'LN2', name: 'Demand', maturity: null, absBalance: 50000, isDemand: true },
  ],
  insurance: [
    // renews in ~40 days
    { id: 'INS1', property: '100 A', coverage: 'Property', expires: '2026-07-14', premium: 12000 },
    // expired 10 days ago — kept (overdue)
    { id: 'INS2', property: '200 B', coverage: 'GL', expires: '2026-05-25', premium: 8000 },
  ],
} as unknown as PortfolioSnapshot;

describe('portfolioCriticalDates', () => {
  it('aggregates all four event types within a 12-month horizon, dropping far/past-only items', () => {
    const events = portfolioCriticalDates(snap, 12);
    const ids = events.map((e) => e.id);
    expect(ids).toContain('lease-expiry-L1');
    expect(ids).toContain('lease-expiry-L2'); // overdue holdover kept
    expect(ids).toContain('escalation-L3');
    expect(ids).not.toContain('lease-expiry-L3'); // 800d out — beyond horizon
    expect(ids).toContain('loan-maturity-LN1');
    expect(ids).not.toContain('loan-maturity-LN2'); // demand loan, no date
    expect(ids).toContain('insurance-renewal-INS1');
    expect(ids).toContain('insurance-renewal-INS2'); // overdue policy kept
  });

  it('sorts by date ascending and tags a YYYY-MM month key', () => {
    const events = portfolioCriticalDates(snap, 12);
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.daysToDate).toBeGreaterThanOrEqual(events[i - 1]!.daysToDate);
    }
    const ln = events.find((e) => e.id === 'loan-maturity-LN1');
    expect(ln!.monthKey).toBe('2026-10');
    expect(ln!.type).toBe('loan-maturity');
    expect(ln!.entityType).toBe('loan');
    expect(ln!.entityId).toBe('LN1');
  });

  it('honors a tighter horizon (90 days ≈ 3 months)', () => {
    const events = portfolioCriticalDates(snap, 3);
    const ids = events.map((e) => e.id);
    expect(ids).toContain('lease-expiry-L1'); // 50d in
    expect(ids).not.toContain('escalation-L3'); // ~100d out — beyond 3mo
    expect(ids).not.toContain('loan-maturity-LN1'); // ~120d out — beyond 3mo
  });

  it('computes urgency tiers from daysToDate', () => {
    const events = portfolioCriticalDates(snap, 12);
    expect(events.find((e) => e.id === 'lease-expiry-L1')!.urgency).toBe('critical'); // 50d < 60
    expect(events.find((e) => e.id === 'lease-expiry-L2')!.urgency).toBe('critical'); // overdue < 60
    expect(events.find((e) => e.id === 'escalation-L3')!.urgency).toBe('warning'); // ~100d in [60,180)
  });
});

describe('criticalDateKpis', () => {
  it('counts critical (<60d incl. overdue), warning (60–180d), this-quarter (<90d), and next-12mo total', () => {
    const events = portfolioCriticalDates(snap, 12);
    const k = criticalDateKpis(events);
    // critical: L1(50), L2(-30 overdue), INS1(40), INS2(-10 overdue) = 4
    expect(k.critical).toBe(4);
    // warning: esc-L3(~100), loan-LN1(~120) = 2
    expect(k.warning).toBe(2);
    // this-quarter (<90d incl overdue): L1, L2, INS1, INS2 = 4
    expect(k.thisQuarter).toBe(4);
    expect(k.next12mo).toBe(events.length);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/critical-dates.test.ts`
Expected: FAIL — cannot find module `../../src/brain/critical-dates`.

- [ ] **Step 3: Write the implementation**

Create `src/brain/critical-dates.ts`:

```typescript
import type { PortfolioSnapshot } from '../contracts/index';

const DAY_MS = 86_400_000;
const daysBetween = (isoTarget: string, isoFrom: string): number =>
  Math.round((new Date(isoTarget).getTime() - new Date(isoFrom).getTime()) / DAY_MS);

export type CalendarEventType = 'lease-expiry' | 'escalation' | 'loan-maturity' | 'insurance-renewal';
export type CalendarUrgency = 'critical' | 'warning' | 'normal';
export type CalendarEntityType = 'lease' | 'loan' | 'insurance';

export interface DatedEvent {
  id: string;
  type: CalendarEventType;
  entityType: CalendarEntityType;
  entityId: string;
  title: string; // primary label (tenant / loan / property)
  subtitle: string; // secondary context (property·unit / balance / coverage)
  date: string; // ISO YYYY-MM-DD
  daysToDate: number; // signed — negative is overdue
  monthKey: string; // YYYY-MM, for grouping
  urgency: CalendarUrgency;
  amount: number | null; // rent / balance / premium, for display
}

/** Critical < 60d (incl. overdue), Warning 60–180d, else normal. */
function urgencyOf(daysToDate: number): CalendarUrgency {
  if (daysToDate < 60) return 'critical';
  if (daysToDate < 180) return 'warning';
  return 'normal';
}

/**
 * The portfolio-wide actionable date calendar over a forward horizon (default 12 months).
 * Folds lease expirations + escalations, loan maturities, and insurance renewals into one
 * date-sorted stream. Overdue items (expired leases/policies — i.e. open obligations) are kept;
 * future events beyond the horizon and past-only escalations are dropped.
 */
export function portfolioCriticalDates(s: PortfolioSnapshot, horizonMonths = 12): DatedEvent[] {
  const asOf = s.meta.asOf;
  const horizonDays = Math.round(horizonMonths * 30.4375);
  const within = (days: number) => days <= horizonDays;
  const out: DatedEvent[] = [];

  for (const l of s.leases) {
    const tenant = l.company ?? l.tenantName;
    const where = `${l.propertyKey}${l.unit ? ` · ${l.unit}` : ''}`;
    if (l.leaseEnd) {
      const d = daysBetween(l.leaseEnd, asOf);
      if (within(d)) {
        out.push({
          id: `lease-expiry-${l.id}`, type: 'lease-expiry', entityType: 'lease', entityId: l.id,
          title: tenant, subtitle: where, date: l.leaseEnd, daysToDate: d,
          monthKey: l.leaseEnd.slice(0, 7), urgency: urgencyOf(d), amount: l.annualRent,
        });
      }
    }
    if (l.escalationDate) {
      const d = daysBetween(l.escalationDate, asOf);
      if (d >= 0 && within(d)) {
        out.push({
          id: `escalation-${l.id}`, type: 'escalation', entityType: 'lease', entityId: l.id,
          title: tenant, subtitle: `${where} · escalation`, date: l.escalationDate, daysToDate: d,
          monthKey: l.escalationDate.slice(0, 7), urgency: urgencyOf(d), amount: l.annualRent,
        });
      }
    }
  }

  for (const ln of s.loans) {
    if (ln.isDemand || !ln.maturity) continue;
    const d = daysBetween(ln.maturity, asOf);
    if (within(d)) {
      out.push({
        id: `loan-maturity-${ln.id}`, type: 'loan-maturity', entityType: 'loan', entityId: ln.id,
        title: ln.name, subtitle: 'loan maturity', date: ln.maturity, daysToDate: d,
        monthKey: ln.maturity.slice(0, 7), urgency: urgencyOf(d), amount: ln.absBalance,
      });
    }
  }

  for (const p of s.insurance) {
    if (!p.expires) continue;
    const d = daysBetween(p.expires, asOf);
    if (within(d)) {
      out.push({
        id: `insurance-renewal-${p.id}`, type: 'insurance-renewal', entityType: 'insurance', entityId: p.id,
        title: p.property, subtitle: p.coverage ?? 'coverage', date: p.expires, daysToDate: d,
        monthKey: p.expires.slice(0, 7), urgency: urgencyOf(d), amount: p.premium,
      });
    }
  }

  return out.sort((a, b) => a.daysToDate - b.daysToDate);
}

export interface CriticalDateKpis {
  critical: number; // < 60d, incl. overdue
  warning: number; // 60–180d
  thisQuarter: number; // < 90d, incl. overdue
  next12mo: number; // total in the horizon
}

export function criticalDateKpis(events: DatedEvent[]): CriticalDateKpis {
  let critical = 0;
  let warning = 0;
  let thisQuarter = 0;
  for (const e of events) {
    if (e.daysToDate < 60) critical += 1;
    else if (e.daysToDate < 180) warning += 1;
    if (e.daysToDate < 90) thisQuarter += 1;
  }
  return { critical, warning, thisQuarter, next12mo: events.length };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/critical-dates.test.ts`
Expected: PASS (all critical-dates tests).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/brain/critical-dates.ts tests/unit/critical-dates.test.ts
git commit -m "feat(calendar): pure portfolio critical-dates aggregator + KPIs"
```

---

## Task A2: Calendar module UI

**Files:**
- Create: `src/modules/calendar/CalendarModule.tsx`

- [ ] **Step 1: Write the implementation**

Create `src/modules/calendar/CalendarModule.tsx`:

```tsx
import { useMemo, useState, type CSSProperties } from 'react';
import { CalendarClock } from 'lucide-react';
import { useSnapshot } from '@/data/queries';
import { useUi } from '@/brain/ui-context';
import { fmtUsdCompact, fmtDate } from '@analytics/index';
import { Card, CardHeader } from '@/primitives/Card';
import { KpiStat } from '@/primitives/KpiStat';
import { Badge, type BadgeTone } from '@/primitives/Badge';
import {
  portfolioCriticalDates,
  criticalDateKpis,
  type CalendarEventType,
  type CalendarUrgency,
  type DatedEvent,
} from '@/brain/critical-dates';

const TYPE_LABEL: Record<CalendarEventType, string> = {
  'lease-expiry': 'Lease Expiry',
  escalation: 'Escalation',
  'loan-maturity': 'Loan Maturity',
  'insurance-renewal': 'Insurance Renewal',
};
const TYPE_TONE: Record<CalendarEventType, BadgeTone> = {
  'lease-expiry': 'blue',
  escalation: 'purple',
  'loan-maturity': 'amber',
  'insurance-renewal': 'green',
};
const TYPE_COLOR: Record<CalendarEventType, string> = {
  'lease-expiry': 'var(--color-info)',
  escalation: 'var(--color-accent2)',
  'loan-maturity': 'var(--color-warn)',
  'insurance-renewal': 'var(--color-pos)',
};
const URGENCY_TONE: Record<CalendarUrgency, BadgeTone> = { critical: 'red', warning: 'amber', normal: 'neutral' };
const monthLabel = (key: string) =>
  new Date(`${key}-01T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const dayLabel = (days: number) => (days < 0 ? `${Math.abs(days)}d over` : `${days}d`);

const fieldCls = 'num h-8 rounded-[var(--radius-sm)] px-2.5 text-2xs outline-none';
const fieldStyle: CSSProperties = {
  background: 'color-mix(in oklab, var(--surface-overlay) 60%, transparent)',
  color: 'var(--text-primary)',
  border: '1px solid var(--border-subtle)',
};

type TypeFilter = CalendarEventType | 'all';
type WindowFilter = '90d' | '12mo';

export function CalendarModule() {
  const { data } = useSnapshot();
  const ui = useUi();
  const [type, setType] = useState<TypeFilter>('all');
  const [window, setWindow] = useState<WindowFilter>('12mo');

  const events = useMemo(
    () => (data ? portfolioCriticalDates(data.snapshot, window === '90d' ? 3 : 12) : []),
    [data, window],
  );
  const kpis = useMemo(() => criticalDateKpis(events), [events]);
  const filtered = useMemo(() => (type === 'all' ? events : events.filter((e) => e.type === type)), [events, type]);

  const groups = useMemo(() => {
    const m = new Map<string, DatedEvent[]>();
    for (const e of filtered) {
      const arr = m.get(e.monthKey) ?? [];
      arr.push(e);
      m.set(e.monthKey, arr);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered]);

  if (!data) return null;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiStat label="Critical (<60d)" value={kpis.critical} format={(n) => String(n ?? 0)} accentColor="var(--color-neg)" sublabel="incl. overdue" />
        <KpiStat label="Warning (<180d)" value={kpis.warning} format={(n) => String(n ?? 0)} accentColor="var(--color-warn)" />
        <KpiStat label="This Quarter" value={kpis.thisQuarter} format={(n) => String(n ?? 0)} accentColor="var(--color-info)" sublabel="next 90 days" />
        <KpiStat label="Next 12 Months" value={kpis.next12mo} format={(n) => String(n ?? 0)} accentColor="var(--accent)" />
      </div>

      <Card>
        <CardHeader
          title="Critical Dates"
          trailing={<Badge tone="neutral">{filtered.length} events</Badge>}
        />
        <div className="flex flex-wrap items-center gap-2 px-4 py-2.5" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
          <div className="flex items-center gap-1.5 text-2xs" style={{ color: 'var(--text-tertiary)' }}>
            <CalendarClock size={12} /> <span>Lease, loan, insurance & escalation deadlines</span>
          </div>
          <span className="flex-1" />
          <select aria-label="Filter by event type" value={type} onChange={(e) => setType(e.target.value as TypeFilter)} className={fieldCls} style={fieldStyle}>
            <option value="all">All types</option>
            {(Object.keys(TYPE_LABEL) as CalendarEventType[]).map((t) => (
              <option key={t} value={t}>{TYPE_LABEL[t]}</option>
            ))}
          </select>
          <select aria-label="Filter by window" value={window} onChange={(e) => setWindow(e.target.value as WindowFilter)} className={fieldCls} style={fieldStyle}>
            <option value="12mo">Next 12 months</option>
            <option value="90d">Next 90 days</option>
          </select>
        </div>

        {groups.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm" style={{ color: 'var(--text-tertiary)' }}>
            No critical dates in this window.
          </div>
        ) : (
          <div className="flex flex-col">
            {groups.map(([month, rows]) => (
              <div key={month}>
                <div className="num px-4 py-1.5 text-2xs font-semibold uppercase"
                  style={{ letterSpacing: '0.08em', color: 'var(--text-tertiary)', background: 'var(--surface-raised)', borderBottom: '1px solid var(--border-subtle)' }}>
                  {monthLabel(month)} · {rows.length}
                </div>
                {rows.map((e) => (
                  <button
                    key={e.id}
                    onClick={() => ui.openEntity({ type: e.entityType, id: e.entityId })}
                    className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors"
                    style={{ borderBottom: '1px solid var(--border-subtle)', borderLeft: `2px solid ${TYPE_COLOR[e.type]}` }}
                  >
                    <Badge tone={URGENCY_TONE[e.urgency]}>{dayLabel(e.daysToDate)}</Badge>
                    <span className="num w-20 text-2xs" style={{ color: 'var(--text-tertiary)' }}>{fmtDate(e.date)}</span>
                    <span className="flex-1">
                      <span className="block text-sm" style={{ fontWeight: 600 }}>{e.title}</span>
                      <span className="block text-2xs" style={{ color: 'var(--text-tertiary)' }}>{e.subtitle}</span>
                    </span>
                    <Badge tone={TYPE_TONE[e.type]}>{TYPE_LABEL[e.type]}</Badge>
                    <span className="num w-20 text-right text-2xs" style={{ color: 'var(--text-secondary)' }}>
                      {e.amount !== null ? fmtUsdCompact(e.amount) : '—'}
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors. (If a `--color-*` CSS var name is wrong, it only affects styling, not types; the existing modules use `--color-info`, `--color-warn`, `--color-pos`, `--color-neg`, `--color-accent2`, `--accent` — these are valid.)

- [ ] **Step 3: Commit**

```bash
git add src/modules/calendar/CalendarModule.tsx
git commit -m "feat(calendar): 12-month critical-dates module (KPI strip + grouped list + filters)"
```

---

## Task A3: Register the Calendar module

**Files:**
- Modify: `src/shell/modules.tsx` (lazy-import block ~line 21–34; `lucide-react` import ~line 2–18; `MODULES` array ~line 47–62)

- [ ] **Step 1: Add the Lucide icon import**

In the `lucide-react` import list at the top of `src/shell/modules.tsx`, add `CalendarDays`:

```typescript
  CalendarDays,
```

(Insert it alongside the other icon names, before `type LucideIcon`.)

- [ ] **Step 2: Add the lazy import**

In the lazy-import block, after the `AlertsModule` line, add:

```typescript
const CalendarModule = lazy(() => import('@/modules/calendar/CalendarModule').then((m) => ({ default: m.CalendarModule })));
```

- [ ] **Step 3: Register in MODULES**

In the `MODULES` array, in the `Command` group, immediately **after** the `alerts` entry, add:

```typescript
  { id: 'calendar', label: 'Calendar', icon: CalendarDays, group: 'Command', Component: CalendarModule },
```

- [ ] **Step 4: Typecheck + gate**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

Run: `npm run gate`
Expected: typecheck + lint (`--max-warnings 0`) + tests + reconcile all green.

- [ ] **Step 5: Commit**

```bash
git add src/shell/modules.tsx
git commit -m "feat(calendar): register /calendar module in the rail"
```

---

## Task A4: Verify Calendar end-to-end (fresh server)

- [ ] **Step 1: Start FRESH dev servers**

Kill any running dev server first (stale HMR is a known footgun — the title can update while the body shows a stale module). Then start fresh:

Run (background): `node_modules\.bin\tsx server/index.ts` (Brain Server on :8911)
Run (background): `npx vite --port 5273`

- [ ] **Step 2: Confirm the snapshot endpoint is live**

```bash
curl -s http://localhost:8911/api/health
# Expected: {"ok":true,...}
```

- [ ] **Step 3: Verify the module in a clean browser session**

Using the preview tools: navigate to the app, click the **Calendar** item in the Command group of the rail.
- Confirm the KPI strip renders four counts (Critical / Warning / This Quarter / Next 12 Months).
- Confirm events are grouped under month headers, color-coded by a left border, each row showing a days badge + date + title + type badge + amount.
- Switch the window filter to "Next 90 days" and confirm the list shrinks; switch the type filter and confirm rows filter.
- Click a row → the entity drawer opens for that lease/loan/policy.
- Check the console for errors (there should be none).

Take a screenshot for the record.

- [ ] **Step 4: Track A complete** — Calendar ships independently here. Proceed to Track B.

---

# TRACK B — Lease Renewal Pipeline (`/renewals`)

## Task B1: RenewalStage contract

**Files:**
- Create: `src/contracts/renewal.ts`
- Test: `tests/unit/renewals.test.ts` (shared file; this task adds the contract block)

- [ ] **Step 1: Write the failing test**

Create `tests/unit/renewals.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { RenewalStage, RENEWAL_STAGES, nextRenewalStage, RenewalStageInput } from '../../src/contracts/renewal';

describe('RenewalStage contract', () => {
  it('enumerates the five stages in pipeline order', () => {
    expect(RENEWAL_STAGES).toEqual(['Expiring', 'Outreach', 'Negotiating', 'LOI', 'Executed']);
  });

  it('parses a valid stage and rejects an unknown one', () => {
    expect(RenewalStage.parse('Outreach')).toBe('Outreach');
    expect(RenewalStage.safeParse('Nope').success).toBe(false);
  });

  it('advances along the flow and stops at Executed', () => {
    expect(nextRenewalStage('Expiring')).toBe('Outreach');
    expect(nextRenewalStage('LOI')).toBe('Executed');
    expect(nextRenewalStage('Executed')).toBeNull();
  });

  it('validates the action input', () => {
    expect(RenewalStageInput.safeParse({ leaseId: 'L1', stage: 'LOI' }).success).toBe(true);
    expect(RenewalStageInput.safeParse({ leaseId: '', stage: 'LOI' }).success).toBe(false);
    expect(RenewalStageInput.safeParse({ leaseId: 'L1', stage: 'X' }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/renewals.test.ts`
Expected: FAIL — cannot find module `../../src/contracts/renewal`.

- [ ] **Step 3: Write the implementation**

Create `src/contracts/renewal.ts`:

```typescript
import { z } from 'zod';

/** Lease renewal pipeline stages, in advance order. "Expiring" is the implicit default. */
export const RenewalStage = z.enum(['Expiring', 'Outreach', 'Negotiating', 'LOI', 'Executed']);
export type RenewalStage = z.infer<typeof RenewalStage>;

export const RENEWAL_STAGES: RenewalStage[] = ['Expiring', 'Outreach', 'Negotiating', 'LOI', 'Executed'];

export function nextRenewalStage(stage: RenewalStage): RenewalStage | null {
  const i = RENEWAL_STAGES.indexOf(stage);
  if (i < 0 || i >= RENEWAL_STAGES.length - 1) return null;
  return RENEWAL_STAGES[i + 1]!;
}

/** POST /api/actions/renewal-stage body. */
export const RenewalStageInput = z.object({
  leaseId: z.string().min(1),
  stage: RenewalStage,
});
export type RenewalStageInput = z.infer<typeof RenewalStageInput>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/renewals.test.ts`
Expected: PASS (contract block).

- [ ] **Step 5: Commit**

```bash
git add src/contracts/renewal.ts tests/unit/renewals.test.ts
git commit -m "feat(renewals): RenewalStage contract + advance flow"
```

---

## Task B2: Wire renewalStages into snapshot contract + overlay

**Files:**
- Modify: `src/contracts/index.ts` (re-export + `PortfolioSnapshot` field)
- Modify: `server/overlay.ts` (overlay key + `applyOverlay` merge)
- Modify: `tests/unit/overlay.test.ts` (append a merge test)

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/overlay.test.ts` (inside the existing `applyOverlay` describe block, or as a new one):

```typescript
import { EMPTY_OVERLAY } from '../../server/overlay';

describe('applyOverlay — renewalStages (Phase 2)', () => {
  const baseL = {
    deals: [],
    tasks: [],
    leases: [{ id: 'L1' }, { id: 'L2' }],
  } as unknown as PortfolioSnapshot;

  it('surfaces renewalStages onto the snapshot', () => {
    const out = applyOverlay(baseL, { ...EMPTY_OVERLAY, renewalStages: { L1: 'Outreach' } });
    expect(out.renewalStages).toEqual({ L1: 'Outreach' });
  });

  it('defaults to an empty record when the overlay has none', () => {
    const out = applyOverlay(baseL, EMPTY_OVERLAY);
    expect(out.renewalStages).toEqual({});
  });

  it('EMPTY_OVERLAY carries the new keys', () => {
    expect(EMPTY_OVERLAY.renewalStages).toEqual({});
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/overlay.test.ts`
Expected: FAIL — `EMPTY_OVERLAY.renewalStages` is undefined / `out.renewalStages` undefined.

- [ ] **Step 3: Extend the snapshot contract**

In `src/contracts/index.ts`, add the re-export near the other `export * from` lines:

```typescript
export * from './renewal';
```

Add the import at the top (with the other contract imports):

```typescript
import { RenewalStage } from './renewal';
```

Add the field to the `PortfolioSnapshot` object (after `counterparties`):

```typescript
  /** Overlay-sourced lease renewal pipeline stages (Phase 2). Workbook has none → defaults empty. */
  renewalStages: z.record(z.string(), RenewalStage).default({}),
```

- [ ] **Step 4: Extend the overlay**

In `server/overlay.ts`:

Update the import to include the type:

```typescript
import type { PortfolioSnapshot, Task, DealStage, RenewalStage } from '../src/contracts/index';
```

Add to the `Overlay` interface:

```typescript
  /** leaseId → renewal pipeline stage. */
  renewalStages: Record<string, RenewalStage>;
```

Update `EMPTY_OVERLAY`:

```typescript
export const EMPTY_OVERLAY: Overlay = { dealStages: {}, tasks: [], renewalStages: {} };
```

Update `loadOverlay`'s success return AND its corrupt-fallback return to include the key:

```typescript
      return { dealStages: raw.dealStages ?? {}, tasks: raw.tasks ?? [], renewalStages: raw.renewalStages ?? {} };
```
```typescript
  return { dealStages: {}, tasks: [], renewalStages: {} };
```

Update `applyOverlay`'s return to surface the field:

```typescript
  return { ...s, deals, tasks, renewalStages: o.renewalStages };
```

- [ ] **Step 5: Run to verify it passes + typecheck**

Run: `npx vitest run tests/unit/overlay.test.ts`
Expected: PASS.

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/contracts/index.ts server/overlay.ts tests/unit/overlay.test.ts
git commit -m "feat(renewals): renewalStages overlay key + snapshot field"
```

---

## Task B3: Brain mutator + endpoint + client action

**Files:**
- Modify: `server/brain.ts` (mutator)
- Modify: `server/index.ts` (endpoint)
- Modify: `src/data/actions.ts` (client wrapper)

- [ ] **Step 1: Add the brain mutator**

In `server/brain.ts`, update the contract import to include `RenewalStage`:

```typescript
import { PortfolioSnapshot, type BrainState, type DataQualityFlag, type Task, type DealStage, type RenewalStage } from '../src/contracts/index';
```

Add this method after `setDealStage` (mirrors it exactly):

```typescript
  /** Write-back: set a lease's renewal stage. Returns false if the lease is unknown. */
  setRenewalStage(leaseId: string, stage: RenewalStage): boolean {
    if (!this.base?.leases.some((l) => l.id === leaseId)) return false;
    this.overlay = { ...this.overlay, renewalStages: { ...this.overlay.renewalStages, [leaseId]: stage } };
    this.rederive('action:renewal-stage');
    return true;
  }
```

- [ ] **Step 2: Add the endpoint**

In `server/index.ts`, add the import:

```typescript
import { RenewalStageInput } from '../src/contracts/index';
```

Add this route after the `/api/actions/alert` handler:

```typescript
app.post('/api/actions/renewal-stage', async (c) => {
  const parsed = RenewalStageInput.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ ok: false, error: 'Invalid leaseId or stage' }, 400);
  const ok = brain.setRenewalStage(parsed.data.leaseId, parsed.data.stage);
  return c.json({ ok, state: brain.getState() }, ok ? 200 : 404);
});
```

- [ ] **Step 3: Add the client wrapper**

In `src/data/actions.ts`, add the import and wrapper:

```typescript
import type { DealStage, RenewalStage } from '@contracts/index';
```
(extend the existing import — it currently imports only `DealStage`.)

```typescript
export const advanceRenewalStage = (leaseId: string, stage: RenewalStage): Promise<void> =>
  postAction('/api/actions/renewal-stage', { leaseId, stage });
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 5: Verify the endpoint live (fresh server)**

Restart the Brain Server fresh (`node_modules\.bin\tsx server/index.ts`). Find a real lease id first:

```bash
curl -s http://localhost:8911/api/snapshot | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).snapshot.leases[0].id))"
```

Then exercise the endpoint (substitute `<LEASE_ID>`):

```bash
curl -s -X POST http://localhost:8911/api/actions/renewal-stage -H "content-type: application/json" -d "{\"leaseId\":\"<LEASE_ID>\",\"stage\":\"Outreach\"}"
# Expected: {"ok":true,"state":{...}}
curl -s http://localhost:8911/api/snapshot | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).snapshot.renewalStages))"
# Expected: {"<LEASE_ID>":"Outreach"}
```

Reset it so the overlay doesn't linger with a test value (set back via the UI later, or edit `data/overlay.json` to remove the key). An invalid id must 404:

```bash
curl -s -o NUL -w "%{http_code}" -X POST http://localhost:8911/api/actions/renewal-stage -H "content-type: application/json" -d "{\"leaseId\":\"nope\",\"stage\":\"LOI\"}"
# Expected: 404
```

- [ ] **Step 6: Commit**

```bash
git add server/brain.ts server/index.ts src/data/actions.ts
git commit -m "feat(renewals): brain mutator + renewal-stage endpoint + client action"
```

---

## Task B4: Pure renewal board selector

**Files:**
- Create: `src/brain/renewals.ts`
- Test: `tests/unit/renewals.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/renewals.test.ts`:

```typescript
import type { PortfolioSnapshot } from '../../src/contracts/index';
import { RENEWAL_WINDOW_DAYS, renewalBoard } from '../../src/brain/renewals';

const ASOF = '2026-06-04';
const snap = {
  meta: { asOf: ASOF },
  renewalStages: { L4: 'Negotiating' as const },
  leases: [
    // in-window (60d) — defaults to Expiring
    { id: 'L1', company: 'Acme', tenantName: 'Acme', propertyKey: '100 A', unit: '1', annualRent: 100000, leaseEnd: '2026-08-03', status: 'Active' },
    // overdue holdover (-20d) — needs action now, included
    { id: 'L2', company: null, tenantName: 'Beta', propertyKey: '200 B', unit: null, annualRent: 50000, leaseEnd: '2026-05-15', status: 'Expired' },
    // far out (300d), no stage — excluded
    { id: 'L3', company: 'Gamma', tenantName: 'Gamma', propertyKey: '300 C', unit: '2', annualRent: 75000, leaseEnd: '2027-04-01', status: 'Active' },
    // far out (300d) BUT carries an explicit stage — included via stage
    { id: 'L4', company: 'Delta', tenantName: 'Delta', propertyKey: '400 D', unit: null, annualRent: 90000, leaseEnd: '2027-04-01', status: 'Active' },
    // vacant unit in-window — excluded (nothing to renew)
    { id: 'L5', company: null, tenantName: 'VACANT', propertyKey: '500 E', unit: '3', annualRent: 0, leaseEnd: '2026-07-01', status: 'Vacant' },
  ],
} as unknown as PortfolioSnapshot;

describe('renewalBoard', () => {
  it('exposes the 75-day window constant', () => {
    expect(RENEWAL_WINDOW_DAYS).toBe(75);
  });

  it('selects in-window leases (incl. overdue holdovers) and any lease carrying a stage', () => {
    const board = renewalBoard(snap);
    const all = Object.values(board).flat().map((c) => c.leaseId);
    expect(all).toContain('L1');
    expect(all).toContain('L2');
    expect(all).not.toContain('L3'); // far out, no stage
    expect(all).toContain('L4'); // far out but staged
    expect(all).not.toContain('L5'); // vacant
  });

  it('defaults unstaged in-window leases to the Expiring column and honors explicit stages', () => {
    const board = renewalBoard(snap);
    expect(board.Expiring.map((c) => c.leaseId).sort()).toEqual(['L1', 'L2']);
    expect(board.Negotiating.map((c) => c.leaseId)).toEqual(['L4']);
    expect(board.Outreach).toEqual([]);
  });

  it('orders each column by urgency (soonest/overdue first) and carries daysToExpiry', () => {
    const board = renewalBoard(snap);
    // L2 overdue (-20) sorts before L1 (60)
    expect(board.Expiring.map((c) => c.leaseId)).toEqual(['L2', 'L1']);
    expect(board.Expiring[0]!.daysToExpiry).toBeLessThan(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/renewals.test.ts`
Expected: FAIL — cannot find module `../../src/brain/renewals`.

- [ ] **Step 3: Write the implementation**

Create `src/brain/renewals.ts`:

```typescript
import type { PortfolioSnapshot } from '../contracts/index';
import { RENEWAL_STAGES, type RenewalStage } from '../contracts/renewal';

const DAY_MS = 86_400_000;
const daysBetween = (isoTarget: string, isoFrom: string): number =>
  Math.round((new Date(isoTarget).getTime() - new Date(isoFrom).getTime()) / DAY_MS);

/** "Needs action now" window — leases expiring within this many days populate the board. */
export const RENEWAL_WINDOW_DAYS = 75;

export interface RenewalCard {
  leaseId: string;
  tenant: string;
  propertyKey: string;
  unit: string | null;
  annualRent: number;
  leaseEnd: string | null;
  daysToExpiry: number | null; // signed; null when no lease-end date
  stage: RenewalStage;
}

export type RenewalBoard = Record<RenewalStage, RenewalCard[]>;

/**
 * Group the "needs action now" lease set into the renewal kanban. A lease appears when it is
 * expiring within RENEWAL_WINDOW_DAYS (including overdue holdovers — still an open item) or when
 * it already carries an explicit renewal stage in the overlay. Vacant units are excluded.
 */
export function renewalBoard(s: PortfolioSnapshot): RenewalBoard {
  const asOf = s.meta.asOf;
  const stages = s.renewalStages;
  const board: RenewalBoard = { Expiring: [], Outreach: [], Negotiating: [], LOI: [], Executed: [] };

  for (const l of s.leases) {
    const explicit = stages[l.id]; // RenewalStage | undefined
    const daysToExpiry = l.leaseEnd ? daysBetween(l.leaseEnd, asOf) : null;
    const inWindow = daysToExpiry !== null && daysToExpiry <= RENEWAL_WINDOW_DAYS;
    const eligible = (explicit !== undefined || inWindow) && l.status !== 'Vacant';
    if (!eligible) continue;

    const stage: RenewalStage = explicit ?? 'Expiring';
    board[stage].push({
      leaseId: l.id,
      tenant: l.company ?? l.tenantName,
      propertyKey: l.propertyKey,
      unit: l.unit,
      annualRent: l.annualRent,
      leaseEnd: l.leaseEnd,
      daysToExpiry,
      stage,
    });
  }

  const byUrgency = (a: RenewalCard, b: RenewalCard): number => {
    if (a.daysToExpiry === null) return 1;
    if (b.daysToExpiry === null) return -1;
    return a.daysToExpiry - b.daysToExpiry;
  };
  for (const k of RENEWAL_STAGES) board[k].sort(byUrgency);
  return board;
}
```

- [ ] **Step 4: Run to verify it passes + typecheck**

Run: `npx vitest run tests/unit/renewals.test.ts`
Expected: PASS.

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/brain/renewals.ts tests/unit/renewals.test.ts
git commit -m "feat(renewals): pure 75-day renewal board selector"
```

---

## Task B5: Renewals kanban module

**Files:**
- Create: `src/modules/renewals/RenewalsModule.tsx`

- [ ] **Step 1: Write the implementation**

Create `src/modules/renewals/RenewalsModule.tsx`. The kanban is net-new (Acquisitions is a table). Stage advance posts via `advanceRenewalStage` and invalidates the snapshot query (live-server only; the static mirror is read-only — the button no-ops on error). Draft CTA reuses `ui.openDraft`:

```tsx
import { useMemo } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Mail } from 'lucide-react';
import { useSnapshot, SNAPSHOT_KEY } from '@/data/queries';
import { useUi } from '@/brain/ui-context';
import { advanceRenewalStage } from '@/data/actions';
import { fmtUsdCompact, fmtDate } from '@analytics/index';
import { Badge, type BadgeTone } from '@/primitives/Badge';
import { renewalBoard, type RenewalCard } from '@/brain/renewals';
import { RENEWAL_STAGES, nextRenewalStage, type RenewalStage } from '@contracts/index';

const STAGE_TONE: Record<RenewalStage, BadgeTone> = {
  Expiring: 'red',
  Outreach: 'amber',
  Negotiating: 'blue',
  LOI: 'purple',
  Executed: 'green',
};
const dayLabel = (d: number | null) => (d === null ? '—' : d < 0 ? `${Math.abs(d)}d over` : `${d}d`);
const dayTone = (d: number | null): BadgeTone => (d === null ? 'neutral' : d < 0 ? 'red' : d <= 30 ? 'amber' : 'neutral');

export function RenewalsModule() {
  const { data } = useSnapshot();
  const ui = useUi();
  const qc = useQueryClient();
  const advance = useMutation({
    mutationFn: (v: { leaseId: string; stage: RenewalStage }) => advanceRenewalStage(v.leaseId, v.stage),
    onSuccess: () => qc.invalidateQueries({ queryKey: SNAPSHOT_KEY }),
  });

  const board = useMemo(() => (data ? renewalBoard(data.snapshot) : null), [data]);
  if (!data || !board) return null;
  const total = RENEWAL_STAGES.reduce((n, s) => n + board[s].length, 0);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="amber" dot>Leases expiring ≤75 days — needs action now</Badge>
        <span className="num text-2xs uppercase" style={{ letterSpacing: '0.12em', color: 'var(--text-tertiary)' }}>
          {total} in pipeline
        </span>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {RENEWAL_STAGES.map((stage) => (
          <div key={stage} className="flex flex-col rounded-[var(--radius-md)]" style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}>
            <div className="flex items-center justify-between px-3 py-2" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
              <span className="text-2xs font-semibold uppercase" style={{ letterSpacing: '0.08em' }}>
                <Badge tone={STAGE_TONE[stage]}>{stage}</Badge>
              </span>
              <span className="num text-2xs" style={{ color: 'var(--text-tertiary)' }}>{board[stage].length}</span>
            </div>
            <div className="flex flex-col gap-2 p-2" style={{ minHeight: 80 }}>
              {board[stage].length === 0 ? (
                <span className="px-1 py-4 text-center text-2xs" style={{ color: 'var(--text-tertiary)' }}>—</span>
              ) : (
                board[stage].map((card) => (
                  <RenewalCardView
                    key={card.leaseId}
                    card={card}
                    isPending={advance.isPending}
                    onAdvance={() => {
                      const next = nextRenewalStage(card.stage);
                      if (next) advance.mutate({ leaseId: card.leaseId, stage: next });
                    }}
                    onDraft={() => ui.openDraft({ kind: 'renewal', entity: { type: 'lease', id: card.leaseId } })}
                    onOpen={() => ui.openEntity({ type: 'lease', id: card.leaseId })}
                  />
                ))
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function RenewalCardView({
  card, isPending, onAdvance, onDraft, onOpen,
}: {
  card: RenewalCard;
  isPending: boolean;
  onAdvance: () => void;
  onDraft: () => void;
  onOpen: () => void;
}) {
  const canAdvance = nextRenewalStage(card.stage) !== null;
  return (
    <div className="rounded-[var(--radius-sm)] p-2.5" style={{ background: 'var(--surface-overlay)', border: '1px solid var(--border-subtle)' }}>
      <button onClick={onOpen} className="block w-full text-left">
        <div className="text-xs" style={{ fontWeight: 600 }}>{card.tenant}</div>
        <div className="num text-2xs" style={{ color: 'var(--text-tertiary)' }}>{card.propertyKey} {card.unit ?? ''}</div>
      </button>
      <div className="mt-1.5 flex items-center justify-between">
        <Badge tone={dayTone(card.daysToExpiry)}>{dayLabel(card.daysToExpiry)}</Badge>
        <span className="num text-2xs" style={{ color: 'var(--text-secondary)' }}>{fmtUsdCompact(card.annualRent)}</span>
      </div>
      <div className="mt-1 num text-[10px]" style={{ color: 'var(--text-tertiary)' }}>exp {fmtDate(card.leaseEnd)}</div>
      <div className="mt-2 flex items-center gap-1.5">
        <button
          onClick={onDraft}
          className="flex items-center gap-1 text-2xs"
          style={{ color: 'var(--accent)' }}
          aria-label={`Draft renewal email for ${card.tenant}`}
        >
          <Mail size={11} /> Draft
        </button>
        <span className="flex-1" />
        {canAdvance && (
          <button
            onClick={onAdvance}
            disabled={isPending}
            className="flex items-center gap-1 text-2xs"
            style={{ color: 'var(--text-secondary)', opacity: isPending ? 0.5 : 1 }}
            aria-label={`Advance ${card.tenant} to ${nextRenewalStage(card.stage)}`}
          >
            {nextRenewalStage(card.stage)} <ArrowRight size={11} />
          </button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors. (`fmtDate` accepts `string | null` — it is used with nullable values in `LeasesModule`.)

- [ ] **Step 3: Commit**

```bash
git add src/modules/renewals/RenewalsModule.tsx
git commit -m "feat(renewals): 75-day renewal kanban with advance + draft CTA"
```

---

## Task B6: Register the Renewals module

**Files:**
- Modify: `src/shell/modules.tsx`

- [ ] **Step 1: Add the Lucide icon import**

Add `RefreshCw` to the `lucide-react` import list in `src/shell/modules.tsx`.

- [ ] **Step 2: Add the lazy import**

After the `CalendarModule` lazy import, add:

```typescript
const RenewalsModule = lazy(() => import('@/modules/renewals/RenewalsModule').then((m) => ({ default: m.RenewalsModule })));
```

- [ ] **Step 3: Register in MODULES**

In the `Command` group, after the `calendar` entry, add:

```typescript
  { id: 'renewals', label: 'Renewals', icon: RefreshCw, group: 'Command', Component: RenewalsModule },
```

- [ ] **Step 4: Typecheck + gate**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

Run: `npm run gate`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/shell/modules.tsx
git commit -m "feat(renewals): register /renewals module in the rail"
```

---

## Task B7: Verify Renewals end-to-end (fresh server)

- [ ] **Step 1: Restart FRESH servers** (kill stale, restart Brain Server + Vite as in Task A4).

- [ ] **Step 2: Verify in a clean browser session**

Navigate to the app, click **Renewals** in the Command group.
- Confirm five columns (Expiring → Outreach → Negotiating → LOI → Executed), each with a count and stage badge.
- Confirm cards show tenant, property/unit, a days badge (overdue in red), rent, and expiry.
- Click a card's stage-advance button (e.g. `Outreach →`) → confirm the card moves to the next column after the snapshot refetches (the overlay persisted server-side).
- Reload the page → the card stays in the advanced column (served from the baked `renewalStages`).
- Click **Draft** on a card → the draft email composer opens with a renewal draft for that tenant.
- Click a card body → the lease entity drawer opens.
- Check the console for errors.

Take a screenshot. Then reset any test stage changes via `data/overlay.json` if you want a clean board, or leave them (they're real overlay data).

- [ ] **Step 3: Track B complete.** Proceed to Track C.

---

# TRACK C — Tenant Scorecard (`/tenants`)

## Task C1: Wire tenantNotes into snapshot contract + overlay

**Files:**
- Modify: `src/contracts/index.ts` (`PortfolioSnapshot` field)
- Modify: `server/overlay.ts` (overlay key + merge)
- Modify: `tests/unit/overlay.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/overlay.test.ts`:

```typescript
describe('applyOverlay — tenantNotes (Phase 2)', () => {
  const baseT = { deals: [], tasks: [], leases: [] } as unknown as PortfolioSnapshot;

  it('surfaces tenantNotes onto the snapshot', () => {
    const out = applyOverlay(baseT, { ...EMPTY_OVERLAY, tenantNotes: { 'acme-llc': 'Eric to follow up' } });
    expect(out.tenantNotes).toEqual({ 'acme-llc': 'Eric to follow up' });
  });

  it('defaults to an empty record and EMPTY_OVERLAY carries the key', () => {
    expect(applyOverlay(baseT, EMPTY_OVERLAY).tenantNotes).toEqual({});
    expect(EMPTY_OVERLAY.tenantNotes).toEqual({});
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/overlay.test.ts`
Expected: FAIL — `tenantNotes` undefined.

- [ ] **Step 3: Extend the snapshot contract**

In `src/contracts/index.ts`, add to `PortfolioSnapshot` (after `renewalStages`):

```typescript
  /** Overlay-sourced free-text tenant notes (Phase 2), keyed by tenant slug. */
  tenantNotes: z.record(z.string(), z.string()).default({}),
```

- [ ] **Step 4: Extend the overlay**

In `server/overlay.ts`:

Add to the `Overlay` interface:

```typescript
  /** tenantId (slug) → free-text note. */
  tenantNotes: Record<string, string>;
```

Update `EMPTY_OVERLAY`:

```typescript
export const EMPTY_OVERLAY: Overlay = { dealStages: {}, tasks: [], renewalStages: {}, tenantNotes: {} };
```

Update both `loadOverlay` returns (success + corrupt fallback) to include `tenantNotes: raw.tenantNotes ?? {}` and `tenantNotes: {}` respectively.

Update `applyOverlay`'s return:

```typescript
  return { ...s, deals, tasks, renewalStages: o.renewalStages, tenantNotes: o.tenantNotes };
```

- [ ] **Step 5: Run to verify it passes + typecheck**

Run: `npx vitest run tests/unit/overlay.test.ts`
Expected: PASS.

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/contracts/index.ts server/overlay.ts tests/unit/overlay.test.ts
git commit -m "feat(tenants): tenantNotes overlay key + snapshot field"
```

---

## Task C2: Pure tenant scorecard selector

**Files:**
- Create: `src/brain/tenants.ts`
- Test: `tests/unit/tenants.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/tenants.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import type { PortfolioSnapshot } from '../../src/contracts/index';
import { tenantSlug, tenantScorecards } from '../../src/brain/tenants';

const ASOF = '2026-06-04';
// Property P1: NOI 100k, two tenants (Acme 70k rent linked, Beta 30k rent linked) → fully linked.
// Property P2: NOI 40k, one tenant (Gamma 40k rent linked).
// Acme also has an UNLINKED lease (propertyId null) of 50k rent → fallback allocation.
const snap = {
  meta: { asOf: ASOF },
  renewalStages: { 'beta-inc': 'LOI' as const },
  tenantNotes: { 'acme-llc': 'Eric to follow up' },
  properties: [
    { id: 'P1', noi: 100000 },
    { id: 'P2', noi: 40000 },
  ],
  leases: [
    { id: 'L1', company: 'Acme LLC', tenantName: 'Acme LLC', propertyKey: '100 A', unit: '1', propertyId: 'P1', sf: 1000, annualRent: 70000, leaseEnd: '2026-09-01', status: 'Active' },
    { id: 'L2', company: 'Beta Inc', tenantName: 'Beta Inc', propertyKey: '100 A', unit: '2', propertyId: 'P1', sf: 500, annualRent: 30000, leaseEnd: '2026-12-01', status: 'Active' },
    { id: 'L3', company: 'Gamma Co', tenantName: 'Gamma Co', propertyKey: '200 B', unit: null, propertyId: 'P2', sf: 800, annualRent: 40000, leaseEnd: '2027-01-01', status: 'Active' },
    { id: 'L4', company: 'Acme LLC', tenantName: 'Acme LLC', propertyKey: '300 C', unit: '5', propertyId: null, sf: 600, annualRent: 50000, leaseEnd: '2026-07-15', status: 'Active' },
  ],
} as unknown as PortfolioSnapshot;

describe('tenantSlug', () => {
  it('produces a stable lowercase slug', () => {
    expect(tenantSlug('Acme LLC')).toBe('acme-llc');
    expect(tenantSlug('Beta, Inc.')).toBe('beta-inc');
  });
});

describe('tenantScorecards', () => {
  const cards = tenantScorecards(snap);
  const acme = cards.find((c) => c.id === 'acme-llc')!;
  const beta = cards.find((c) => c.id === 'beta-inc')!;
  const gamma = cards.find((c) => c.id === 'gamma-co')!;

  it('rolls leases up per tenant (rent, sf, properties, leaseCount)', () => {
    expect(acme.annualRent).toBe(120000); // 70k + 50k
    expect(acme.sf).toBe(1600);
    expect(acme.leaseCount).toBe(2);
    expect(acme.properties.sort()).toEqual(['100 A', '300 C']);
  });

  it('allocates % portfolio NOI pro-rata within each property, with rent-share fallback for unlinked leases', () => {
    // portfolio NOI = 140k. Margin = 140k / 190k total rent ≈ 0.7368.
    // Acme linked L1 = 100k * (70k/100k) = 70k. Acme unlinked L4 = 50k * 0.7368 = 36.84k. → 106.84k / 140k.
    expect(acme.pctNoi).toBeCloseTo((70000 + 50000 * (140000 / 190000)) / 140000, 4);
    // Beta linked = 100k * (30k/100k) = 30k → 30k/140k.
    expect(beta.pctNoi).toBeCloseTo(30000 / 140000, 4);
    // Gamma linked = 40k * (40k/40k) = 40k → 40k/140k.
    expect(gamma.pctNoi).toBeCloseTo(40000 / 140000, 4);
  });

  it('reports the soonest expiry and its days-to-expiry per tenant', () => {
    expect(acme.nextExpiry).toBe('2026-07-15'); // L4 sooner than L1
    expect(acme.daysToExpiry).toBeGreaterThan(0);
  });

  it('surfaces the most-advanced renewal stage and joins notes; health is null pre-QB', () => {
    expect(beta.renewalStage).toBe('LOI');
    expect(acme.renewalStage).toBeNull();
    expect(acme.notes).toBe('Eric to follow up');
    expect(beta.notes).toBe('');
    expect(acme.health).toBeNull();
  });

  it('sorts tenants by annual rent descending', () => {
    expect(cards.map((c) => c.id)).toEqual(['acme-llc', 'gamma-co', 'beta-inc']);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/tenants.test.ts`
Expected: FAIL — cannot find module `../../src/brain/tenants`.

- [ ] **Step 3: Write the implementation**

Create `src/brain/tenants.ts`:

```typescript
import type { PortfolioSnapshot, Lease } from '../contracts/index';
import { RENEWAL_STAGES, type RenewalStage } from '../contracts/renewal';

const DAY_MS = 86_400_000;
const daysBetween = (isoTarget: string, isoFrom: string): number =>
  Math.round((new Date(isoTarget).getTime() - new Date(isoFrom).getTime()) / DAY_MS);
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

/** Stable slug id from a tenant display name (the workbook has no tenant id). */
export function tenantSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export interface TenantScorecard {
  id: string;
  name: string;
  properties: string[]; // distinct propertyKey
  leaseCount: number;
  sf: number;
  annualRent: number;
  pctNoi: number; // 0..1 — pro-rata NOI allocation (rent-share fallback for unlinked leases)
  nextExpiry: string | null; // soonest leaseEnd ISO
  daysToExpiry: number | null;
  renewalStage: RenewalStage | null; // most-advanced stage across the tenant's leases
  health: string | null; // null until QuickBooks lands (Phase 3)
  notes: string;
  leases: Lease[];
}

interface Accum {
  id: string;
  name: string;
  properties: Set<string>;
  sf: number;
  annualRent: number;
  allocNoi: number;
  nextExpiry: string | null;
  stageRank: number; // -1 = none
  leases: Lease[];
}

/** Roll leases up per tenant with a pro-rata NOI allocation. */
export function tenantScorecards(s: PortfolioSnapshot): TenantScorecard[] {
  const portfolioNoi = sum(s.properties.map((p) => p.noi));
  const totalRent = sum(s.leases.map((l) => l.annualRent));
  const margin = totalRent > 0 ? portfolioNoi / totalRent : 0; // NOI per $ rent (fallback weight)

  // Property NOI by id, and linked-rent per property (denominator for pro-rata allocation).
  const propNoi = new Map<string, number>();
  for (const p of s.properties) propNoi.set(p.id, p.noi);
  const propLinkedRent = new Map<string, number>();
  for (const l of s.leases) {
    if (l.propertyId !== null && propNoi.has(l.propertyId)) {
      propLinkedRent.set(l.propertyId, (propLinkedRent.get(l.propertyId) ?? 0) + l.annualRent);
    }
  }

  const byTenant = new Map<string, Accum>();
  for (const l of s.leases) {
    const name = l.company ?? l.tenantName;
    const id = tenantSlug(name);
    const acc =
      byTenant.get(id) ??
      { id, name, properties: new Set<string>(), sf: 0, annualRent: 0, allocNoi: 0, nextExpiry: null, stageRank: -1, leases: [] };

    // Pro-rata NOI allocation: each property's NOI split across its linked leases by rent share.
    const pid = l.propertyId;
    const pNoi = pid !== null ? propNoi.get(pid) : undefined;
    const pRent = pid !== null ? propLinkedRent.get(pid) : undefined;
    const alloc = pid !== null && pNoi !== undefined && pRent !== undefined && pRent > 0
      ? pNoi * (l.annualRent / pRent)
      : l.annualRent * margin; // unlinked → rent-share fallback in NOI units

    acc.properties.add(l.propertyKey);
    acc.sf += l.sf;
    acc.annualRent += l.annualRent;
    acc.allocNoi += alloc;
    acc.leases.push(l);

    if (l.leaseEnd && (acc.nextExpiry === null || l.leaseEnd < acc.nextExpiry)) acc.nextExpiry = l.leaseEnd;

    const stage = s.renewalStages[l.id];
    if (stage !== undefined) acc.stageRank = Math.max(acc.stageRank, RENEWAL_STAGES.indexOf(stage));

    byTenant.set(id, acc);
  }

  const cards: TenantScorecard[] = [...byTenant.values()].map((a) => ({
    id: a.id,
    name: a.name,
    properties: [...a.properties],
    leaseCount: a.leases.length,
    sf: a.sf,
    annualRent: a.annualRent,
    pctNoi: portfolioNoi > 0 ? a.allocNoi / portfolioNoi : 0,
    nextExpiry: a.nextExpiry,
    daysToExpiry: a.nextExpiry ? daysBetween(a.nextExpiry, s.meta.asOf) : null,
    renewalStage: a.stageRank >= 0 ? RENEWAL_STAGES[a.stageRank]! : null,
    health: null,
    notes: s.tenantNotes[a.id] ?? '',
    leases: a.leases,
  }));

  return cards.sort((a, b) => b.annualRent - a.annualRent);
}
```

- [ ] **Step 4: Run to verify it passes + typecheck**

Run: `npx vitest run tests/unit/tenants.test.ts`
Expected: PASS.

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/brain/tenants.ts tests/unit/tenants.test.ts
git commit -m "feat(tenants): pure tenant scorecard rollup with pro-rata NOI"
```

---

## Task C3: Tenant-note brain mutator + endpoint + client action

**Files:**
- Modify: `server/brain.ts`
- Modify: `server/index.ts`
- Modify: `src/data/actions.ts`

- [ ] **Step 1: Add the brain mutator**

In `server/brain.ts`, import the selector at the top (pure, server-safe):

```typescript
import { tenantScorecards } from '../src/brain/tenants';
```

Add this method after `setRenewalStage`. It validates the tenant id against the derived scorecard ids, and deletes the key when the note is blank:

```typescript
  /** Write-back: set (or clear) a tenant's free-text note. Returns false if the tenant is unknown. */
  setTenantNote(tenantId: string, note: string): boolean {
    if (!this.base) return false;
    const known = new Set(tenantScorecards(this.base).map((t) => t.id));
    if (!known.has(tenantId)) return false;
    const notes = { ...this.overlay.tenantNotes };
    const trimmed = note.trim();
    if (trimmed) notes[tenantId] = trimmed;
    else delete notes[tenantId];
    this.overlay = { ...this.overlay, tenantNotes: notes };
    this.rederive('action:tenant-note');
    return true;
  }
```

Note: `tenantScorecards(this.base)` runs on the pre-overlay base — its tenant ids are identical to the merged snapshot's (tenant identity comes from lease names, which the overlay never changes), so validation is correct.

- [ ] **Step 2: Add the endpoint**

In `server/index.ts`, add the route after `/api/actions/renewal-stage`:

```typescript
app.post('/api/actions/tenant-note', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { tenantId?: string; note?: string };
  const tenantId = String(body.tenantId ?? '').trim();
  if (!tenantId) return c.json({ ok: false, error: 'tenantId required' }, 400);
  const ok = brain.setTenantNote(tenantId, String(body.note ?? ''));
  return c.json({ ok, state: brain.getState() }, ok ? 200 : 404);
});
```

- [ ] **Step 3: Add the client wrapper**

In `src/data/actions.ts`:

```typescript
export const saveTenantNote = (tenantId: string, note: string): Promise<void> =>
  postAction('/api/actions/tenant-note', { tenantId, note });
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 5: Verify the endpoint live (fresh server)**

Restart the Brain Server fresh. Find a real tenant id (slug of the first lease's company/tenantName):

```bash
curl -s http://localhost:8911/api/snapshot | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const s=JSON.parse(d).snapshot;const l=s.leases[0];const n=(l.company||l.tenantName).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');console.log(n)})"
```

Then (substitute `<TENANT_ID>`):

```bash
curl -s -X POST http://localhost:8911/api/actions/tenant-note -H "content-type: application/json" -d "{\"tenantId\":\"<TENANT_ID>\",\"note\":\"Test note\"}"
# Expected: {"ok":true,...}
curl -s http://localhost:8911/api/snapshot | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).snapshot.tenantNotes))"
# Expected: {"<TENANT_ID>":"Test note"}
# Clear it:
curl -s -X POST http://localhost:8911/api/actions/tenant-note -H "content-type: application/json" -d "{\"tenantId\":\"<TENANT_ID>\",\"note\":\"\"}" >NUL
# Unknown tenant → 404:
curl -s -o NUL -w "%{http_code}" -X POST http://localhost:8911/api/actions/tenant-note -H "content-type: application/json" -d "{\"tenantId\":\"nope-xyz\",\"note\":\"x\"}"
# Expected: 404
```

- [ ] **Step 6: Commit**

```bash
git add server/brain.ts server/index.ts src/data/actions.ts
git commit -m "feat(tenants): tenant-note mutator + endpoint + client action"
```

---

## Task C4: Tenant Scorecard module

**Files:**
- Create: `src/modules/tenants/TenantsModule.tsx`

- [ ] **Step 1: Write the implementation**

Create `src/modules/tenants/TenantsModule.tsx`. A sortable `DataTable` with a `% NOI` inline bar and a `Health` column reading "—"; clicking a row selects the tenant and renders a detail panel (lease detail · financial exposure · renewal status + notes + actions). Notes save on blur via `saveTenantNote`:

```tsx
import { useMemo, useState, useEffect } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Mail } from 'lucide-react';
import { useSnapshot, SNAPSHOT_KEY } from '@/data/queries';
import { useUi } from '@/brain/ui-context';
import { saveTenantNote } from '@/data/actions';
import { fmtUsd, fmtUsdCompact, fmtPct, fmtNum, fmtDate } from '@analytics/index';
import { Card, CardHeader } from '@/primitives/Card';
import { DataTable, type Column } from '@/primitives/DataTable';
import { Badge, type BadgeTone } from '@/primitives/Badge';
import { tenantScorecards, type TenantScorecard } from '@/brain/tenants';
import type { RenewalStage } from '@contracts/index';

const STAGE_TONE: Record<RenewalStage, BadgeTone> = {
  Expiring: 'red', Outreach: 'amber', Negotiating: 'blue', LOI: 'purple', Executed: 'green',
};

function NoiBar({ pct, max }: { pct: number; max: number }) {
  const w = max > 0 ? Math.min(100, (pct / max) * 100) : 0;
  return (
    <div className="flex items-center justify-end gap-2">
      <div className="h-1.5 w-16 overflow-hidden rounded-full" style={{ background: 'var(--surface-overlay)' }}>
        <div className="h-full rounded-full" style={{ width: `${w}%`, background: 'var(--accent)' }} />
      </div>
      <span className="num text-2xs" style={{ color: 'var(--text-secondary)' }}>{fmtPct(pct, 1)}</span>
    </div>
  );
}

export function TenantsModule() {
  const { data } = useSnapshot();
  const ui = useUi();
  const qc = useQueryClient();
  const noteMut = useMutation({
    mutationFn: (v: { tenantId: string; note: string }) => saveTenantNote(v.tenantId, v.note),
    onSuccess: () => qc.invalidateQueries({ queryKey: SNAPSHOT_KEY }),
  });

  const cards = useMemo(() => (data ? tenantScorecards(data.snapshot) : []), [data]);
  const maxPct = useMemo(() => Math.max(0, ...cards.map((c) => c.pctNoi)), [cards]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = cards.find((c) => c.id === selectedId) ?? null;

  if (!data) return null;

  const cols: Column<TenantScorecard>[] = [
    {
      key: 'tenant', header: 'Tenant',
      render: (t) => (
        <div>
          <div style={{ fontWeight: 600 }}>{t.name}</div>
          <div className="num text-2xs" style={{ color: 'var(--text-tertiary)' }}>{t.properties.length} {t.properties.length === 1 ? 'property' : 'properties'} · {t.leaseCount} {t.leaseCount === 1 ? 'lease' : 'leases'}</div>
        </div>
      ),
      sortValue: (t) => t.name,
    },
    { key: 'rent', header: 'Annual Rent', align: 'right', render: (t) => fmtUsd(t.annualRent), sortValue: (t) => t.annualRent },
    { key: 'noi', header: '% Portfolio NOI', align: 'right', render: (t) => <NoiBar pct={t.pctNoi} max={maxPct} />, sortValue: (t) => t.pctNoi },
    { key: 'sf', header: 'SF', align: 'right', render: (t) => fmtNum(t.sf), sortValue: (t) => t.sf },
    { key: 'exp', header: 'Next Expiry', align: 'right', render: (t) => fmtDate(t.nextExpiry), sortValue: (t) => t.daysToExpiry ?? 999999 },
    { key: 'stage', header: 'Renewal', render: (t) => (t.renewalStage ? <Badge tone={STAGE_TONE[t.renewalStage]}>{t.renewalStage}</Badge> : <span style={{ color: 'var(--text-tertiary)' }}>—</span>), sortValue: (t) => t.renewalStage ?? '' },
    { key: 'health', header: 'Health', align: 'right', render: () => <span style={{ color: 'var(--text-tertiary)' }}>—</span> },
  ];

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          title="Tenant Scorecard"
          trailing={
            <div className="flex items-center gap-2">
              <Badge tone="neutral">Health pending QuickBooks</Badge>
              <Badge tone="gold">{cards.length} tenants</Badge>
            </div>
          }
        />
        <DataTable
          columns={cols}
          rows={cards}
          getRowId={(t) => t.id}
          onRowClick={(t) => setSelectedId((id) => (id === t.id ? null : t.id))}
          initialSort={{ key: 'rent', dir: 'desc' }}
          maxHeight={520}
        />
      </Card>

      {selected && <TenantDetail key={selected.id} tenant={selected} onOpenLease={(id) => ui.openEntity({ type: 'lease', id })} onDraft={(id) => ui.openDraft({ kind: 'renewal', entity: { type: 'lease', id } })} onSaveNote={(note) => noteMut.mutate({ tenantId: selected.id, note })} isSaving={noteMut.isPending} />}
    </div>
  );
}

function TenantDetail({
  tenant, onOpenLease, onDraft, onSaveNote, isSaving,
}: {
  tenant: TenantScorecard;
  onOpenLease: (leaseId: string) => void;
  onDraft: (leaseId: string) => void;
  onSaveNote: (note: string) => void;
  isSaving: boolean;
}) {
  const [note, setNote] = useState(tenant.notes);
  useEffect(() => setNote(tenant.notes), [tenant.notes]);

  return (
    <Card>
      <CardHeader title={tenant.name} trailing={<Badge tone="gold">{fmtPct(tenant.pctNoi, 1)} of portfolio NOI</Badge>} />
      <div className="grid grid-cols-1 gap-4 p-4 lg:grid-cols-3">
        <div>
          <div className="mb-2 text-2xs font-semibold uppercase" style={{ letterSpacing: '0.08em', color: 'var(--text-tertiary)' }}>Financial Exposure</div>
          <Row label="Annual Rent" value={fmtUsd(tenant.annualRent)} />
          <Row label="% Portfolio NOI" value={fmtPct(tenant.pctNoi, 1)} />
          <Row label="Total SF" value={fmtNum(tenant.sf)} />
          <Row label="Leases" value={String(tenant.leaseCount)} />
          <Row label="Renewal Stage" value={tenant.renewalStage ?? '—'} />
          <Row label="Health" value={tenant.health ?? '— (pending QuickBooks)'} />
        </div>

        <div>
          <div className="mb-2 text-2xs font-semibold uppercase" style={{ letterSpacing: '0.08em', color: 'var(--text-tertiary)' }}>Leases</div>
          <div className="flex flex-col gap-1.5">
            {tenant.leases.map((l) => (
              <div key={l.id} className="flex items-center justify-between rounded-[var(--radius-sm)] px-2 py-1.5" style={{ background: 'var(--surface-overlay)' }}>
                <button onClick={() => onOpenLease(l.id)} className="text-left">
                  <div className="num text-2xs" style={{ fontWeight: 600 }}>{l.propertyKey} {l.unit ?? ''}</div>
                  <div className="num text-[10px]" style={{ color: 'var(--text-tertiary)' }}>exp {fmtDate(l.leaseEnd)} · {fmtUsdCompact(l.annualRent)}</div>
                </button>
                <button onClick={() => onDraft(l.id)} className="flex items-center gap-1 text-2xs" style={{ color: 'var(--accent)' }} aria-label={`Draft renewal for ${l.propertyKey}`}>
                  <Mail size={11} /> Draft
                </button>
              </div>
            ))}
          </div>
        </div>

        <div>
          <div className="mb-2 text-2xs font-semibold uppercase" style={{ letterSpacing: '0.08em', color: 'var(--text-tertiary)' }}>Notes</div>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onBlur={() => { if (note !== tenant.notes) onSaveNote(note); }}
            placeholder="e.g. Eric to follow up directly…"
            aria-label={`Notes for ${tenant.name}`}
            rows={5}
            className="w-full rounded-[var(--radius-sm)] p-2 text-xs outline-none"
            style={{ background: 'color-mix(in oklab, var(--surface-overlay) 60%, transparent)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}
          />
          <div className="mt-1 text-[10px]" style={{ color: 'var(--text-tertiary)' }}>{isSaving ? 'Saving…' : 'Saved on blur · requires the live Brain Server'}</div>
        </div>
      </div>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-1" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
      <span className="text-2xs" style={{ color: 'var(--text-tertiary)' }}>{label}</span>
      <span className="num text-xs" style={{ color: 'var(--text-primary)' }}>{value}</span>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/modules/tenants/TenantsModule.tsx
git commit -m "feat(tenants): scorecard table (% NOI bar, Health stub) + detail panel + notes"
```

---

## Task C5: Register the Tenants module

**Files:**
- Modify: `src/shell/modules.tsx`

- [ ] **Step 1: Add the Lucide icon import**

Add `Contact` to the `lucide-react` import list.

- [ ] **Step 2: Add the lazy import**

After the `RenewalsModule` lazy import, add:

```typescript
const TenantsModule = lazy(() => import('@/modules/tenants/TenantsModule').then((m) => ({ default: m.TenantsModule })));
```

- [ ] **Step 3: Register in MODULES**

In the `Assets` group, immediately **after** the `leases` entry, add:

```typescript
  { id: 'tenants', label: 'Tenants', icon: Contact, group: 'Assets', Component: TenantsModule },
```

- [ ] **Step 4: Typecheck + gate**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

Run: `npm run gate`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/shell/modules.tsx
git commit -m "feat(tenants): register /tenants module in the rail"
```

---

## Task C6: Verify Tenants end-to-end (fresh server)

- [ ] **Step 1: Restart FRESH servers** (kill stale, restart Brain Server + Vite).

- [ ] **Step 2: Verify in a clean browser session**

Navigate to the app, click **Tenants** in the Assets group.
- Confirm the table renders tenant rows with: name + property/lease counts, annual rent, a `% Portfolio NOI` inline bar + percentage, SF, next expiry, renewal badge (or "—"), and a `Health` column showing "—".
- Sort by `% Portfolio NOI` and by `Annual Rent` → confirm ordering changes.
- Click a row → the detail panel opens below (financial exposure · leases · notes).
- Type a note, click elsewhere (blur) → "Saving…" then it persists; reload the page → the note is still there (served from baked `tenantNotes`).
- Click a lease's **Draft** → the renewal draft composer opens; click a lease body → the lease drawer opens.
- Check the console for errors.

Take a screenshot. Clear any test note via the UI (empty the textarea + blur) if you don't want it to persist.

- [ ] **Step 3: Track C complete.**

---

# Final verification (all tracks)

- [ ] **Step 1: Full gate**

Run: `npm run gate`
Expected: typecheck (all three tsconfigs) + lint (`--max-warnings 0`) + tests + reconcile all green.

- [ ] **Step 2: Production build (lazy chunks)**

Run: `npm run build`
Expected: success; the build output lists separate chunks for `CalendarModule`, `RenewalsModule`, and `TenantsModule` (each module lazy-loads as its own chunk).

- [ ] **Step 3: Confirm overlay stays gitignored**

```bash
git check-ignore data/overlay.json
# Expected: data/overlay.json (still ignored)
git status --porcelain
# Expected: no data/ files staged or untracked
```

- [ ] **Step 4: Confidentiality**

Confirm no confidential identifier (the blocked "fulton" string, case-insensitive) appears in any new source, test, or this plan. The modules render whatever the snapshot carries; confidential deals are redacted by the existing bake on the public mirror — no new leak surface (Calendar/Renewals/Tenants read leases/loans/insurance/tenants, not deals).

- [ ] **Step 5: Final review** (per subagent-driven-development): run a spec-compliance + code-quality review across the three tracks against `docs/superpowers/specs/2026-06-04-command-center-expansion-design.md` Phase 2 section. Confirm: 12-month list (not a grid) ✓, urgency KPI strip ✓, 75-day renewal window ✓, kanban stages Expiring→Outreach→Negotiating→LOI→Executed ✓, overlay-persisted stage + note ✓, % portfolio NOI bar (pro-rata) ✓, Health "—" pre-QB ✓, industry classification skipped ✓, free-text notes ✓.

- [ ] **Step 6: Push + PR** — **pause for Gabriel's confirmation before pushing** (the repo uses PRs; CI `gate` runs on push). Then:

```bash
git push -u origin feat/cc-phase2-calendar-renewals-tenants
gh pr create --title "feat: Command Center Phase 2 — Calendar, Renewals, Tenants" --body "..."
```

---

## Self-review notes (author checklist — completed during planning)

- **Spec coverage:** ① Calendar (Task A1–A4: 12-month list, KPI strip, 4 event types, type+window filters, deep-link) ✓. ③ Renewals (B1–B7: kanban, 5 stages, 75-day window + staged-out-of-window inclusion, overlay `renewalStages`, `POST /api/actions/renewal-stage`, per-card draft) ✓. ⑥ Tenants (C1–C6: per-tenant rollup, % portfolio NOI pro-rata, Health "—", `tenantNotes` overlay, `POST /api/actions/tenant-note`, expandable detail) ✓. Industry classification skipped ✓.
- **Type consistency:** `RenewalStage` / `RENEWAL_STAGES` / `nextRenewalStage` used identically across contract, overlay, brain, board, modules. `DatedEvent`, `RenewalCard`, `TenantScorecard` field names match between selector and module. `EMPTY_OVERLAY` updated in lockstep with the `Overlay` interface in both B2 and C1.
- **`noUncheckedIndexedAccess` safety:** Map `.get()` results guarded before use (`pNoi !== undefined`); `RENEWAL_STAGES[a.stageRank]!` guarded by `a.stageRank >= 0`; `board[stage]` keys come from the typed `RENEWAL_STAGES` union; test array indexing uses `!`.
- **No placeholders:** every code step shows complete code; every run step states the exact command + expected result.
- **Overlay discipline:** all three new write paths (`renewalStages`, `tenantNotes`) are additive overlay keys merged in `applyOverlay`, re-derived via `brain.rederive`, surfaced as snapshot fields baked into the mirror; the workbook is never written.
