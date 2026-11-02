# Wave B UI — execution plan (2026-10-30)

Parent: `2026-10-30-actionable-intelligence-roadmap.md` Track 2 + Track 3.2/3.3 (approved by Gabriel 2026-10-30).
Worktree: `.claude/worktrees/upbeat-maxwell-870996`. Claim: `architecture/status.json` → `wave-b-ui`.

## Capability audit (code, not docs)

| Need | Existing owner | Gap |
|---|---|---|
| Chart a11y | `src/charts/AreaChart.tsx` (no aria-label), `BarChart.tsx` (optional), `Sparkline.tsx` (none) | make required; Sparkline text summary |
| Snapshot loading/error gate | `src/shell/SnapshotGate.tsx` `useSnapshotGate` (5 modules) | Overview hand-rolls its own |
| Per-property monthly ledger series | PF dataset (`src/contracts/property-financials.ts`, 9 monthly + 2 annual entities) | none |
| PF entity ↔ snapshot property id | PF response `liveSf.entries[*].canonicalId` (`server/property-financials/live-sf.ts`, ratified `ENTITY_TO_CANONICAL`) | none |
| Property detail UI | `src/modules/property-financials/ExplorerView.tsx` (entity-keyed, `?p=`) | no `/property/:id`, no snapshot header |
| Drawer | `src/brain/EntityDrawer.tsx` (has a Sparkline) | no property-page link |
| TierItem builder | `toTierItem` inside `src/modules/alerts/AlertsModule.tsx`; `mergedToTierItem` in `src/modules/insights/insights.logic.ts` | one shared builder + actions factory |

## PR sequence (each: tests, `npm run gate`, preview screenshot, `check:refute`)

1. **2.5** — required `ariaLabel` on AreaChart/BarChart (all callers labelled with series + basis), `sparklineSummary` text alternative, Overview via `useSnapshotGate`.
2. **2.3** — shared TierItem builder + actions factory; Overview Insights board redirect (only after `action-rows` WIP in `widgets.tsx`/`TierBoard.tsx` lands).
3. **2.2** — `/property/:id` canonical page (needs #522 `landlordCostsNotSourced`, #523 `AsOfChip` on main).
4. **2.4** — property table NOI-12m sparkline + occupancy Δ; KPI deltas only on recorded series.
5. **2.6** — PF charts onto `src/charts`, one chart per PR-sized step.
6. **3.2 / 3.3** — expense-line $/SF matrix (quartile shading) and recorded-vs-reconstructed legends / scenario-spread bands.
7. **2.1** — after `feat/action-list-rows` merges.

## Invariants

Never sum workbook-basis and ledger-basis NOI; every series labelled with its basis. No invented dollars ("not yet sourced"). 9510 Persimmon on no surface. Ranking/cap rules untouched.
