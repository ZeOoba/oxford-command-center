# Alerts Engine Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two divergent alert engines (`generateInsights` + `extendedInsights`) with one isomorphic `src/analytics/conditions.ts` implementing the approved 14-condition catalog, feed it identically to the email brief / in-app inbox / Overview, single-source the thresholds (incl. calendar urgency), and wire per-alert deep-link + draft CTAs.

**Architecture:** A pure, dependency-light module `src/analytics/conditions.ts` exports `ALERT_THRESHOLDS` (the only place the numbers live) and `evaluateConditions(snapshot, opts?)`. `buildAnalytics` (client) and the AI tool call it with no opts; the brief calls it with `{ priorStages }` to add deal stage-move alerts. The calendar urgency strip sources its 60/180-day cutoffs from `ALERT_THRESHOLDS`. Per-alert actions map an `Insight.action` to a `DraftRequest` via a new `insightToDraft` helper, wired into both alert surfaces.

**Tech Stack:** React 19, TypeScript (`noUncheckedIndexedAccess`), Zod, @tanstack/react-query, Hono, Vitest, Tailwind v4, Lucide.

**Spec:** `docs/superpowers/specs/2026-06-05-alerts-engine-consolidation-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `src/analytics/conditions.ts` (create) | `ALERT_THRESHOLDS` + `evaluateConditions()` — the single canonical alert engine |
| `src/analytics/types.ts` (modify) | Add `'data'` to `InsightCategory` |
| `src/analytics/index.ts` (modify) | Re-export `./conditions` from the barrel |
| `src/analytics/engine.ts` (modify) | `buildAnalytics` calls `evaluateConditions`; delete `generateInsights` |
| `server/ai/tools.ts` (modify) | Use `evaluateConditions` instead of `generateInsights` |
| `server/brief/run.ts` (modify) | Use `evaluateConditions(s, { priorStages })` |
| `server/brief/alerts.ts` (delete) | `extendedInsights` folded into `evaluateConditions` |
| `src/brain/critical-dates.ts` (modify) | `urgencyOf` sources cutoffs from `ALERT_THRESHOLDS` |
| `src/brain/draft.ts` (modify) | Add `insightToDraft(insight)` |
| `src/modules/overview/InsightList.tsx` (modify) | Deep-link + Draft buttons |
| `src/modules/alerts/AlertsModule.tsx` (modify) | Deep-link + Draft buttons |
| `tests/unit/conditions.test.ts` (create) | Boundary tests for every condition |
| `tests/unit/analytics.test.ts` (modify) | Drop the `generateInsights` block (now covered by conditions.test.ts) |
| `tests/unit/brief-alerts.test.ts` (delete) | Cases folded into conditions.test.ts |
| `tests/unit/draft.test.ts` (modify) | `insightToDraft` mapping tests |

---

## Task 1: The canonical alert engine

**Files:**
- Create: `src/analytics/conditions.ts`
- Modify: `src/analytics/types.ts` (`InsightCategory` union)
- Modify: `src/analytics/index.ts`
- Test: `tests/unit/conditions.test.ts`

- [ ] **Step 1: Add the `data` category**

In `src/analytics/types.ts`, change the `InsightCategory` union to add `'data'`:

```typescript
export type InsightCategory =
  | 'debt'
  | 'lease'
  | 'insurance'
  | 'concentration'
  | 'occupancy'
  | 'cash'
  | 'deal'
  | 'data';
```

- [ ] **Step 2: Write the failing test**

Create `tests/unit/conditions.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import type { PortfolioSnapshot, Property, Lease, Loan, InsurancePolicy, Deal } from '@contracts/index';
import { evaluateConditions, ALERT_THRESHOLDS } from '@analytics/index';

// ── Self-contained fixtures ─────────────────────────────────────────────────
const ASOF = '2026-06-04';
const NOW = Date.parse('2026-06-04T12:00:00.000Z');

function snap(over: Partial<PortfolioSnapshot> = {}): PortfolioSnapshot {
  const base = {
    meta: { schemaVersion: '1.0.0', asOf: ASOF, generatedAt: '2026-06-04T00:00:00.000Z', source: 't', scenario: 'Base' },
    assumptions: { activeScenario: 'Base', revenueFactor: 1, vacancyFactor: 1, exitCapFactor: 1, thresholds: { balloonAlertMonths: 18, concentrationYellow: 0.25, concentrationRed: 0.5 }, asOf: ASOF },
    properties: [], leases: [], loans: [], deals: [], insurance: [], tasks: [], counterparties: [],
    renewalStages: {}, tenantNotes: {}, dealComps: {}, noiBudgets: {}, quickbooks: null, dataQuality: [],
    cash: { asOf: ASOF, totalCash: 0, activeEntities: 0, largestEntity: null, concentrationTopPct: null, cagr: null, entities: [], history: [] },
  };
  return { ...base, ...over } as unknown as PortfolioSnapshot;
}
function iso(daysFromAsOf: number): string {
  return new Date(Date.parse(ASOF) + daysFromAsOf * 86_400_000).toISOString().slice(0, 10);
}
const prop = (o: Partial<Property>): Property => ({
  id: 'p1', index: 1, name: 'Prop One', address: '1 Main', city: null, state: null, market: 'Columbus OH', type: 'Flex',
  sf: 1000, tenantCount: 1, occPct: 1, acqDate: null, estValue100: 0, oxfordOwnPct: 1, oxfordValue: 0, grossIncome: 0,
  expenses: 0, noi: 0, noiScenarioAdj: 0, debtService: 0, netCashFlow: 0, capRate: null, dscr: null, lender: null,
  loanBalance: 0, ltv: null, valuePerSf: null, rentPerSf: null, equityInvested: 0, cashOnCash: null, holdYrs: null,
  encumbered: false, flags: [], ...o,
});
const lease = (o: Partial<Lease>): Lease => ({
  id: 'l1', propertyKey: 'Prop One', propertyId: 'p1', tenantName: 'Tenant', unit: null, company: 'Acme Co', sf: 100,
  monthlyRent: 0, rentPerSf: null, leaseStart: null, leaseEnd: null, escalationDate: null, escalationPct: null,
  status: 'Active', annualRent: 12000, monthsToExpiry: null, flags: [], ...o,
});
const loan = (o: Partial<Loan>): Loan => ({
  id: 'n1', name: 'Loan One', counterparty: null, direction: 'borrower', originalPrincipal: null, currentBalance: -500000,
  absBalance: 500000, rate: null, monthlyPmt: null, annualInterest: null, annualPrincipal: null, loanType: null,
  status: null, isDemand: false, maturity: null, monthsToMaturity: null, ltv: null, lender: null, balloon: false, flags: [], ...o,
});
const policy = (o: Partial<InsurancePolicy>): InsurancePolicy => ({
  id: 'i1', property: 'Prop One', entity: null, coverage: 'Package', effective: null, expires: null, policyNo: null,
  carrier: 'Carrier', premium: 5000, daysToExpiry: null, status: 'Current', notes: null, flags: [], ...o,
});
const deal = (o: Partial<Deal>): Deal => ({
  id: 'd1', name: 'Deal One', shortName: null, location: null, market: null, sf: null, buildings: null, stage: 'Sourcing',
  estPrice: null, capRate: null, irr: null, equityMultiple: null, holdYrs: null, lender: null, status: null,
  nextAction: null, owner: null, targetCloseDate: null, confidential: false, estimatedFields: [], ...o,
});
const opts = { now: NOW };

