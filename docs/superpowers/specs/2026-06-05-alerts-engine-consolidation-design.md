# Alerts Engine Consolidation — Design

**Date:** 2026-06-05
**Status:** Approved (design) — pending implementation plan
**Owner:** Gabriel Goldberg (ORA)
**Supersedes (threshold portions of):** `2026-06-04-command-center-expansion-design.md` Phase 1 alert catalog; `2026-06-04-daily-brief-alerts-design.md` engine

## Goal

Collapse the two divergent alert engines into **one canonical, isomorphic source of truth** that
implements the approved 14-condition catalog and feeds the email brief, the in-app Alerts inbox, and
the Overview insight list identically. Tighten thresholds to the catalog, and wire the per-alert
deep-link + draft-email actions that Phase 1 deferred.

This closes the three follow-ups the Phase 1 Alerts Inbox plan tracked as deferred:
1. Threshold reconciliation (the canonical `conditions` engine was never built).
2. Extended insights in the inbox (brief and in-app currently disagree).
3. Per-alert deep-link + draft CTA (stubbed as "Phase 5").

## Background — the problem being fixed

- The master design specified a single `server/alerts/conditions.ts`. It was never built; only
  `server/alerts/store.ts` (read/snooze state) shipped.
- The live engine `generateInsights` (`src/analytics/engine.ts`) still runs the **old** thresholds
  (balloon 18mo window / critical ≤9mo; lease ≤3mo warn-only; cash 25%/50%) and omits most of the
  catalog (DSCR floors, LTV ceiling, holdover, revenue concentration, insurance <30d,
  reconciliation failure, workbook stale).
- A second engine, `extendedInsights` (`server/brief/alerts.ts`), adds DSCR<1.25, lease 91–180d,
  LOI/PSA deadline, and deal stage-moves — but **only the email brief** calls it. The in-app inbox
  and Overview read `analytics.insights` (base `generateInsights` only), so those conditions never
  appear in-app. The two engines disagree.
- The Alerts inbox (`src/modules/alerts/AlertsModule.tsx`) and Overview
  (`src/modules/overview/InsightList.tsx`) expose only snooze/mark-read and a "View details" link;
  the `InsightAction.kind` carried on every insight is never wired to `ui.openDraft`.

## Architecture (locked decision)

