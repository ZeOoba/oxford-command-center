# Oxford Command Center — 8-Feature Expansion (Master Design)

**Date:** 2026-06-04
**Status:** Approved (design) — pending implementation plans
**Owner:** Gabriel Goldberg (ORA)

## Goal

Turn the Command Center from a strong reporting dashboard into a proactive operating system for
the firm. Add eight features across three layers: an **alerting nervous system** that pushes, three
**operational UI modules** derived from the existing spine, and three **data-enrichment** upgrades
that make the whole system deeper. Every feature reuses the existing contract boundary
(`PortfolioSnapshot`), the overlay write-back pattern, and the freshness/provenance discipline
already in place.

## Scope note — this is a master design, implemented phase-by-phase

All eight features were brainstormed and mocked together so the architecture composes cleanly. They
are **not** one implementation plan. Each phase below is its own `plan → implement → verify` cycle.
**Phase 1 is the first plan.** Later phases may be re-validated against reality before they start.

## Relationship to existing specs

- **`2026-06-04-daily-brief-alerts-design.md`** designed the alert *engine* (`generateInsights` +
  `server/brief/*`), the email brief, same-day critical alerts, dedup state, and the Outlook send
  chain. That spec explicitly deferred the **in-app snooze/ack UI**. **This design's Phase 1 builds
  that UI** (the Alerts Inbox + shell bell) on top of the same engine and the same
  `data/alert-state.json`. The two share one alert catalog and one threshold config — no second
  engine. Where thresholds here differ from that earlier draft, **these supersede** (see
  *Threshold reconciliation*).
- **`2026-06-04-role-based-views-design.md`** established `principalDigest` and the profile-ordered
  rail. New modules below register in `MODULES` and inherit profile ordering automatically.

## Phase overview

| Phase | Features | Nature | Depends on |
|---|---|---|---|
| **1 — Infrastructure** | ④ Alerts Inbox + bell · ⑧ Background Monitor | Alert nervous system | existing brief engine |
| **2 — UI modules** | ① Critical Dates Calendar · ③ Renewal Pipeline · ⑥ Tenant Scorecard | Spine-derived, no new data | Phase 1 (inherit alerts) |
| **3 — Data enrichment** | ② NOI Variance + QB · ⑤ Semantic Search · ⑦ Deal Comps | External sources | independent of each other |

---

## PHASE 1 — Alerting nervous system

### Decisions (locked)

| Decision | Choice |
|---|---|
| Inbox placement | **Full `/alerts` module** in the rail (not a slide-over) — stat strip + filtering + snooze history |
| Bell icon | Header bell + unread badge as a **shortcut** to the module (present in all profiles) |
| Persistence | Reuse/extend `data/alert-state.json` (gitignored): adds `read[]`, `snoozedUntil{}` |
| Snooze | 7d / 30d; a snoozed alert **re-fires if severity escalates** (Warning→Critical) |
| Dedup key | `{conditionId}:{entityId}` — at most one fire per entity per day |
| Monitor cadence | Runs inside the existing hourly bake + 06:45 ET task (no new scheduler) |

### Components

- **`server/alerts/conditions.ts`** (pure) — the single threshold config + condition evaluators.
  `evaluateConditions(snapshot, priorState): Alert[]`. Categories: Debt, Leases, Insurance, Cash,
  Data Quality (full catalog under *Alert conditions* below). This is the one source of truth shared
  by the inbox API and the email brief.
- **`server/alerts/store.ts`** — load/save alert state (read/unread/snooze/dedup) atop the existing
  `alert-state.json` shape. Pure transitions, fixture-tested.
- **`/api/alerts`** (GET) — returns active alerts + their read/snooze state for the inbox.
  **`/api/actions/alert`** (POST) — `{ alertId, action: 'read'|'unread'|'snooze', days? }` → persists
  to state (live-server-only, same guard as other write-back actions).
- **`src/modules/alerts/AlertsModule.tsx`** — the `/alerts` route: stat strip (Critical / Warning /
  Info / Snoozed counts), severity-grouped list, per-alert actions (snooze, mark read, deep-link to
  entity drawer + the relevant draft-email CTA). Registered in `MODULES` (group Command).
- **`src/shell/AlertBell.tsx`** — header bell with unread count, links to `/alerts`.
- **Background monitor** — *no new process.* `evaluateConditions` runs at the end of the bake; new
  alerts persist to state and feed the existing brief/critical-email path. The inbox simply reads the
  same state on next load (or via SSE if the local server is live).

### Alert conditions (the approved catalog)