describe('evaluateConditions — debt', () => {
  it('balloon < 180d is critical', () => {
    const out = evaluateConditions(snap({ loans: [loan({ balloon: true, maturity: iso(120) })] }), opts);
    expect(out.find((i) => i.id === 'balloon-n1')?.severity).toBe('critical');
  });
  it('balloon 180–365d is warning', () => {
    const out = evaluateConditions(snap({ loans: [loan({ balloon: true, maturity: iso(200) })] }), opts);
    expect(out.find((i) => i.id === 'balloon-n1')?.severity).toBe('warning');
  });
  it('balloon beyond 365d does not fire', () => {
    const out = evaluateConditions(snap({ loans: [loan({ balloon: true, maturity: iso(400) })] }), opts);
    expect(out.some((i) => i.id === 'balloon-n1')).toBe(false);
  });
  it('DSCR < 1.10 is a critical floor breach', () => {
    const out = evaluateConditions(snap({ properties: [prop({ dscr: 1.09 })] }), opts);
    expect(out.find((i) => i.id === 'dscr-floor-p1')?.severity).toBe('critical');
    expect(out.some((i) => i.id === 'dscr-p1')).toBe(false);
  });
  it('DSCR 1.10–1.25 is a covenant watch warning', () => {
    const out = evaluateConditions(snap({ properties: [prop({ dscr: 1.2 })] }), opts);
    expect(out.find((i) => i.id === 'dscr-p1')?.severity).toBe('warning');
  });
  it('DSCR >= 1.25 does not fire', () => {
    const out = evaluateConditions(snap({ properties: [prop({ dscr: 1.25 })] }), opts);
    expect(out.some((i) => i.id.startsWith('dscr'))).toBe(false);
  });
  it('LTV > 65% is a warning', () => {
    const out = evaluateConditions(snap({ properties: [prop({ ltv: 0.66 })] }), opts);
    expect(out.find((i) => i.id === 'ltv-p1')?.severity).toBe('warning');
  });
  it('LTV at 65% does not fire', () => {
    const out = evaluateConditions(snap({ properties: [prop({ ltv: 0.65 })] }), opts);
    expect(out.some((i) => i.id === 'ltv-p1')).toBe(false);
  });
});

describe('evaluateConditions — leases', () => {
  it('expiring < 60d is critical', () => {
    const out = evaluateConditions(snap({ leases: [lease({ leaseEnd: iso(59) })] }), opts);
    expect(out.find((i) => i.id === 'expiring-l1')?.severity).toBe('critical');
  });
  it('expiring 60–180d is warning', () => {
    const out = evaluateConditions(snap({ leases: [lease({ leaseEnd: iso(120) })] }), opts);
    expect(out.find((i) => i.id === 'expiring-l1')?.severity).toBe('warning');
  });
  it('expiring beyond 180d does not fire', () => {
    const out = evaluateConditions(snap({ leases: [lease({ leaseEnd: iso(181) })] }), opts);
    expect(out.some((i) => i.id === 'expiring-l1')).toBe(false);
  });
  it('suppresses expiring when a renewal stage past Expiring exists', () => {
    const out = evaluateConditions(snap({ leases: [lease({ leaseEnd: iso(30) })], renewalStages: { l1: 'Negotiating' } }), opts);
    expect(out.some((i) => i.id === 'expiring-l1')).toBe(false);
  });
  it('still fires expiring when stage is Expiring (no action yet)', () => {
    const out = evaluateConditions(snap({ leases: [lease({ leaseEnd: iso(30) })], renewalStages: { l1: 'Expiring' } }), opts);
    expect(out.some((i) => i.id === 'expiring-l1')).toBe(true);
  });
  it('holdover (status Expired) is a warning', () => {
    const out = evaluateConditions(snap({ leases: [lease({ status: 'Expired' })] }), opts);
    expect(out.find((i) => i.id === 'expired-l1')?.severity).toBe('warning');
  });
  it('escalation date in the past is a warning reminder', () => {
    const out = evaluateConditions(snap({ leases: [lease({ escalationDate: iso(-5) })] }), opts);
    expect(out.find((i) => i.id === 'escalation-l1')?.severity).toBe('warning');
  });
  it('future escalation date does not fire', () => {
    const out = evaluateConditions(snap({ leases: [lease({ escalationDate: iso(30) })] }), opts);
    expect(out.some((i) => i.id === 'escalation-l1')).toBe(false);
  });
});