**The canonical engine is isomorphic and lives in `src/analytics/conditions.ts`** — not server-only.
Rationale: the in-app inbox and Overview compute alerts **client-side**, and the deployed public
mirror is serverless (no Node). A server-only engine would leave the app and mirror unable to show
alerts. A shared `src/` module honors "one source of truth" while preserving offline-mirror
behavior. (Minor deviation from the master design's literal `server/alerts/conditions.ts` path,
which predated Phase 1's client-side choice.)

```
src/analytics/conditions.ts   ← ALERT_THRESHOLDS + evaluateConditions()  (pure, no Node deps)
        │
        ├── src/analytics/engine.ts  buildAnalytics() → evaluateConditions(s)        [client: inbox + Overview]
        └── server/brief/run.ts      evaluateConditions(s, { priorStages })          [server: email brief]
```

### Public surface

```ts
/** Single source of truth for every alert threshold. The only place these numbers live. */
export const ALERT_THRESHOLDS = {
  balloonCriticalDays: 180,
  balloonWarningDays: 365,
  dscrFloor: 1.10,
  dscrWatch: 1.25,
  ltvCeiling: 0.65,
  leaseCriticalDays: 60,
  leaseWarningDays: 180,
  insuranceRenewWarnDays: 30,
  cashConcentrationWarn: 0.30,
  tenantNoiConcentrationInfo: 0.15,
  workbookStaleHours: 48,
  loiDeadlineWarnDays: 14,
} as const;

/**
 * The canonical alert catalog. priorStages is supplied only by the email brief (server) to emit
 * deal stage-move alerts; the client omits it. now defaults to Date.now() — injectable for tests.
 */
export function evaluateConditions(
  s: PortfolioSnapshot,
  opts?: { now?: number; priorStages?: Record<string, string> },
): Insight[];
```

`evaluateConditions` **replaces** `generateInsights` and `extendedInsights`. `extendedInsights` is
removed; `server/brief/run.ts` calls `evaluateConditions(snapshot, { priorStages: state.dealStages })`.
`buildAnalytics` calls `evaluateConditions(s)`.

## The catalog

Severity sort order unchanged (critical → warning → info). Each row computable from the spine unless
noted.

| # | Condition | Severity | Threshold | Source | id |
|---|---|---|---|---|---|
| 1 | Balloon approaching | Critical / Warning | `<180d` / `180–365d` | `Loan.balloon` + maturity→days | `balloon-${loan.id}` |
| 2 | DSCR below floor | Critical | `< 1.10` | `Property.dscr` | `dscr-floor-${prop.id}` |
| 3 | DSCR covenant watch | Warning | `1.10 ≤ dscr < 1.25` | `Property.dscr` | `dscr-${prop.id}` |
| 4 | LTV above ceiling | Warning | `> 0.65` | `Property.ltv` | `ltv-${prop.id}` |
| 5 | Lease expiring, no renewal | Critical / Warning | `<60d` / `60–180d` | `Lease` + `renewalStages` (suppress if stage advanced past `Expiring`) | `expiring-${lease.id}` |
| 6 | Holdover | Warning | `status === 'Expired'` | `Lease.status` | `expired-${lease.id}` |
| 7 | Escalation date passed | Warning | `escalationDate < asOf` | `Lease.escalationDate` (spine-only reminder; no QB verification) | `escalation-${lease.id}` |
| 8 | Revenue concentration | Info | single tenant `> 15%` NOI | tenant NOI rollup | `concentration-${tenantSlug}` |
| 9 | Policy lapsed | Critical | status Expired/Cancelled | `InsurancePolicy.status` | `ins-lapsed-${pol.id}` |
| 10 | Insurance renewing soon | Warning | `< 30d` (`Renew Now`/daysToExpiry) | `InsurancePolicy` | `ins-${pol.id}` |
| 11 | Cash concentration | Warning | `> 30%` portfolio cash | `cash.concentrationTopPct` | `cash-concentration` |
| 12 | Entity below operating floor | — | **DEFERRED** | needs entity↔debt-service mapping not in QB export | (stub) |
| 13 | Reconciliation failure | Critical | any invariant flag | `snapshot.dataQuality` (reconcile/invariant kind) | `reconcile-fail-${flag}` |
| 14 | Workbook stale | Info | `> 48h` since generate | `meta.generatedAt` vs `now` | `workbook-stale` |

Preserved brief functionality, folded into the catalog:
- **LOI/PSA deadline** — Warning, `targetCloseDate` within 14d for `LOI/PSA`-stage deals. Now also
  surfaces in-app (was brief-only). id `loi-${deal.id}`.
- **Deal stage-move** — Info, emitted **only when `priorStages` is supplied** (brief context). id
  `move-${deal.id}`.

### ID stability

Existing snooze/read state in `data/alert-inbox.json` is keyed by alert id. Ids reused verbatim so
state survives: `balloon-`, `expiring-`, `expired-`, `dscr-`, `ins-`, `cash-concentration`,
`loi-`, `move-`. New conditions get new ids. Tightened thresholds may change an alert's severity;
the existing snooze-escalation rule in `buildAlertView` (warning→critical re-fires a snoozed alert)
handles that correctly — no migration needed.

## Threshold config reach

`ALERT_THRESHOLDS` is the source for all conditions **and** for `src/brain/critical-dates.ts`
`urgencyOf` — its `< 60` / `< 180` day cutoffs become `leaseCriticalDays` / `leaseWarningDays`
(identical numbers, now single-sourced). The calendar urgency strip therefore always matches the
lease-expiry alert tiers. The renewal 75-day window (`RENEWAL_WINDOW_DAYS`) stays its own constant
this pass (out of scope).

## Per-alert actions

Add to `src/brain/draft.ts`:

```ts
/** Map an insight's action to a draft request, or null when no draft applies. */
export function insightToDraft(i: Insight): DraftRequest | null;
```

Mapping by `InsightAction.kind` + `entityType`/`entityId`:
- `draft-renewal` + lease → `{ kind: 'renewal', entity: { type: 'lease', id } }`
- `open-refi` + loan → `{ kind: 'refi', entity: { type: 'loan', id } }`
- `review` + insurance → `{ kind: 'insurance', entity: { type: 'insurance', id } }`
- otherwise → `null`

Wire into **both** surfaces (`AlertsModule.tsx`, `InsightList.tsx`): when `entityType`/`entityId`
present, a **deep-link** button → `ui.openEntity({ type, id })`; when `insightToDraft(i)` is non-null,
a **Draft** button → `ui.openDraft(req)`. Remove the "don't overpromise / Phase 5" stub comment in
`InsightList.tsx`.

## Testing

- **`tests/unit/conditions.test.ts`** (new) — boundary tests per condition from a fixture snapshot:
  balloon 179d→critical / 180d→warning / 366d→none; DSCR 1.09→floor / 1.20→watch / 1.25→none;
  LTV 0.66→warn / 0.65→none; lease 59d→critical / 60d→warning / 181d→none, suppressed when a
  renewal stage past `Expiring` exists; holdover on `Expired`; escalation passed; tenant 16%→info /
  15%→none; insurance lapsed→critical / 29d→warning; cash 31%→warn / 30%→none; a reconcile
  `dataQuality` flag→critical; stale 49h→info / 47h→none; LOI deadline within 14d; stage-move
  emitted only with `priorStages`. `now` injected for determinism.
- **`insightToDraft`** — each kind maps to the right `DraftRequest`; unmapped → null.
- **`critical-dates` urgency** — `urgencyOf` still returns the same tiers after sourcing from
  `ALERT_THRESHOLDS`.
- **Update** `tests/unit/analytics.test.ts` (engine now delegates to `evaluateConditions`) and
  `tests/unit/brief-alerts.test.ts` (`extendedInsights` removed → `evaluateConditions`).
- `npm run gate` green; `tsc --noEmit` clean under `noUncheckedIndexedAccess` (guard every Record
  index — `renewalStages[id]`, threshold maps, severity-rank maps).

## Confidentiality

No new external surface. In-app alerts for `confidential` deals appear only in live mode; the public
mirror redaction in the existing bake is unchanged. No confidential identifier appears in source,
tests, or this spec.

## Out of scope (deferred, tracked)

- **Entity-below-operating-floor** alert — needs per-entity debt-service linkage absent from the
  property-level QB export. Documented stub.
- **QB-verified escalation bump** — the spine-only "escalation date passed" reminder ships instead;
  true verification waits for per-lease rent actuals.
- Master-design deferrals unchanged: Notion task sync, per-partner tailored briefs, AI-narrative
  brief headline, multi-tenant scoping.