| Category | Condition | Severity | Threshold |
|---|---|---|---|
| Debt | Balloon approaching | Critical / Warning | `< 180d` / `180–365d` |
| Debt | DSCR below floor | Critical | `< 1.10×` |
| Debt | DSCR covenant watch | Warning | `< 1.25×` |
| Debt | LTV above ceiling | Warning | `> 65%` |
| Leases | Expiring, no renewal initiated | Critical / Warning | `< 60d` / `60–180d` |
| Leases | Holdover | Warning | status = holdover |
| Leases | Escalation date missed | Warning | passed + no bump *(Phase 3: QB)* |
| Leases | Revenue concentration | Info | single tenant `> 15%` NOI |
| Insurance | Policy lapsed | Critical | expiry passed |
| Insurance | Renewing soon | Warning | `< 30d` |
| Cash | Concentration in one entity | Warning | `> 30%` of portfolio cash |
| Cash | Entity below operating floor | Warning | `< 2mo` debt service *(Phase 3: QB)* |
| Data | Reconciliation failure | Critical | any invariant violation |
| Data | Workbook stale | Info | `> 48h` since parse |

### Threshold reconciliation (supersedes the brief draft)

The earlier brief spec used balloon ≤9mo, lease info-tier 91–180d, cash concentration ≥50%/≥25%.
**The table above is canonical** for both inbox and brief — they read the same
`conditions.ts`. The brief's renderer is unaffected (it consumes whatever the engine emits).

---

## PHASE 2 — Operational UI modules

All three are **spine-derived** (no new external data), register in `MODULES`, inherit profile
ordering + live freshness, and reuse the overlay write-back pattern.

### ① Critical Dates Calendar — `/calendar`

| Decision | Choice |
|---|---|
| Layout | **12-month horizon list** (not a monthly grid) — full event detail + urgency KPI strip |
| Events | Lease expirations, loan maturities, insurance renewals, rent escalations |
| Grouping | By month; color-coded by type; each row deep-links to the entity drawer |
| Filters | Type + window (90d / 12mo) |

- **`src/brain/critical-dates.ts`** (pure) — `criticalDates(snapshot, horizonMonths): DatedEvent[]`,
  sorted by date, tagged by type + urgency. Reuses the existing critical-dates derivation in the
  analytics engine; this is the module-facing aggregation.
- **`src/modules/calendar/CalendarModule.tsx`** — KPI strip (Critical `<60d` / Warning `<180d` /
  this-quarter / next-12mo counts) over a grouped, filterable list.

### ③ Lease Renewal Pipeline — `/renewals`

| Decision | Choice |
|---|---|
| Layout | **Kanban** (mirrors Acquisitions Pipeline) — Expiring → Outreach → Negotiating → LOI → Executed |
| **Window** | **Only leases expiring within 75 days** (or already in a renewal stage) — a "needs action now" board, not a full planner |
| Write-back | Stage advance via overlay (same mechanism as deal-stage); draft-email CTA per card |

- **`server/overlay.ts`** extension — add `renewalStages: Record<leaseId, RenewalStage>`; merged in
  `applyOverlay` exactly like `dealStages`. New endpoint `POST /api/actions/renewal-stage`.
- **`src/brain/renewals.ts`** (pure) — selects leases within the 75-day window (constant in
  `conditions.ts`) or carrying a renewal stage, groups by stage.
- **`src/modules/renewals/RenewalsModule.tsx`** — reuses the Acquisitions kanban column/card
  primitives.

### ⑥ Tenant Scorecard — `/tenants`

| Decision | Choice |
|---|---|
| Shape | Per-tenant aggregation across all their leases; click a row to expand the full scorecard |
| Columns | Tenant, properties, annual rent, **% portfolio NOI** (bar), expiry, renewal stage, **Health** |
| Health column | A/B/C/D — **shows "—" until Phase 3 QB**; the column exists from day one, unpopulated |
| Industry classification | **Skipped** (not tracked) |
| Notes | **Free-text notes box per tenant**, overlay-persisted (e.g. "Eric to follow up directly") |

- **`src/brain/tenants.ts`** (pure) — `tenantScorecards(snapshot): TenantScorecard[]` rolling leases
  up by tenant (rent, SF, % NOI, expiry, renewal stage). Health is a nullable field, populated only
  when QB data is present.
- **`server/overlay.ts`** extension — `tenantNotes: Record<tenantId, string>`; endpoint
  `POST /api/actions/tenant-note`.
- **`src/modules/tenants/TenantsModule.tsx`** — sortable table + expandable detail panel (lease
  detail · financial exposure · renewal status + notes + advance/draft actions).

---

## PHASE 3 — Data enrichment

Three independent upgrades; each unlocks richer data in the modules already shipped.

### ② NOI Variance + QuickBooks Desktop — `/close`

| Decision | Choice |
|---|---|
| Source | **QB Desktop → SharePoint CSV export → `server/sources/quickbooks.ts`**, parsed on the existing chokidar watch cycle (no manual step after setup) |
| Baseline | **Budget overlay** — per-property annual NOI targets entered once in-app (`overlay.json`), compared against QB actuals. (No per-property UW in the workbook → app owns the budget.) |
| Detail panel | Per-property monthly budget-vs-actual chart + variance summary + **QB expense detail by GL category** (renders whatever categories QB exports — no hardcoded assumptions) |
| Layout | Property table left; selected property opens a **drawer** (right-panel in the wide mock) |