describe('evaluateConditions — concentration, insurance, cash', () => {
  it('tenant > 15% of portfolio NOI is an info concentration alert', () => {
    const s = snap({
      properties: [prop({ id: 'p1', noi: 100000 })],
      leases: [
        lease({ id: 'l1', company: 'BigTenant', propertyId: 'p1', annualRent: 80000 }),
        lease({ id: 'l2', company: 'SmallTenant', propertyId: 'p1', annualRent: 20000 }),
      ],
    });
    const out = evaluateConditions(s, opts);
    expect(out.find((i) => i.category === 'concentration' && i.id.startsWith('concentration-'))?.severity).toBe('info');
  });
  it('lapsed policy is critical', () => {
    const out = evaluateConditions(snap({ insurance: [policy({ status: 'Expired' })] }), opts);
    expect(out.find((i) => i.id === 'ins-lapsed-i1')?.severity).toBe('critical');
  });
  it('policy renewing within 30d is a warning', () => {
    const out = evaluateConditions(snap({ insurance: [policy({ daysToExpiry: 20, expires: iso(20) })] }), opts);
    expect(out.find((i) => i.id === 'ins-i1')?.severity).toBe('warning');
  });
  it('cash concentration > 30% is a warning', () => {
    const out = evaluateConditions(snap({ cash: { asOf: ASOF, totalCash: 100, activeEntities: 2, largestEntity: 'E1', concentrationTopPct: 0.31, cagr: null, entities: [], history: [] } }), opts);
    expect(out.find((i) => i.id === 'cash-concentration')?.severity).toBe('warning');
  });
  it('cash concentration at 30% does not fire', () => {
    const out = evaluateConditions(snap({ cash: { asOf: ASOF, totalCash: 100, activeEntities: 2, largestEntity: 'E1', concentrationTopPct: 0.3, cagr: null, entities: [], history: [] } }), opts);
    expect(out.some((i) => i.id === 'cash-concentration')).toBe(false);
  });
});

