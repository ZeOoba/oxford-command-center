# Oxford Command Center — Daily Brief + Same-Day Alerts (Design)

**Date:** 2026-06-04
**Status:** Approved (design) — pending implementation plan
**Owner:** Gabriel Goldberg (ORA)

## Goal

Turn the Command Center from a dashboard you open into a system that pushes. Deliver a single
shared, comprehensive **daily brief** to both partners, plus **same-day critical alerts** when a new
critical condition appears. Deterministic and exact (never hallucinated figures), built so an
AI-narrative headline can bolt on later.

## Decisions (locked)

| Decision | Choice |
|---|---|
| Audience | **One shared brief** to ggoldberg@oxfordra.net + egoldberg@oxfordra.net |
| Cadence | **Daily brief** (first bake ≥ 06:45 ET, once/day) **+ same-day critical-only alerts** (deduped) |
| Composition | **Deterministic template** (extensible to an AI headline later) |
| Hosting/refresh | **Hourly bake** (cheap interim toward "live"); brief/alerts run inside the bake |
| Cash-reserve alert | **Skipped** (no floor configured) |
| Covenant watch | **DSCR < 1.25 only** (high LTV is often by design → excluded to avoid noise) |

## Alert catalog

Reuses the existing `generateInsights(snapshot)` engine; three new types added.

| Alert | Severity | Threshold | Source |
|---|---|---|---|
| Balloon maturity | critical ≤9mo / warning ≤18mo | existing | `generateInsights` |
| Lease expiring / expired | warning ≤90d + expired; **info 91–180d** (new tier) | extend | `generateInsights` |
| Insurance lapse / renew-now | critical / warning | existing | `generateInsights` |
| Cash concentration | critical ≥50% / info ≥25% | existing | `generateInsights` |
| Low occupancy | info <85% | existing | `generateInsights` |
| **Deal stage movement** | info | any pipeline stage change since last brief | NEW |
| **LOI / PSA deadline** | warning | ≤14 days (when a date exists in Notion) | NEW |
| **DSCR covenant watch** | warning | property DSCR < 1.25 | NEW |

Thresholds are configurable via env (defaults above); no confidential identifier in source.

## Architecture

Fold into the existing hourly bake pipeline — single scheduled task, reuses the snapshot build,
the insights engine, and the local Outlook COM send path.

```
Hourly Windows task ─► bake-mirror.ts
                          ├─ build snapshot (existing)
                          ├─ generateInsights + extensions (alerts.ts)
                          ├─ brief orchestrator (scripts/brief.ts):
                          │     • load alert-state.json
                          │     • new critical insight ──► send same-day CRITICAL email
                          │     • first bake ≥06:45 ET & not sent today ──► send DAILY BRIEF
                          │     • persist updated state
                          └─ deploy mirror (existing)
```

### Components (server-side, unit-tested)

- **`server/brief/alerts.ts`** — extends insights with the 3 new alert types (deal-stage movement,
  LOI/PSA deadline, DSCR<1.25). Pure: `(snapshot, priorDealStages) → Insight[]`. The base set comes
  from `generateInsights`; this composes/extends.
- **`server/brief/render.ts`** — deterministic email HTML in ORA style (navy `#1B2A4A`, gold
  `#C9A96E`, cream `#F5F0E8`; EB Garamond / DM Sans). Pure: `snapshot + insights + diff → { briefHtml, briefSubject }` and `insight → { alertHtml, alertSubject }`.
- **`server/brief/state.ts`** — load/save `data/alert-state.json` (gitignored):
  `{ alertedCriticalIds: string[], lastBriefDate: string (ET YYYY-MM-DD), dealStages: Record<dealId, stage> }`.
- **`server/brief/send.ts`** — delivery with explicit fallback chain (see below). Recipients fixed to
  the two partners.
- **`scripts/brief.ts`** — orchestrator invoked at the end of the bake; wires state → alerts →
  render → send → state.

### Daily brief sections (one shared email)

1. **Header** — date, portfolio as-of, data-freshness / data-quality line.
2. **Action items** — severity-ranked alerts (critical → warning → info); each shows entity, figure,
   recommended action.
3. **Critical dates — next 90 days** — lease notices/expiries, loan maturities, insurance renewals,
   LOI/PSA deadlines (from `criticalDates` + extensions).
4. **Deal pipeline** — counts by stage, movement since last brief, next actions.
5. **Portfolio at-a-glance** — NOI, total value, occupancy, consolidated cash, DSCR/LTV summary.
6. **Tasks** — overdue + due-soon (workbook checklist + M365 To-Do).
7. **Footer** — link to the live (Access-gated) dashboard.

Same-day **critical alert** = focused single-item email derived from section 2.

## Dedup & scheduling

- Each hourly bake computes the current set of **critical** alert IDs.
  - IDs **not** in `alertedCriticalIds` → send a same-day alert, add to state.
  - IDs in state but **no longer present** → removed from state (a recurrence re-alerts).
- **Daily brief** sends once per **ET day**: on the first bake where `now ≥ 06:45 ET` and
  `lastBriefDate < today(ET)`; then set `lastBriefDate = today(ET)`. ET computed explicitly
  (machine TZ may differ).
- Windows task triggers: **hourly** (every 1h) **+ a daily 06:45 trigger**; the `lastBriefDate`
  gate guarantees exactly one brief/day even if triggers overlap.
- **Deal-stage movement** is diffed against `state.dealStages`, which is refreshed when the brief is
  sent (so the brief reports the day's movements, not every hourly flutter).

## Delivery & failure handling

Honors the ORA standing rule, never silent:

1. **Primary:** Outlook COM via `_shared/send-via-outlook.ps1` (HTML body, two recipients).
2. **Fallback:** Composio `mcp__composio-ora__OUTLOOK_SEND_EMAIL` if reachable (may be unavailable in
   a headless scheduled context).
3. **Last resort:** write the rendered email to `data/outbox/YYYY-MM-DD-HHmm-<kind>.html` **and** raise
   a DataQuality/System-Health flag so a failed send is visible in the dashboard. Bake exits non-zero
   on send failure so the scheduled-task log surfaces it.

Rube is never referenced. No Gmail.

## Out of scope (v1) — designed to bolt on later

AI-narrative headline; per-partner tailored briefs; in-app brief archive/preview; snooze/ack UI.
The render and alert layers are pure and composable so these add cleanly.

## Testing

- `alerts.ts`: each new alert type (DSCR<1.25 fires/doesn't; LOI/PSA ≤14d; lease 91–180d info tier;
  deal-stage movement detected from a prior-stages diff).
- `state.ts`: dedup transitions — new critical → alert; unchanged → no re-alert; resolved → cleared;
  recurring after resolve → re-alert; brief once-per-ET-day gate.
- `render.ts`: snapshot fixture → brief contains each expected section + exact figures; critical
  alert email renders a single item.
- `send.ts`: fallback chain with the COM call mocked (primary success; primary fail → fallback;
  all fail → outbox + flag).
- `npm run gate` stays green; bundle unaffected (server-only, no client bundle change).

## Rollout

1. Build + test the brief/alert modules behind the bake (no schedule change yet).
2. Dry-run: generate to `data/outbox/` only (no send) and review the rendered brief.
3. Switch the Windows task to hourly + 06:45 trigger; enable live send.
4. Confirm first real brief + a forced critical alert; verify dedup across two consecutive bakes.