- **`server/sources/quickbooks.ts`** — parse the SharePoint CSV (revenue collections, itemized
  opex by GL, A/R aging). Graceful no-op if the export is absent.
- **`server/overlay.ts`** extension — `noiBudgets: Record<propertyId, number>`; endpoint
  `POST /api/actions/noi-budget`.
- **`src/modules/close/CloseModule.tsx`** — KPI strip (actual vs budget NOI, portfolio variance,
  properties below budget, expense ratio) + property table + per-property drawer.
- Activates the two Phase-1 alert stubs (escalation-missed, entity-below-floor) once QB is present.

### ⑤ Semantic Document Search — upgrade `/documents`

| Decision | Choice |
|---|---|
| Engine | Replace Fuse.js lexical with **sqlite-vss** + local embeddings via **`@xenova/transformers`** (runs in Node, **no API cost**) |
| Index | Built once when `DOCUMENTS_DIR` is set; incremental on new files; vectors stored alongside the existing DB — no new service |
| Result | Ranked passages with doc + page citation, highlighted match, entity tags; finds ROFR/ROFO/"preferential right" from one query |

- **`server/sources/documents.ts`** upgrade — chunk → embed → store; `searchDocuments(query)` does
  vector similarity. Keeps the existing agent-tool contract (`search_documents`) so the AI agent and
  the module both benefit. Server-only (mirror stays read-only/no-index).

### ⑦ Deal Comps Panel — Acquisitions drawer extension

| Decision | Choice |
|---|---|
| Trigger | **On-demand Refresh button** in the deal drawer — agent web-searches CoStar/LoopNet/CREXI |
| Persistence | Results cached to the deal's **overlay** entry; survive Brain Server restarts |
| Provenance | Always tagged **AI-sourced** + **cached [date]** so freshness is visible |
| Drawer | Comps live in a right-side panel; the **left drawer was rebalanced** (capped 1180px) with six substantive cards — Deal Detail, Returns (bars), Underwriting Assumptions, Financing, **Replacement Cost** (per ORA convention), Risk Flags — + a full-width stage-progression track |

- **`server/overlay.ts`** extension — `dealComps: Record<dealId, CompSet>` (sale comps, rent comps,
  submarket stats, sourcedAt). Endpoint `POST /api/actions/deal-comps` runs the agent comp search.
- New agent tool `get_market_comps` (web-search backed) reused by both the panel and the Ask agent.
- **Deal drawer** rebuild per the v2 mock (the rebalance + replacement-cost card are part of this
  feature, since they share the drawer).

---

## Cross-cutting

- **Overlay is the only write surface.** Workbook stays canonical/read-only. Every new write
  (renewal stage, tenant note, NOI budget, deal comps) is an additive `overlay.json` key merged in
  `applyOverlay`, re-derived on each refresh, emitting SSE. Same pattern, no exceptions.
- **One threshold config** (`server/alerts/conditions.ts`) feeds alerts, the brief, the calendar
  urgency strip, and the renewal 75-day window. Change a number once.
- **Confidentiality:** all new modules redact `confidential` deals on the public mirror exactly as
  the existing bake does. No confidential identifier appears in source or specs.

## Testing

- **Phase 1:** `conditions.ts` — each condition fires/doesn't at its threshold; escalation re-fire
  through snooze; dedup key. `store.ts` — read/unread/snooze transitions; brief-state compatibility.
  `AlertsModule` — renders stat strip + grouped list from a fixture; actions hit the API.
- **Phase 2:** pure selectors (`critical-dates`, `renewals`, `tenants`) fixture-tested for grouping,
  the 75-day window, % NOI rollup, null-health. Modules render from fixtures; overlay endpoints
  persist + re-derive.
- **Phase 3:** `quickbooks.ts` parse (incl. absent-file no-op); budget-variance math; `documents`
  embed/search ranking (ROFR-finds-preferential-right fixture); `deal-comps` overlay round-trip +
  provenance tagging.
- `npm run gate` stays green each phase; each new module is its own lazy chunk → bundle budget holds;
  `reconcile` unaffected (overlay-only writes).

## Rollout

Per phase, via the existing bake+deploy (hourly task republishes the mirror):

1. **Phase 1** — build alert engine + inbox behind the bake; dry-run alerts to state only; enable
   bell + `/alerts`; confirm dedup + snooze-escalation across two bakes.
2. **Phase 2** — ship the three modules (pure spine); confirm rail ordering, 75-day renewal window,
   tenant % NOI, and that the Health column reads "—" cleanly pre-QB.
3. **Phase 3** — wire QB CSV (manual export setup is the one human step); build embeddings index;
   enable on-demand comps. Re-validate Phase-1 escalation/floor stubs now that QB data exists.

## Out of scope (deferred)

Multi-tenant scoping; Notion task sync; QBO cloud (Desktop CSV only); investor/waterfall modeling
(no outside investors); per-partner tailored briefs; AI-narrative brief headline; vector search on
the public mirror (server-only).