describe('evaluateConditions — data quality & deals', () => {
  it('a reconciliation flag fires a critical data alert', () => {
    const out = evaluateConditions(snap({ dataQuality: [{ entity: 'reconciliation', field: 'NOI total', issue: 'mismatch', severity: 'error' }] }), opts);
    expect(out.find((i) => i.id === 'reconcile-fail')?.severity).toBe('critical');
    expect(out.find((i) => i.id === 'reconcile-fail')?.category).toBe('data');
  });
  it('non-reconciliation flags do not fire the reconcile alert', () => {
    const out = evaluateConditions(snap({ dataQuality: [{ entity: 'p1', field: 'noi', issue: 'bad source', severity: 'warn' }] }), opts);
    expect(out.some((i) => i.id === 'reconcile-fail')).toBe(false);
  });
  it('workbook older than 48h is an info alert', () => {
    const stale = { ...snap(), meta: { schemaVersion: '1.0.0', asOf: ASOF, generatedAt: new Date(NOW - 49 * 3_600_000).toISOString(), source: 't', scenario: 'Base' } } as unknown as PortfolioSnapshot;
    const out = evaluateConditions(stale, opts);
    expect(out.find((i) => i.id === 'workbook-stale')?.severity).toBe('info');
  });
  it('workbook within 48h does not fire', () => {
    const fresh = { ...snap(), meta: { schemaVersion: '1.0.0', asOf: ASOF, generatedAt: new Date(NOW - 47 * 3_600_000).toISOString(), source: 't', scenario: 'Base' } } as unknown as PortfolioSnapshot;
    const out = evaluateConditions(fresh, opts);
    expect(out.some((i) => i.id === 'workbook-stale')).toBe(false);
  });
  it('LOI/PSA deadline within 14d is a warning', () => {
    const out = evaluateConditions(snap({ deals: [deal({ stage: 'LOI/PSA', targetCloseDate: iso(7) })] }), opts);
    expect(out.find((i) => i.id === 'loi-d1')?.severity).toBe('warning');
  });
  it('deal stage-move fires only when priorStages is supplied', () => {
    const withPrior = evaluateConditions(snap({ deals: [deal({ id: 'd1', stage: 'Closing' })] }), { now: NOW, priorStages: { d1: 'Due Diligence' } });
    expect(withPrior.find((i) => i.id === 'move-d1')?.category).toBe('deal');
    const noPrior = evaluateConditions(snap({ deals: [deal({ id: 'd1', stage: 'Closing' })] }), opts);
    expect(noPrior.some((i) => i.id === 'move-d1')).toBe(false);
  });
  it('sorts critical before warning before info', () => {
    const out = evaluateConditions(snap({
      properties: [prop({ id: 'p1', dscr: 1.05, ltv: 0.7 })],
      cash: { asOf: ASOF, totalCash: 100, activeEntities: 2, largestEntity: 'E1', concentrationTopPct: 0.4, cagr: null, entities: [], history: [] },
    }), opts);
    const ranks = out.map((i) => ({ critical: 0, warning: 1, info: 2 })[i.severity]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });
});

describe('ALERT_THRESHOLDS', () => {
  it('exposes the canonical numbers', () => {
    expect(ALERT_THRESHOLDS.leaseCriticalDays).toBe(60);
    expect(ALERT_THRESHOLDS.leaseWarningDays).toBe(180);
    expect(ALERT_THRESHOLDS.cashConcentrationWarn).toBe(0.3);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run tests/unit/conditions.test.ts`
Expected: FAIL — cannot find module `@analytics/index` export `evaluateConditions`.

- [ ] **Step 4: Write the implementation**

Create `src/analytics/conditions.ts`:

```typescript
import type { PortfolioSnapshot } from '@contracts/index';
import { fmtUsd, fmtUsdCompact, fmtPct, fmtMonths, fmtDate } from './format';
import type { Insight, InsightSeverity } from './types';
import { tenantScorecards } from '@/brain/tenants';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const daysBetween = (isoTarget: string, isoFrom: string): number =>
  Math.round((new Date(isoTarget).getTime() - new Date(isoFrom).getTime()) / DAY_MS);

/** Single source of truth for every alert threshold. Change a number once, here. */
export const ALERT_THRESHOLDS = {
  balloonCriticalDays: 180,
  balloonWarningDays: 365,
  dscrFloor: 1.1,
  dscrWatch: 1.25,
  ltvCeiling: 0.65,
  leaseCriticalDays: 60,
  leaseWarningDays: 180,
  insuranceRenewWarnDays: 30,
  cashConcentrationWarn: 0.3,
  tenantNoiConcentrationInfo: 0.15,
  workbookStaleHours: 48,
  loiDeadlineWarnDays: 14,
} as const;

export interface EvaluateOpts {
  /** Wall-clock now (ms) for the workbook-stale check. Defaults to Date.now(); injected in tests. */
  now?: number;
  /** dealId → stage at last brief. Supplied only by the email brief to emit stage-move alerts. */
  priorStages?: Record<string, string>;
}

/**
 * The single canonical alert engine. Pure. Replaces generateInsights + extendedInsights.
 * Date math uses the snapshot's asOf (stable across a refresh); only the workbook-stale check
 * uses wall-clock now.
 */
export function evaluateConditions(s: PortfolioSnapshot, opts: EvaluateOpts = {}): Insight[] {
  const T = ALERT_THRESHOLDS;
  const asOf = s.meta.asOf;
  const now = opts.now ?? Date.now();
  const out: Insight[] = [];

  // ── Debt ──────────────────────────────────────────────────────────────────
  for (const l of s.loans) {
    if (l.balloon && l.maturity) {
      const days = daysBetween(l.maturity, asOf);
      if (days <= T.balloonWarningDays) {
        out.push({
          id: `balloon-${l.id}`,
          severity: days < T.balloonCriticalDays ? 'critical' : 'warning',
          category: 'debt',
          title: `Balloon due — ${l.name}`,
          detail: `${fmtUsd(l.absBalance)} balance, balloon ${fmtDate(l.maturity)} (${fmtMonths(l.monthsToMaturity ?? days / 30)}). Prepare refinance or payoff.`,
          metric: fmtUsd(l.absBalance),
          entityType: 'loan',
          entityId: l.id,
          action: { label: 'Open refi workspace', kind: 'open-refi' },
        });
      }
    }
  }

  for (const p of s.properties) {
    if (p.dscr !== null && p.dscr < T.dscrFloor) {
      out.push({
        id: `dscr-floor-${p.id}`, severity: 'critical', category: 'debt',
        title: `DSCR below floor — ${p.name}`,
        detail: `Debt-service coverage is ${p.dscr.toFixed(2)}x (below ${T.dscrFloor.toFixed(2)}x floor). Lender-remedy risk — act now.`,
        metric: `${p.dscr.toFixed(2)}x`, entityType: 'property', entityId: p.id,
      });
    } else if (p.dscr !== null && p.dscr < T.dscrWatch) {
      out.push({
        id: `dscr-${p.id}`, severity: 'warning', category: 'debt',
        title: `DSCR below 1.25 — ${p.name}`,
        detail: `Debt-service coverage is ${p.dscr.toFixed(2)}x (covenant watch). Review the loan.`,
        metric: `${p.dscr.toFixed(2)}x`, entityType: 'property', entityId: p.id,
      });
    }
    if (p.ltv !== null && p.ltv > T.ltvCeiling) {
      out.push({
        id: `ltv-${p.id}`, severity: 'warning', category: 'debt',
        title: `LTV above 65% — ${p.name}`,
        detail: `Loan-to-value is ${fmtPct(p.ltv)} (above the ${fmtPct(T.ltvCeiling)} ceiling).`,
        metric: fmtPct(p.ltv), entityType: 'property', entityId: p.id,
      });
    }
  }

  // ── Leases ────────────────────────────────────────────────────────────────
  for (const l of s.leases) {
    if (l.status === 'Expired') {
      out.push({
        id: `expired-${l.id}`, severity: 'warning', category: 'lease',
        title: `Lease expired — ${l.company ?? l.tenantName}`,
        detail: `${l.propertyKey} ${l.unit ?? ''} · ${fmtUsdCompact(l.annualRent)}/yr holding over. Resolve renewal or vacate.`,
        metric: fmtUsdCompact(l.annualRent), entityType: 'lease', entityId: l.id,
        action: { label: 'Draft renewal', kind: 'draft-renewal' },
      });
    } else if (l.leaseEnd) {
      const days = daysBetween(l.leaseEnd, asOf);
      const stage = s.renewalStages[l.id];
      const renewalUnderway = stage !== undefined && stage !== 'Expiring';
      if (days >= 0 && days <= T.leaseWarningDays && !renewalUnderway) {
        out.push({
          id: `expiring-${l.id}`,
          severity: days < T.leaseCriticalDays ? 'critical' : 'warning',
          category: 'lease',
          title: `Lease expiring — ${l.company ?? l.tenantName}`,
          detail: `${l.propertyKey} ${l.unit ?? ''} expires ${fmtDate(l.leaseEnd)} (${days}d). ${fmtUsdCompact(l.annualRent)}/yr at risk.`,
          metric: `${days}d`, entityType: 'lease', entityId: l.id,
          action: { label: 'Draft renewal', kind: 'draft-renewal' },
        });
      }
    }
    if (l.escalationDate && daysBetween(l.escalationDate, asOf) < 0) {
      out.push({
        id: `escalation-${l.id}`, severity: 'warning', category: 'lease',
        title: `Escalation date passed — ${l.company ?? l.tenantName}`,
        detail: `${l.propertyKey} ${l.unit ?? ''} escalation was due ${fmtDate(l.escalationDate)}. Confirm the bump was applied.`,
        entityType: 'lease', entityId: l.id,
      });
    }
  }

  // ── Revenue concentration (tenant > 15% of portfolio NOI) ───────────────────
  for (const t of tenantScorecards(s)) {
    if (t.pctNoi > T.tenantNoiConcentrationInfo) {
      out.push({
        id: `concentration-${t.id}`, severity: 'info', category: 'concentration',
        title: `Tenant concentration — ${t.name}`,
        detail: `${t.name} is ${fmtPct(t.pctNoi)} of portfolio NOI across ${t.properties.length} ${t.properties.length === 1 ? 'property' : 'properties'}.`,
        metric: fmtPct(t.pctNoi),
      });
    }
  }

  // ── Insurance ───────────────────────────────────────────────────────────────
  for (const p of s.insurance) {
    if (p.status === 'Expired' || p.status === 'Cancelled') {
      out.push({
        id: `ins-lapsed-${p.id}`, severity: 'critical', category: 'insurance',
        title: `Policy ${p.status.toLowerCase()} — ${p.property}`,
        detail: `${p.coverage ?? 'Coverage'} · ${p.carrier ?? ''}. Confirm replacement coverage is bound.`,
        metric: fmtUsdCompact(p.premium), entityType: 'insurance', entityId: p.id,
        action: { label: 'Review policy', kind: 'review' },
      });
    } else if (p.daysToExpiry !== null && p.daysToExpiry >= 0 && p.daysToExpiry < T.insuranceRenewWarnDays) {
      out.push({
        id: `ins-${p.id}`, severity: 'warning', category: 'insurance',
        title: `Insurance renewing soon — ${p.property}`,
        detail: `${p.coverage ?? 'Coverage'} renews ${fmtDate(p.expires)} (${p.daysToExpiry}d).`,
        entityType: 'insurance', entityId: p.id,
        action: { label: 'Review policy', kind: 'review' },
      });
    }
  }

  // ── Cash concentration ──────────────────────────────────────────────────────
  if (s.cash.concentrationTopPct !== null && s.cash.concentrationTopPct > T.cashConcentrationWarn) {
    out.push({
      id: 'cash-concentration', severity: 'warning', category: 'concentration',
      title: `Cash concentration — ${s.cash.largestEntity}`,
      detail: `${fmtPct(s.cash.concentrationTopPct)} of total cash sits in one entity (above the ${fmtPct(T.cashConcentrationWarn)} ceiling).`,
      metric: fmtPct(s.cash.concentrationTopPct), entityType: 'cashEntity',
    });
  }

  // ── Data quality ────────────────────────────────────────────────────────────
  const reconFlags = s.dataQuality.filter((f) => f.entity === 'reconciliation');
  if (reconFlags.length > 0) {
    out.push({
      id: 'reconcile-fail', severity: 'critical', category: 'data',
      title: 'Reconciliation failure',
      detail: `${reconFlags.length} invariant ${reconFlags.length === 1 ? 'breach' : 'breaches'} (${reconFlags.map((f) => f.field).join(', ')}). Derived totals do not match the workbook.`,
      metric: String(reconFlags.length),
    });
  }
  const ageHrs = (now - new Date(s.meta.generatedAt).getTime()) / HOUR_MS;
  if (ageHrs > T.workbookStaleHours) {
    out.push({
      id: 'workbook-stale', severity: 'info', category: 'data',
      title: 'Workbook data is stale',
      detail: `Last parsed ${fmtDate(s.meta.generatedAt)} — ${Math.round(ageHrs)}h ago (over the ${T.workbookStaleHours}h limit). Refresh the source.`,
      metric: `${Math.round(ageHrs)}h`,
    });
  }

  // ── Deals ────────────────────────────────────────────────────────────────────
  for (const d of s.deals) {
    if (d.stage === 'LOI/PSA' && d.targetCloseDate) {
      const days = daysBetween(d.targetCloseDate, asOf);
      if (days >= 0 && days <= T.loiDeadlineWarnDays) {
        out.push({
          id: `loi-${d.id}`, severity: 'warning', category: 'deal',
          title: `LOI/PSA deadline — ${d.shortName ?? d.name}`,
          detail: `Target close ${fmtDate(d.targetCloseDate)} (${days}d). ${d.nextAction ?? 'Confirm next step.'}`,
          metric: `${days}d`, entityType: 'deal', entityId: d.id,
        });
      }
    }
  }
  const prior = opts.priorStages;
  if (prior && Object.keys(prior).length > 0) {
    for (const d of s.deals) {
      const from = prior[d.id];
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

  const rank: Record<InsightSeverity, number> = { critical: 0, warning: 1, info: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
```

- [ ] **Step 5: Add the barrel export**

In `src/analytics/index.ts`, append:

```typescript
export * from './conditions';
```

- [ ] **Step 6: Run to verify it passes**

Run: `npx vitest run tests/unit/conditions.test.ts`
Expected: PASS (all conditions + ALERT_THRESHOLDS tests).

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors. (`generateInsights` still exists and is unused-by-this-file — that's fine; it is removed in Task 2.)

- [ ] **Step 8: Commit**

```bash
git add src/analytics/conditions.ts src/analytics/types.ts src/analytics/index.ts tests/unit/conditions.test.ts
git commit -m "feat(alerts): canonical evaluateConditions engine + ALERT_THRESHOLDS"
```

---

## Task 2: Route analytics + AI tool through the engine; remove `generateInsights`

**Files:**
- Modify: `src/analytics/engine.ts` (delete `generateInsights`, lines ~267–379; update `buildAnalytics` ~396)
- Modify: `server/ai/tools.ts` (import + call site, lines 8 and 241)
- Modify: `tests/unit/analytics.test.ts` (remove `generateInsights` import + describe block)

- [ ] **Step 1: Update `buildAnalytics` to call the new engine**

In `src/analytics/engine.ts`, add an import near the top (after the `./format` import on line 11):

```typescript
import { evaluateConditions } from './conditions';
```

Change the `insights:` line inside `buildAnalytics` (currently `insights: generateInsights(s),`) to:

```typescript
    insights: evaluateConditions(s),
```

- [ ] **Step 2: Delete the old `generateInsights`**

Delete the entire `export function generateInsights(s: PortfolioSnapshot): Insight[] { ... }` block (from `export function generateInsights` through its closing `}` — the function ending with the `rank`/sort return). Leave the `// ── Compose the full bundle ──` comment and `buildAnalytics` intact.

- [ ] **Step 3: Update the AI tool**

In `server/ai/tools.ts` line 8, change the import of `generateInsights` (within the `from '../../src/analytics/engine'` import group) to import `evaluateConditions` from the barrel instead. Specifically, remove `generateInsights` from the engine import and add this import alongside the other analytics imports:

```typescript
import { evaluateConditions } from '../../src/analytics/conditions';
```

At line ~241, change:

```typescript
    const insights = generateInsights(s);
```

to:

```typescript
    const insights = evaluateConditions(s);
```

- [ ] **Step 4: Update `analytics.test.ts`**

In `tests/unit/analytics.test.ts`: remove `generateInsights,` from the import block (lines 3–15), and delete the entire `describe('generateInsights', () => { ... });` block (lines ~319–353). These behaviors are now covered by `tests/unit/conditions.test.ts`.

- [ ] **Step 5: Typecheck + run affected tests**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors (no remaining references to `generateInsights`).

Run: `npx vitest run tests/unit/analytics.test.ts tests/unit/conditions.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/analytics/engine.ts server/ai/tools.ts tests/unit/analytics.test.ts
git commit -m "refactor(alerts): route analytics bundle + AI tool through evaluateConditions"
```

---

## Task 3: Route the brief through the engine; remove `extendedInsights`

**Files:**
- Modify: `server/brief/run.ts` (lines 6, 30)
- Delete: `server/brief/alerts.ts`
- Delete: `tests/unit/brief-alerts.test.ts` (cases now in conditions.test.ts)

- [ ] **Step 1: Update the brief runner**

In `server/brief/run.ts`, replace the import on line 6:

```typescript
import { extendedInsights } from './alerts';
```

with:

```typescript
import { evaluateConditions } from '../../src/analytics/conditions';
```

Change line 30:

```typescript
  const insights = extendedInsights(snapshot, state.dealStages);
```

to:

```typescript
  const insights = evaluateConditions(snapshot, { priorStages: state.dealStages });
```

- [ ] **Step 2: Delete the dead engine + its test**

```bash
git rm server/brief/alerts.ts tests/unit/brief-alerts.test.ts
```

- [ ] **Step 3: Typecheck + run brief tests**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

Run: `npx vitest run tests/unit/brief-run.test.ts tests/unit/brief-render.test.ts tests/unit/brief-state.test.ts`
Expected: PASS (the brief consumes whatever the engine emits; stage-move + LOI + DSCR-watch still present via `evaluateConditions` with `priorStages`).

- [ ] **Step 4: Commit**

```bash
git add server/brief/run.ts
git commit -m "refactor(alerts): brief consumes evaluateConditions; drop extendedInsights"
```

---

## Task 4: Single-source the calendar urgency strip

**Files:**
- Modify: `src/brain/critical-dates.ts` (`urgencyOf`, lines ~25–30)
- Test: `tests/unit/critical-dates.test.ts` (append one assertion)

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/critical-dates.test.ts` (inside the top-level `describe`, or add a new `describe`):

```typescript
import { ALERT_THRESHOLDS } from '@analytics/index';

describe('calendar urgency is single-sourced from ALERT_THRESHOLDS', () => {
  it('uses the lease alert cutoffs (60 / 180)', () => {
    expect(ALERT_THRESHOLDS.leaseCriticalDays).toBe(60);
    expect(ALERT_THRESHOLDS.leaseWarningDays).toBe(180);
  });
});
```

(If `critical-dates.test.ts` already imports from `@analytics/index`, merge the import rather than duplicating it.)

- [ ] **Step 2: Run to confirm it passes against current constants, then refactor source**

Run: `npx vitest run tests/unit/critical-dates.test.ts`
Expected: PASS (asserts the constants exist; the refactor below keeps behavior identical).

- [ ] **Step 3: Source `urgencyOf` from the shared config**

In `src/brain/critical-dates.ts`, add to the imports at the top:

```typescript
import { ALERT_THRESHOLDS } from '@analytics/index';
```

Replace the `urgencyOf` function (lines ~25–30):

```typescript
/** Critical < 60d (incl. overdue), Warning 60–180d, else normal. */
function urgencyOf(daysToDate: number): CalendarUrgency {
  if (daysToDate < 60) return 'critical';
  if (daysToDate < 180) return 'warning';
  return 'normal';
}
```

with:

```typescript
/** Critical < leaseCriticalDays (incl. overdue), Warning < leaseWarningDays, else normal. Single-sourced. */
function urgencyOf(daysToDate: number): CalendarUrgency {
  if (daysToDate < ALERT_THRESHOLDS.leaseCriticalDays) return 'critical';
  if (daysToDate < ALERT_THRESHOLDS.leaseWarningDays) return 'warning';
  return 'normal';
}
```

- [ ] **Step 4: Typecheck + run the full calendar test**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

Run: `npx vitest run tests/unit/critical-dates.test.ts`
Expected: PASS (urgency tiers unchanged — same numbers, now single-sourced).

- [ ] **Step 5: Commit**

```bash
git add src/brain/critical-dates.ts tests/unit/critical-dates.test.ts
git commit -m "refactor(calendar): source urgency cutoffs from ALERT_THRESHOLDS"
```

---

## Task 5: `insightToDraft` mapping helper

**Files:**
- Modify: `src/brain/draft.ts` (add export)
- Test: `tests/unit/draft.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/draft.test.ts`:

```typescript
import { insightToDraft } from '@/brain/draft';
import type { Insight } from '@analytics/index';

const ins = (over: Partial<Insight>): Insight => ({
  id: 'x', severity: 'warning', category: 'lease', title: 't', detail: 'd', ...over,
});

describe('insightToDraft', () => {
  it('maps a draft-renewal lease insight to a renewal draft', () => {
    const r = insightToDraft(ins({ entityType: 'lease', entityId: 'l1', action: { label: 'Draft renewal', kind: 'draft-renewal' } }));
    expect(r).toEqual({ kind: 'renewal', entity: { type: 'lease', id: 'l1' } });
  });
  it('maps an open-refi loan insight to a refi draft', () => {
    const r = insightToDraft(ins({ category: 'debt', entityType: 'loan', entityId: 'n1', action: { label: 'Open refi workspace', kind: 'open-refi' } }));
    expect(r).toEqual({ kind: 'refi', entity: { type: 'loan', id: 'n1' } });
  });
  it('maps a review insurance insight to an insurance draft', () => {
    const r = insightToDraft(ins({ category: 'insurance', entityType: 'insurance', entityId: 'i1', action: { label: 'Review policy', kind: 'review' } }));
    expect(r).toEqual({ kind: 'insurance', entity: { type: 'insurance', id: 'i1' } });
  });
  it('returns null when there is no action', () => {
    expect(insightToDraft(ins({ entityType: 'lease', entityId: 'l1' }))).toBeNull();
  });
  it('returns null when the action kind has no draft (e.g. open-record)', () => {
    expect(insightToDraft(ins({ entityType: 'property', entityId: 'p1', action: { label: 'View', kind: 'open-record' } }))).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/draft.test.ts`
Expected: FAIL — `insightToDraft` is not exported.

- [ ] **Step 3: Implement the helper**

In `src/brain/draft.ts`, add the import for `Insight` at the top (merge into the existing `@analytics/index` import on line 2):

```typescript
import { fmtUsd, fmtDate } from '@analytics/index';
import type { Insight } from '@analytics/index';
```

Add at the end of the file:

```typescript
/**
 * Map an alert's action to a draft request, or null when no draft applies.
 * Only kinds that buildDraft can render are mapped (renewal/refi/insurance).
 */
export function insightToDraft(i: Insight): DraftRequest | null {
  if (!i.action || !i.entityType || !i.entityId) return null;
  switch (i.action.kind) {
    case 'draft-renewal':
      return i.entityType === 'lease' ? { kind: 'renewal', entity: { type: 'lease', id: i.entityId } } : null;
    case 'open-refi':
      return i.entityType === 'loan' ? { kind: 'refi', entity: { type: 'loan', id: i.entityId } } : null;
    case 'review':
      return i.entityType === 'insurance' ? { kind: 'insurance', entity: { type: 'insurance', id: i.entityId } } : null;
    default:
      return null;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/draft.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/brain/draft.ts tests/unit/draft.test.ts
git commit -m "feat(alerts): insightToDraft action→draft mapping"
```

---

## Task 6: Wire actions into the Overview insight list

**Files:**
- Modify: `src/modules/overview/InsightList.tsx`

- [ ] **Step 1: Replace the action cell**

In `src/modules/overview/InsightList.tsx`:

Update the imports (lines 1–4) to add the `Mail` icon and `insightToDraft`:

```tsx
import { AlertTriangle, AlertCircle, Info, ArrowRight, Mail } from 'lucide-react';
import type { Insight, InsightSeverity } from '@analytics/index';
import { Button } from '@/primitives/Button';
import { useUi } from '@/brain/ui-context';
import { insightToDraft } from '@/brain/draft';
```

Replace the action block (lines 52–61, the `{i.entityType && i.entityId && ( ... )}` JSX) with:

```tsx
            {i.entityType && i.entityId && (
              <div className="flex shrink-0 items-center gap-1 pt-0.5">
                {(() => {
                  const draft = insightToDraft(i);
                  return draft ? (
                    <Button size="sm" variant="ghost" onPress={() => ui.openDraft(draft)}>
                      <Mail size={12} />
                      Draft
                    </Button>
                  ) : null;
                })()}
                <Button size="sm" variant="ghost" onPress={() => ui.openEntity({ type: i.entityType!, id: i.entityId! })}>
                  View
                  <ArrowRight size={12} />
                </Button>
              </div>
            )}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/modules/overview/InsightList.tsx
git commit -m "feat(alerts): wire deep-link + draft CTA into Overview insights"
```

---

## Task 7: Wire actions into the Alerts module

**Files:**
- Modify: `src/modules/alerts/AlertsModule.tsx`

- [ ] **Step 1: Add UI context + action helper to the imports**

In `src/modules/alerts/AlertsModule.tsx`, replace the import block (lines 1–2) with:

```tsx
import { Mail, ArrowRight } from 'lucide-react';
import { useAlertView, useAlertAction } from '../../data/alerts';
import type { AlertViewItem } from '../../brain/alerts-view';
import { useUi } from '../../brain/ui-context';
import { insightToDraft } from '../../brain/draft';
```

- [ ] **Step 2: Pass UI handlers into each row**

In the `AlertsModule` component, add `const ui = useUi();` after `const action = useAlertAction();` (line ~12). Then update the `<AlertRow ... />` usage (lines ~30–37) to pass deep-link and draft handlers:

```tsx
            <AlertRow
              key={item.insight.id}
              item={item}
              onRead={() => action.mutate({ alertId: item.insight.id, action: item.read ? 'unread' : 'read' })}
              onSnooze={(days) =>
                action.mutate({ alertId: item.insight.id, action: 'snooze', days, severity: item.insight.severity })
              }
              onOpen={
                item.insight.entityType && item.insight.entityId
                  ? () => ui.openEntity({ type: item.insight.entityType!, id: item.insight.entityId! })
                  : null
              }
              onDraft={(() => {
                const d = insightToDraft(item.insight);
                return d ? () => ui.openDraft(d) : null;
              })()}
            />
```

- [ ] **Step 3: Render the new buttons in `AlertRow`**

Replace the `AlertRow` function (lines ~54–78) with:

```tsx
function AlertRow({
  item, onRead, onSnooze, onOpen, onDraft,
}: {
  item: AlertViewItem;
  onRead: () => void;
  onSnooze: (days: 7 | 30) => void;
  onOpen: (() => void) | null;
  onDraft: (() => void) | null;
}) {
  const c = SEV_COLOR[item.insight.severity] ?? '#5c9fe0';
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
        <div className="flex shrink-0 items-center gap-1.5">
          {onDraft && (
            <button className="flex items-center gap-1 text-2xs" style={{ color: 'var(--accent)' }} onClick={onDraft} aria-label="Draft email">
              <Mail size={11} /> Draft
            </button>
          )}
          {onOpen && (
            <button className="flex items-center gap-1 text-2xs" style={{ color: 'var(--text-secondary)' }} onClick={onOpen} aria-label="Open record">
              View <ArrowRight size={11} />
            </button>
          )}
          <button className="text-2xs" style={{ color: 'var(--text-tertiary)' }} onClick={() => onSnooze(7)}>Snooze 7d</button>
          <button className="text-2xs" style={{ color: 'var(--text-tertiary)' }} onClick={() => onSnooze(30)}>30d</button>
          <button className="text-2xs" style={{ color: 'var(--accent)' }} onClick={onRead}>{item.read ? 'Unread' : 'Mark read'}</button>
        </div>
      </div>
    </li>
  );
}
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/modules/alerts/AlertsModule.tsx
git commit -m "feat(alerts): wire deep-link + draft CTA into the Alerts inbox"
```

---

## Task 8: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Full gate**

Run: `npm run gate`
Expected: typecheck + lint (`--max-warnings 0`) + all tests + reconcile all green.

- [ ] **Step 2: Production build (chunk budget)**

Run: `npm run build`
Expected: build succeeds; no chunk-size regression beyond existing budget.

- [ ] **Step 3: Verify the engine end-to-end against a fresh server**

Start a FRESH Brain Server (do not reuse the long-running dev server — it accumulates stale HMR state):

```bash
node_modules/.bin/tsx server/index.ts
```

Then confirm alerts surface identically and actions still work:

```bash
curl -s http://localhost:8911/api/alerts/state
# Expected: {"read":[...],"snoozed":{...}} (existing inbox state, unaffected by the engine change)
```

Open the app on a clean reload (`:5273`), then with the preview tools:
- Navigate to `/alerts`: the stat strip + grouped list render; rows now show **Draft** (where applicable) and **View** alongside snooze/mark-read.
- Click **View** on an alert with an entity → the entity drawer opens.
- Click **Draft** on a lease/loan/insurance alert → the draft composer opens with a pre-filled draft.
- Navigate to `/overview`: the insight list shows the same **Draft** + **View** actions.
- Navigate to `/calendar`: the urgency KPI strip still groups correctly (60/180-day tiers unchanged).
- Confirm no console errors via the preview console-logs tool.

- [ ] **Step 4: Confirm gitignored write surface unchanged**

Run: `git status`
Expected: no `data/` files staged; only source/test/doc changes across the branch.

- [ ] **Step 5: Final commit (if any verification fixups were needed)**

```bash
git add -A
git commit -m "chore(alerts): final verification fixups"
```

(Skip if nothing changed.)

---

## Self-Review

**Spec coverage:**
- 14-condition catalog → Task 1 (each row has a boundary test) ✔ (condition 12 entity-below-floor deliberately deferred per spec; condition 7 ships as the spine-only reminder).
- One isomorphic engine in `src/analytics` → Tasks 1–3 ✔
- Brief + inbox + Overview share one engine → Tasks 2, 3 ✔
- `ALERT_THRESHOLDS` also drives calendar urgency → Task 4 ✔
- Per-alert deep-link + draft CTA → Tasks 5–7 ✔
- ID stability (snooze/read survive) → Task 1 reuses `balloon-/expiring-/expired-/dscr-/ins-/cash-concentration/loi-/move-` ids ✔
- `noUncheckedIndexedAccess` clean → every Record index (`renewalStages[l.id]`, `priorStages[d.id]`) guarded; `rank[severity]` matches the existing pattern ✔
- Confidentiality → no new external surface; no confidential identifier in source/tests ✔

**Placeholder scan:** none — every code step shows full code; every run step shows the exact command + expected result.

**Type consistency:** `evaluateConditions(s, opts?)` signature is identical across Tasks 1–3; `insightToDraft` returns `DraftRequest | null` and is consumed the same way in Tasks 6–7; `ALERT_THRESHOLDS` field names (`leaseCriticalDays`, `leaseWarningDays`, `cashConcentrationWarn`, …) are identical in Tasks 1 and 4.
