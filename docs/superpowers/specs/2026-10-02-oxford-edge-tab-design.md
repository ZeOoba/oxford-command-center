# Oxford Edge Tab: Acquisitions > Edge (Design Spec)

**Date:** 2026-10-02
**Status:** DRAFT for review
**Author:** Claude Code (Opus 5.5), from the 2026-10-02 brainstorm Gabriel approved
**Lane:** L3 `/build` (new behavior). Phase 2 is a separate L6/L3 spec on the financial-decision path.
**Supersedes (on ship):** the claude.ai artifact "Oxford Edge — Morning Guide" (https://claude.ai/artifact/Khu2pu9ZPaH3PqdZv4A6Kr). It is a static page, frozen 2026-07-14.

---

## 1. Summary

The Oxford Edge market dataset (55 industrial/flex markets, 18 series, 2021–2025) currently lives as a JSON file on OneDrive and a frozen static guide. This spec adds it to the command center as a fifth Acquisitions tab, **Edge**, with three Phase 1 surfaces:

1. **Market board.** A sortable table of all 55 markets that shows each cell's confidence status and, where a series is a proxy, its honest label.
2. **Deal market overlay.** The deal drawer and the Sourcing list show the deal's Edge market readout through a strict resolver. A deal with no reliable match shows "no Edge market". The resolver never guesses.
3. **Data health and pull queue.** Per-series coverage, plus the four manual pulls with their done-state held server-side in the warehouse. This replaces the artifact's `localStorage` checkboxes.

Phase 1 is **display only**. It does not change the Oxford Acquisition Score. Feeding Edge into the score (insight 4) is Phase 2. It gets its own spec, stays advisory until Gabriel ratifies it, and must pass `refute-financial-change` (§13).

## 2. Goals and non-goals

**Goals**
- G1. Read `markets.json` live from its source of record (read-only) and render it in the Acquisitions destination.
- G2. Report freshness honestly. On launch the tab must read **STALE**: the file was last written 2026-07-14, 80 days before this spec.
- G3. Never present a proxy as the thing its key name implies. Never render a `guide_only`/`null` cell as zero.
- G4. Attach market context to pipeline deals without inventing a market match.
- G5. Move the manual-pull checklist from browser storage to durable, auditable server state.

**Non-goals (Phase 1)**
- No change to `scoreAcquisition`, the ratified ruleset (`config/acquisition-ruleset.v1.json`), `AcquisitionInput.marketFundamentalsAdj`, or any governor.
- No composite market score or rank number. The board sorts by observed series values and nothing else.
- No writes to `markets.json` or anything else in the OneDrive `oxford-edge` folder. No re-running of the upstream pull pipeline.
- No structured capture of manual-pull values, such as a storage $/SF baseline. The queue records only done-date and a note (§11 Q3).
- No exposure on the Cloudflare mirror, to the AI agent tools (`server/ai/tools.ts`), or in briefings or PDF export.
- No county→CBSA crosswalk. Parcel-screen candidates with no linked deal show "no Edge market" (§11 Q2).

## 3. Source data contract

**Location.** The directory comes from env `OXFORD_EDGE_DIR`. If the variable is unset, the documented default follows the `workbookPath()` precedent in `server/config.ts`, which is home-relative and never an absolute `C:\Users\Owner` literal:
`join(homedir(), 'OneDrive - Oxford Capital Partners', 'Claude_Workspace', '03_Code', 'oxford-edge', 'output')`.
One resolver function holds the default: `edgeDir()` in `server/edge/config.ts`. It is documented in `env.example` next to `WORKBOOK_PATH`. The loader reads only `markets.json`. The sibling files `data_dictionary.md`, `validation_report.md`, `wealth_report.md` and `morning_guide.html` are not ingested.

**Top level:** `{ meta, markets }`. There are 55 markets as of 2026-07-14. The schema does not hard-code that count.

**`meta`** (verified against the file on 2026-10-02)

| Key | Shape | Notes |
|---|---|---|
| `pulled` | ISO date string | `"2026-07-14"` |
| `years` | `number[]` | `[2021, 2022, 2023, 2024, 2025]`. Every series array must have length `years.length`. |
| `sources` | `Record<field, string[]>` | Provenance codes, e.g. `truck: ["VDOT_…", "MDOT_…", "ODOT_TIMS_arcgis_server_decommissioned", …]` |
| `statusEnum` | `string[]` | `["actual","estimated","nowcast","guide_only","null"]`. `"null"` is a **string** member, distinct from JSON `null`. |
| `fieldMeta` | `Record<field, {trueLabel: string, isProxy: boolean}>` | Covers all 18 series |

**Market object**

| Field | Type | Notes |
|---|---|---|
| `id` | string | Snake-case slug, e.g. `columbus`, `indianapolis_south`, `scranton_wilkes_barre` |
| `name` | string | Named markets use the short city (`Columbus`). Auto markets use the CBSA title (`Baltimore-Columbia-Towson`, `Scranton--Wilkes-Barre`). |
| `state` | string | 2-letter code. Primary state only (`washington_arlington_alexandria` = `DC`). |
| `cbsa` | string | Census CBSA. `indianapolis_south` is the custom cut `26900S` (Johnson/Morgan/Shelby submarkets). |
| `lat`, `lon` | number | Centroid |
| `type` | `'named' \| 'named_custom' \| 'auto'` | 20 named + 1 named_custom = the **21-market buy-box set**, the same 21 the artifact lists for storage/IOS. 34 auto. |
| `trajectory` | `'a_growing' \| 'b_stable' \| 'c_reversing' \| null` | Null for the 21 named markets. Observed counts: 25/8/1. |
| `subs` | `Array<{name: string, vac: number, rentGrowth: number, invKsf: number}>` | 2–5 entries for 51 markets. Permanently `[]` for `cedar_rapids`, `fargo`, `lynchburg`, `sioux_falls` (CoStar Metro-level only). |
| 18 series | `(number \| null)[]` of length 5 | `pop, job, inc, incLevel, trades, biz, hvacPermits, per, loss, truck, storage, rent, vac, carriers, mfgInvest, ios, migration, eGrocery` |
| `status` | `Record<series, StatusEnum[]>` | Parallel to the 18 series. Length 5 each. |

**Units.** `fieldMeta` carries no units, and the data dictionary's "all % YoY except incLevel and migration" is wrong for `vac` (level %), `per` (kSF), `loss` (% of inventory), `carriers` (count per 10k pop) and `mfgInvest` ($). Units are therefore declared once in code, in a `SERIES_UNITS` table in `server/edge/series.ts`, which is also exported for the client through the contract:

| Unit | Series |
|---|---|
| `pct_yoy` | pop, job, inc, trades, biz, hvacPermits, truck, storage, rent, eGrocery |
| `pct_level` | vac, loss |
| `ksf` | per |
| `per_10k` | carriers |
| `usd` | incLevel, mfgInvest |
| `persons` | migration |
| `signal` | ios (no unit; all values null today) |

A unit test fails if `SERIES_UNITS` and `fieldMeta` ever disagree on the series key set.

**Proxies.** `fieldMeta[*].isProxy === true` for `biz`, `hvacPermits` and `eGrocery`. The brief named only hvacPermits and biz. The file also flags eGrocery (CBP NAICS 492 courier establishments), and the UI treats all three alike.

**Observed status distribution** across 4,950 cells: `actual` 3,199 · `guide_only` 1,050 · `null` 670 · `estimated` 31 · `nowcast` 0. The schema still accepts `nowcast`.

**Licensing note.** `rent`, `vac`, `per`, `loss` and `subs` are CoStar-derived (Flex slice). That governs three decisions in this spec: the data stays on the local Brain Server, it is never baked into the mirror (§5.4), and test fixtures are synthetic (§9).

## 4. Architecture and data flow

```
OneDrive  …/oxford-edge/output/markets.json   (written ONLY by the upstream oxford-edge pipeline)
        │  fs read-only (no write API imported in server/edge/loader.ts)
        ▼
server/edge/loader.ts      loadEdgeDataset(dir, now)
   ├─ stat → mtimeMs/size → memo key (re-parse only when mtime or size changes)
   ├─ read with retry (EBUSY/EPERM/EACCES ×3, 250 ms backoff — OneDrive lock / mid-sync)
   ├─ JSON.parse → EdgeMeta (strict) + per-market EdgeMarket.safeParse (bad markets quarantined, not fatal)
   └─ last-good cache: a read/parse failure after a good load serves last-good + readError
server/edge/coverage.ts    computeCoverage(markets, years) → per-series {filled, total, pct, byYear[]}
server/edge/freshness.ts   edgeFreshness(meta.pulled, mtime, now) → {asOf, ageDays, stale}
server/edge/pull-queue.ts  PULL_ITEMS (code-declared scope + cadence) ⨝ edge_pull_log (SQLite) → queue state
server/edge/edge-api.ts    edgeApi(getDb): Hono — GET /markets, GET /pull-queue, POST /pull-queue, POST /pull-queue/:id/void
        │  mounted via server/warehouse/sub-routers.ts  { prefix: '/edge', factory: edgeApi }
        ▼
/api/warehouse/edge/*      (boundary → localhost-only cors → accessGate → host-guard on mutations; same stack as every /api route)
        ▼
src/modules/acquisitions/edge-hooks.ts   useEdgeMarkets / useEdgePullQueue / useRecordPull / useVoidPull
        │  fetchJson + Zod parse (NO mirror fallback, by design)
        ▼
EdgeView.tsx (tab) ─┬─ EdgeRankingBoard.tsx   (market board)
                    ├─ EdgeDataHealth (in EdgeView) + EdgePullQueue.tsx
                    └─ freshness banner
src/brain/DealDrawer.tsx  ── EdgeMarketReadout (from EdgeView exports) ── resolveEdgeMarket(deal, markets)
src/modules/acquisitions/RankedCandidateList.tsx ── Edge column via candidate.notionDealId → Deal → resolver
```

Spine placement: Edge is a **third, read-only reference input**. It is neither Spine A (workbook snapshot) nor Spine B (P&L warehouse) and is never aggregated with either. The only thing it adds to the warehouse is the pull-queue log table, which is user state, not market data.

## 5. Server

### 5.1 Files (all new unless noted)

| Path | Purpose | Owner per `architecture/agent-assignments.md` |
|---|---|---|
| `server/edge/config.ts` | `edgeDir()`, `EDGE_STALE_DAYS = 7` | Unassigned new dir → Integration Agent (ingest/loader pattern) |
| `server/edge/series.ts` | `EDGE_SERIES` (18 keys, ordered), `SERIES_UNITS`, `BUY_BOX_TYPES` | Integration |
| `server/edge/loader.ts` | Read-only loader, memo, last-good cache, retry | Integration |
| `server/edge/coverage.ts` | Coverage computation | Integration |
| `server/edge/freshness.ts` | Freshness + stale rule | Integration |
| `server/edge/pull-queue.ts` | `PULL_ITEMS`, cadence, queue-state derivation, log reads/writes | Integration |
| `server/edge/edge-api.ts` | Hono sub-router | Integration |
| `server/warehouse/sub-routers.ts` (**edit, +1 line**) | `{ prefix: '/edge', factory: edgeApi }` as a literal entry (required shape: `scripts/check-write-schema-drift.ts` `buildMountPrefixMap()` reads this file as text) | Not in `architect_owned_files`; shared single-writer surface → status.json claim |
| `server/warehouse/migrations/033_edge_pull_log.sql` | Pull-queue table | **Architect-owned** |
| `src/contracts/edge.ts` + one `export * from './edge'` line in `src/contracts/index.ts` | Zod contracts | **Architect-owned** (`src/contracts/` per CLAUDE.md §4; `index.ts` is explicitly listed in `architecture/ownership.json`) |

`server/index.ts` is **not** touched. Mounting goes through `WAREHOUSE_SUB_ROUTERS`, which `index.ts` already iterates (line 125). `server/warehouse/migrate.ts` is **not** touched either: `listMigrationFiles()` discovers `NNN_*.sql` by `readdirSync`, so a new file needs no registration.

### 5.2 Routes

Every route is relative to `/api/warehouse/edge`. No route string carries an `/api/` literal in a top-level `server/*.ts` file, so `scripts/governance-check.ts` `checkRouteDuplication` (FM-14) cannot fire, and no existing route uses `/edge` (grep-verified 2026-10-02).

| Method | Path | DB? | Behavior |
|---|---|---|---|
| GET | `/markets` | No | Loader result. It does **not** go through the `withDb` 503 guard, so the board works even when the warehouse sqlite is unopenable. |
| GET | `/pull-queue` | Yes | Queue state per item × scope. Returns 503 `{error:'warehouse unavailable'}` through the standard guard. |
| POST | `/pull-queue` | Yes | Body `RecordPullRequest`. Appends one log row and returns the updated item. Requires `X-ORA-Client` (`server/host-guard.ts` enforces this on non-safe methods). |
| POST | `/pull-queue/:id/void` | Yes | Sets `voided_at` on one row (undo). No delete. |

**GET `/markets` response** (`EdgeMarketsResponse`), abbreviated:

```json
{
  "availability": "ok",
  "dir": "C:\\Users\\Owner\\OneDrive - Oxford Capital Partners\\Claude_Workspace\\03_Code\\oxford-edge\\output",
  "freshness": {
    "metaPulled": "2026-07-14",
    "fileMtime": "2026-07-14T18:38:00.000Z",
    "asOf": "2026-07-14",
    "ageDays": 80,
    "staleAfterDays": 7,
    "stale": true
  },
  "readError": null,
  "years": [2021, 2022, 2023, 2024, 2025],
  "fieldMeta": { "hvacPermits": { "trueLabel": "Residential building permits authorized, growth (Census BPS)", "isProxy": true, "unit": "pct_yoy" } },
  "coverage": [
    { "field": "truck", "filled": 45, "total": 275, "pct": 0.164, "byYear": [9, 9, 9, 9, 9], "allPlaceholder": false },
    { "field": "storage", "filled": 0, "total": 275, "pct": 0, "byYear": [0, 0, 0, 0, 0], "allPlaceholder": true }
  ],
  "markets": [
    {
      "id": "columbus", "name": "Columbus", "state": "OH", "cbsa": "18140",
      "lat": 39.97, "lon": -82.99, "type": "named", "trajectory": null,
      "subs": [{ "name": "Delaware County", "vac": 2.32, "rentGrowth": 1.42, "invKsf": 1901.8 }],
      "series": {
        "vac": { "values": [5.1, 4.2, 3.9, 4.4, 4.0], "status": ["actual", "actual", "actual", "actual", "actual"] },
        "migration": { "values": [6100, 5900, 5200, null, null], "status": ["actual", "actual", "actual", "null", "null"] }
      }
    }
  ],
  "rejectedMarkets": [],
  "marketCount": 55
}
```

(These numbers are illustrative of shape, not real values. The `dir` field is returned only because the API is localhost-only.)

`availability` takes one of four values:
- `ok`: parsed, possibly stale.
- `missing`: the directory or file does not exist; `markets: []`.
- `unreadable`: I/O failure with no last-good; `markets: []`.
- `invalid`: `meta` failed its schema and no last-good exists; `markets: []`.

These are returned as **HTTP 200** with the envelope. They are data states, not server faults. A 503 would be mis-rendered by the client as "warehouse offline". `readError: string | null` is set when last-good is being served after a failed re-read.

The server reshapes each market into `series[field] = {values, status}`. This is a pure restructure, so the client never zips two parallel arrays by index.

**Coverage rule.** A cell counts as filled iff `value !== null` AND `status ∈ {actual, estimated, nowcast}`. A test pins this against the published validation-report counts on a synthetic fixture built to reproduce them (§9). Cells where the value and status disagree (a value with status `"null"`/`guide_only`, or `null` with `actual`) count as **not filled** and are listed in `coverage[].inconsistent`.

**GET `/pull-queue` response** (`EdgePullQueueResponse`):

```json
{
  "items": [
    {
      "kind": "storage",
      "label": "Self-storage asking rates",
      "cadenceDays": 90,
      "scopeType": "market",
      "scopes": [
        { "scopeKey": "columbus", "scopeLabel": "Columbus, OH", "state": "open",
          "lastDoneOn": null, "lastNote": null, "lastLogId": null, "ageDays": null }
      ],
      "links": [{ "label": "StorageCafe", "urlTemplate": "https://www.storagecafe.com/self-storage-rates/{slug}/" }]
    }
  ],
  "automatedCoverage": { "truck": ["VA", "MI"] }
}
```

**POST `/pull-queue` request** (`RecordPullRequest`, Zod, strict):
`{ kind: 'storage'|'ios'|'mfgInvest'|'truck', scopeKey: string, doneOn: 'YYYY-MM-DD', note: string (≤ 2000, optional) }`.
`scopeKey` must be in `PULL_ITEMS[kind].scopes`, or the route returns 400. `doneOn` must be a real calendar date that is not in the future relative to server local date. Otherwise 400.

### 5.3 Pull-queue model (`server/edge/pull-queue.ts`)

The scope lists and cadences are **code**, which keeps them versioned and reviewable. The DB holds only the append-only log.

| kind | Scope | Scope keys | Cadence | Source (from the artifact) |
|---|---|---|---|---|
| `storage` | market | the 21 buy-box ids (`type ∈ {named, named_custom}`) | 90 d (quarterly) | StorageCafe / RentCafe. Today's rate only, no history: record a baseline. |
| `ios` | market | same 21 | 90 d (quarterly) | Crexi / LoopNet manual scan (scripts are blocked) |
| `mfgInvest` | state | PA MD VA WV OH IN MI KY MO KS WI IA NE IL MN (15) | 30 d | 15 state econ-dev press feeds (URLs carried from the artifact) |
| `truck` | state | OH IN WI PA MD KY MO KS IA NE WV IL MN (13) | 365 d (AADT is annual) | Per-state blocker note carried verbatim in intent: OH dead TIMS endpoint; IN TCDS JS-app only, check INDOT open data; WI usable-but-risky (irregular count cycle, no truck class); others not attempted, with PASDA (PA) and MSDIS (MO) as known open layers |

- The 21 storage/IOS scope keys are **derived at load from markets.json `type`** when the dataset is available. They fall back to a frozen copy of the artifact's 21-id list when it is not. A test asserts the two agree on the fixture.
- VA and MI are **not** truck queue rows. They are complete through the automated pull and appear under `automatedCoverage`, derived from markets.json (any non-null `truck` value in a state's markets), not from the log.
- States that are in the dataset but outside the artifact's pull scope (TN, ND, SD, DC for both truck and mfgInvest) are listed in Data health as "outside pull scope". The queue does not silently omit them.
- State per scope: `open` (no non-voided log row), `current` (latest `done_on` age ≤ cadence), `due` (age > cadence).
- **Launch state:** zero log rows, so all 21 + 21 + 15 + 13 = 70 scopes read `open`. No seeding. This matches the instruction that nothing is recorded done.

### 5.4 Mirror, AI, confidentiality boundaries

- `/edge/*` is **not** added to `FIXED_ROUTES` in `scripts/bake-warehouse.ts`. On the Cloudflare mirror the route is absent. `fetchJson` gets the SPA HTML and throws `WarehouseUnavailableError`, and the tab renders "Edge is local-only (Brain Server)". The data is CoStar-licensed and must not be baked.
- `server/ai/tools.ts` gets no Edge tool in Phase 1.
- The Edge routes accept and return **no deal data**. Deal→market resolution runs client-side against the snapshot the client already holds. Because no deal identity crosses the API, the Edge surface cannot widen the confidential-deal exposure path in either direction.

## 6. Contracts (`src/contracts/edge.ts`, Architect-owned)

- `EdgeStatus = z.enum(['actual','estimated','nowcast','guide_only','null'])`
- `EdgeSeriesKey = z.enum([...18])`
- `EdgeSeriesCell = z.object({ values: z.array(z.number().nullable()), status: z.array(EdgeStatus) })` with a refine `values.length === status.length`
- `EdgeSub`, `EdgeMarket` (output shape above), `EdgeFieldMeta` (`trueLabel`, `isProxy`, `unit`)
- `EdgeMarketsResponse`, `EdgeCoverageRow`, `EdgeFreshness`
- `EdgePullKind`, `EdgePullScopeState`, `EdgePullQueueResponse`, `RecordPullRequest`

The raw-file schema (`RawEdgeFile`, `RawEdgeMarket`) lives in `server/edge/loader.ts`, not in contracts. It is an ingest concern, and keeping it out of contracts means a change to the upstream file shape does not require an Architect contract change.

`edge.ts` is not in `FINANCIAL_CONTRACT_PATHS` (`scripts/check-refute-required.ts`) and must not be added in Phase 1. Phase 2 re-evaluates this (§13).

## 7. Database: migration `033_edge_pull_log.sql` (Architect-owned)

Highest existing prefix is `032` (`032_lm_cumulative_reduction_event_chain.sql`). Verified on `origin/main` @ `f36b995` and across all remote branches on 2026-10-02. If another PR lands `033` first, renumber before merge. `checkMigrationPrefixUniqueness` in the governance gate fails on a collision.

```sql
-- 033_edge_pull_log.sql — Oxford Edge manual-pull done-state (append-only log).
-- User state only; holds no market data. Scope/cadence live in server/edge/pull-queue.ts.
CREATE TABLE IF NOT EXISTS edge_pull_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  pull_kind   TEXT NOT NULL CHECK (pull_kind IN ('storage', 'ios', 'mfgInvest', 'truck')),
  scope_key   TEXT NOT NULL CHECK (length(scope_key) BETWEEN 2 AND 64),
  done_on     TEXT NOT NULL CHECK (done_on = date(done_on)),            -- real ISO calendar date
  note        TEXT CHECK (note IS NULL OR length(note) <= 2000),
  recorded_by TEXT NOT NULL DEFAULT 'ui',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  voided_at   TEXT
);
CREATE INDEX IF NOT EXISTS ix_edge_pull_log_kind_scope
  ON edge_pull_log (pull_kind, scope_key, done_on DESC, id DESC);
```

- The log is append-only and has no DELETE path. "Undo" sets `voided_at`, which follows the firm's never-delete rule and keeps history.
- Current state per (kind, scope) is the latest non-voided row, ordered by `done_on DESC, id DESC`.
- `scope_key` membership is enforced in the route rather than by a CHECK. The scope list lives in code and changes without a migration.
- `check:schema-drift` will cross-reference the POST route's Zod schema (`kind, scopeKey, doneOn, note`) against the INSERT's bound values. The INSERT must bind exactly those four fields to `pull_kind, scope_key, done_on, note`.

**Live-DB safety.** `openWarehouse()` migrates as a side effect (`server/warehouse/db.ts` line 94). A branch dev server pointed at the live `data/warehouse/finance.sqlite` would apply `033` from an unmerged branch, which is the 2026-09-17 incident class. Worktree development **must** use the worktree-local `WAREHOUSE_DB` from `worktree-env.example`. `033` reaches the live warehouse only when the dev server on `main` starts after merge.

## 8. UI

### 8.1 Tab registration

- `src/modules/acquisitions/tabs.ts` (UX-owned, not Architect): `AcqTab` becomes `'pipeline' | 'workbench' | 'sourcing' | 'grader' | 'edge'`. Append `{ id: 'edge', label: 'Edge', aliases: ['oxford edge', 'market board', 'markets', 'pull queue', 'data health'] }`. The `?tab=edge` deep link is stable from launch.
- **Tab cap:** this brings Acquisitions to exactly `MAX_TABS_PER_DESTINATION = 5` (`src/shell/tab-types.ts`). Any later tab needs an IA decision.
- `src/shell/modules.tsx` needs **no edit**. It already imports `ACQUISITIONS_TABS` (line 25) and registers it on the `pipeline` destination (line 63), so the command palette indexes "Acquisitions > Edge" automatically.
- **No tab badge.** `ModuleTabDef.useBadge` must be "a hook over data the module ALREADY fetch[es] (never a new query)". A STALE badge would add an eager query on every Acquisitions load. Staleness is shown inside the tab.
- **Lazy-mounted.** `<TabPanel id="edge">` without `FORCE_MOUNT_PANEL`, following the Grader precedent. `src/lib/forceMountPanel.ts` restricts force-mount to panels already mounted together pre-split, so they introduce no new eager queries. Edge is new and fetches. The board's sort key and set filter are lifted into `AcquisitionsModule` state, as `scoreDealId` is, so they survive a tab round-trip without force-mounting.
- `tests/unit/acquisitions-tabs.test.tsx` asserts exactly four tabs (`['Pipeline','Workbench','Sourcing','Grader']`) and must be updated to five, adding an `edge`-is-lazy assertion.

### 8.2 `EdgeView.tsx` (tab body)

The layout, top to bottom:
1. Freshness banner
2. KPI strip: `KpiStat` × 4, showing Markets loaded, Buy-box markets, Series fully real, and Open manual pulls
3. `EdgeRankingBoard`
4. Data health card (coverage table)
5. `EdgePullQueue`

**Freshness banner** (always rendered):
- `stale: true` → amber `Badge` reading **STALE** with the text: "Edge dataset as of 2026-07-14 — 80 days old. Firm rule: a mirror more than 7 days behind is never presented as current." `asOf` is the **earlier** of `meta.pulled` and the file mtime. An OneDrive re-sync that bumps mtime can never make old data read as fresh.
- `stale: false` → neutral badge "As of {asOf}".
- `readError` set → red line: "Last re-read failed ({error}); showing the copy loaded at {time}."

**Error and empty states** (each one replaces the board, health and queue bodies; the banner reports the state):

| Condition | Render |
|---|---|
| Loading | `Skeleton` |
| `WarehouseUnavailableError` (mirror / server down) | "Edge is local-only — start the Brain Server on the workstation." |
| `availability: 'missing'` | "markets.json not found at {dir}. Set `OXFORD_EDGE_DIR` in `.env` on this machine." |
| `availability: 'unreadable'` | "markets.json could not be read (OneDrive lock or sync in progress?): {error}. Retrying on next load." |
| `availability: 'invalid'` | "markets.json failed schema validation — the upstream file changed shape." Plus the first 5 Zod issues. |
| `rejectedMarkets.length > 0` | Board renders the valid markets. An amber note lists rejected ids and reasons. |
| Pull-queue 503 (warehouse unopenable) | Board and health still render because they need no DB. Queue card reads "Warehouse offline — pull status unavailable". |

### 8.3 `EdgeRankingBoard.tsx` (market board)

`Card` + `DataTable`. All 55 markets are rows. There is no rank-number column: ordering is by sort only, so the board cannot be read as a score.

| Column | Series | Display | Sort value |
|---|---|---|---|
| Market | — | `name, state` + `Badge` (`Buy-box` gold for named/named_custom, `Auto` neutral) + trajectory text for auto (`Growing`/`Stable`/`Reversing`) | name |
| Trades momentum | `trades` | Latest YoY % + `Sparkline` (2021–2025, nulls as gaps) | latest value |
| Flex vacancy | `vac` | Latest level % | latest value |
| Flex rent growth | `rent` | Latest YoY % | latest value |
| Pipeline | `per` | Latest kSF under construction | latest value |
| Net migration | `migration` | Latest net persons, with year suffix (e.g. "2023"), because 2024–25 are unpublished | latest value |
| Population | `pop` | Latest YoY % | latest value |

- "Latest" means the **last index whose status ∈ {actual, estimated, nowcast} and whose value is non-null**. If that year is not `years[last]`, the year is shown. If no such index exists, the cell renders `—` with its status label and sorts last. `DataTable` already sorts `null` last in both directions.
- **Status rendering.** One pure function, `edgeStatusLabel(status)` in `edge-hooks.ts`, drives every surface:
  - `actual` → no marker
  - `estimated` → dotted underline + "Est." tooltip (`Provenance` visual convention)
  - `nowcast` → dotted underline + "Nowcast"
  - `guide_only` → "Pending manual pull" (never `0`)
  - `"null"` → "Not published"
- **Honest labels.** Column-header tooltips use `fieldMeta[field].trueLabel`. Any proxy series the board ever shows renders the trueLabel as its header, with a `[PROXY]` suffix, and never the raw key. Phase 1's default columns contain no proxies. The column picker (below) is where proxies can appear.
- **Column picker.** A small multi-select lets the user add any of the other 12 series as columns. Proxies appear as "Residential building permits (Census BPS) [PROXY]", "Business establishments (CBP) [PROXY]" and "Courier establishments, NAICS 492 (CBP) [PROXY]". `storage`/`mfgInvest`/`ios` columns render "Pending manual pull" in every row. `truck` renders "Not yet available" where null, per the data dictionary instruction not to hide the metric or let it read as zero.
- **Set filter.** `SegmentedControl` with options `Buy-box (21)` · `All (55)` · `Auto (34)`, default `Buy-box`. A "Pin buy-box" toggle (default on) keeps the 21 at the top under `All`, sorted within the pinned group.
- **Row click** expands an inline detail row with `subs` (name, vac, rent growth, inventory kSF). For the 4 metro-only markets it shows: "CoStar publishes no submarket breakdown for this metro." It also shows the full 5-year values for the 6 board series with per-year status.
- **Footnote** (always visible): "Rent / vacancy / pipeline are CoStar Industrial **Flex** slice — not a ≤50K SF cut. Multi-state CBSAs list their primary state only."

### 8.4 Deal market overlay

**Resolver** `resolveEdgeMarket(deal, markets): {kind:'matched', market, via} | {kind:'unmatched', reason}` lives in `src/modules/acquisitions/edge-hooks.ts`. It is pure and unit-tested, and it has two tiers. Tier 1 decides whenever it applies.

1. **Tier 1, `Deal.market` enum** (`src/contracts/common.ts` `Market`). An explicit reviewed table:

| `Market` | Edge id |
|---|---|
| `Columbus OH` | `columbus` |
| `Toledo OH` | `toledo` |
| `Cleveland MSA` | `cleveland` |
| `Kansas City MO` | `kansas_city` |
| `Indianapolis IN` | `indianapolis_carmel_greenwood` (full CBSA. `indianapolis_south` is a 3-county submarket cut and a deal tagged only "Indianapolis IN" is not known to sit inside it) |
| `Cincinnati OH` | `cincinnati` |
| `Madison WI` | `madison` |
| `Grand Rapids MI` | `grand_rapids` |
| `Des Moines IA` | `des_moines` |
| `Louisville KY` | `louisville` |
| `Richmond VA` | `richmond` |
| `Mid-Atlantic`, `Other`, `Unknown`, `null` | → Tier 2 |

A test asserts that every `Market` enum member is either in this table or in the Tier-2 set. Adding an enum member without a decision fails the build.

2. **Tier 2, `Deal.location` exact city match.** Applies only when Tier 1 deferred. Take the last `City, ST` pair in `location` after stripping parentheticals. Example: `'3849 N Richardt, Indianapolis, IN'` → `Indianapolis, IN`. It matches iff exactly **one** Edge market has `state === ST` and either `name === City` or the first hyphen-segment of `name === City` (the CBSA principal city), compared case-insensitively. Zero matches give `unmatched:'no_market_for_location'`. Two or more give `unmatched:'ambiguous'`. Neither case ever picks one. `location: 'TBD'` or no parseable pair gives `unmatched:'no_location'`.

Edge ids that the resolver references are validated against the loaded dataset. A table entry pointing at an id missing from `markets.json` gives `unmatched:'edge_id_absent'` and never a substitute.

**Readout component** `EdgeMarketReadout` (exported from `EdgeView.tsx`) shows four values with status markers: Flex vacancy, Flex rent growth, Pipeline (new supply, kSF) and Trades momentum. It adds the freshness badge and a "View in Edge" link to `?tab=edge`. Unmatched states render "No Edge market" plus the reason in tertiary text. Stale data always shows the STALE badge next to the numbers.

**Surfaces**
- `src/brain/DealDrawer.tsx` gains a `CardBox title="Edge Market"` after "Deal Detail". It is UX-owned per agent-assignments (`src/brain/EntityDrawer.tsx` listed, and `DealDrawer.tsx` is its sibling and is not Architect-listed). The query fires on drawer open only.
- `src/modules/acquisitions/RankedCandidateList.tsx` gains an **Edge** column with vacancy · rent growth compact and a tooltip carrying the full readout. **Important:** `AcqCandidateRow.market` is a `ClusterTier` (`owned-submarket`/`established`/…), **not** a metro name, so it cannot be resolved. A candidate resolves only through `candidate.notionDealId` → the snapshot `Deal` with the same `notionDealId` → the resolver. Candidates with `notionDealId === null` (parcel-screen, manual) show "No Edge market (no linked deal)".
- **Eager-query guard.** The Sourcing panel is force-mounted, so `useEdgeMarkets` is called there with `enabled: hasVisitedSourcingOrEdge`. That is a sticky flag in `AcquisitionsModule`, set the first time either tab is selected, so loading Acquisitions on the Pipeline tab triggers no Edge request.

**Confidential deals.** Existing handling is unchanged: the `Lock` badge in the drawer and Active Deals, and `RiskFlags` "Confidential — internal only". Confidential deals **do** get an Edge readout. It is internal UI, the readout is public-source market data, and no deal identity is sent to `/edge/*` (§5.4). Nothing in Phase 1 renders Edge data on a mirror, briefing, PDF, AI tool, or any external surface.

### 8.5 Data health (in `EdgeView.tsx`)

A `DataTable` of the 18 series with these columns: True label (trueLabel + `[PROXY]` badge), Unit, Coverage % with filled/total, a per-year coverage mini-bar, Status mix (actual/est/guide/null counts) and Source codes (`meta.sources[field]`, monospace). Rows where every cell is placeholder (`storage`, `mfgInvest`, `ios`) carry a "Manual pull required" badge that links to the queue item. Inconsistent cells (§5.2) render an amber count. Below the table:
- `subs`: "51/55 markets — 4 metro-only markets have no CoStar submarket breakdown (permanent)."
- Out-of-scope states (TN, ND, SD, DC).

### 8.6 `EdgePullQueue.tsx`

One `Card` per pull kind (4). Each card has:
- Header: label, cadence ("Quarterly", "Monthly", "Annual"), and counts as `Badge`s: open (red), due (amber), current (green).
- The "why it matters" line and the honest caveat, carried over from the artifact, e.g. storage: "today's rate only — record a baseline; growth accumulates from future pulls".
- A scope grid: one row per scope with state pill, last done date, age, note (truncated), and the source links. The storage and IOS link templates use the artifact's `{city}-{st}` slugs. mfgInvest uses the 15 press-feed URLs. Truck shows the per-state blocker text.
- Write controls are shown only when `useWarehouseLive()` is true, the same fail-safe as Sourcing status writes. "Mark done" opens an inline form (date defaults to today, optional note) → `POST /pull-queue` with `ORA_JSON_MUTATION_HEADERS`. "Undo" → `POST /pull-queue/:id/void`, after a `window.confirm`. Mutations invalidate `['warehouse','edge','pull-queue']`.

Launch state is all 70 scopes `open`. That is the honest equivalent of the artifact's unchecked boxes. The browser `localStorage` keys `oe-guide-*` from the artifact are **not imported**: they are per-browser and unverifiable.

### 8.7 `edge-hooks.ts`

Query keys:
- `['warehouse','edge','markets']`, `staleTime: 5 min`
- `['warehouse','edge','pull-queue']`, `QUERY_OPTS`

Both use `fetchJson` + `schema.parse` from `src/modules/intel/hooks.ts`. The mirror-fallback variant (`fetchParsedOrMirror`) is deliberately **not** used, because nothing is baked. The file also exports `resolveEdgeMarket`, `edgeStatusLabel`, `latestObserved(cell)` and `formatEdgeValue(value, unit)`.

## 9. Failure modes and pre-mortem

Assume Phase 1 ships and is wrong. These are the most likely ways, with the control for each.

| # | Failure | Control | Test |
|---|---|---|---|
| F1 | **Stale input presented as current.** Data is 80 days old today. | `asOf = min(meta.pulled, mtime)`, stale if > 7 d, banner always rendered, STALE badge on every overlay readout. | freshness: fresh / exactly-7 / 8-day / mtime-newer-than-pulled / future mtime (clock skew → treated as stale, `ageDays` clamped ≥ 0) |
| F2 | **Wrong market match** (e.g. Columbus IN → Columbus OH; "Indianapolis" → South cut). | Two-tier resolver, state-checked, exactly-one-match rule, no fuzzy matching, no default. | Resolver table covers every `Market` member; ambiguous → unmatched; Mid-Atlantic + `Hagerstown, MD` → `hagerstown`; Mid-Atlantic + `Salisbury, MD` → unmatched; `TBD` → unmatched; `Twinsburg, OH (Cleveland MSA)` with market `Cleveland MSA` → tier 1 |
| F3 | **Proxy shown as the real thing** (hvacPermits read as HVAC permits). | Headers always come from `fieldMeta.trueLabel`; `[PROXY]` driven by `isProxy` from the file, not a hard-coded list. | Snapshot: picker labels for all three proxies contain trueLabel + `[PROXY]` and never the raw key |
| F4 | **Placeholder rendered as zero** (`guide_only` null shown as 0.0%). | `formatEdgeValue(null)` never returns a number; status label always wins. | status→label table test; board cell for `storage` = "Pending manual pull" |
| F5 | **OneDrive lock / mid-sync / partial write** → EBUSY or truncated JSON. | Retry ×3 (250 ms), last-good cache, `readError` surfaced, `availability:'unreadable'` only when no last-good. | Mock fs: EBUSY×2 then OK; truncated JSON after a good load → last-good + readError; truncated JSON cold → `unreadable` |
| F6 | **Path missing on another machine** (Eric's laptop, CI, worktree). | Env override; `missing` envelope names the resolved dir and the env var; never throws. | Nonexistent dir → `missing`, 200, `markets: []` |
| F7 | **Upstream shape change** (new series, renamed key, 6th year). | Raw schema is strict on `meta`, per-market `safeParse` quarantine, `years.length` refine, `SERIES_UNITS` ⇔ `fieldMeta` key-set test. | Malformed market quarantined, rest served; meta missing `fieldMeta` → `invalid` |
| F8 | **Accidental write to markets.json.** | `server/edge/loader.ts` imports only `readFileSync`/`statSync` (`node:fs`); a unit test asserts the module source contains no `write`/`rename`/`unlink`/`copyFile` fs calls, and that file mtime and size are unchanged after a load. | as stated |
| F9 | **Confidential deal leak.** | No deal data on the Edge API; not baked; no AI tool; overlay internal only. | Route test: response contains no key named `deal*`; bake test: `FIXED_ROUTES` has no `/edge` entry |
| F10 | **Unmerged migration applied to the live warehouse.** | Worktree-local `WAREHOUSE_DB` (§7); preview launch config points at the worktree (§10). | Manual check in rollout step 2 |
| F11 | **Eager query regression** (Acquisitions load now hits OneDrive). | Edge tab lazy; Sourcing column `enabled` gate; no tab badge. | acquisitions-tabs test: with `?tab=pipeline`, `fetch` never called with `/edge/` |
| F12 | **Pull marked done for the wrong scope / typo state.** | Server-side `scopeKey` allow-list; void instead of delete; full log retained. | POST unknown scope → 400; void → state reverts to prior row |
| F13 | **Multi-state CBSA misread** (DC metro shown for a VA deal). | Tier 2 requires `state` equality on the file's primary state; footnote discloses it. Such deals go unmatched rather than mis-matched. | `Alexandria, VA` → unmatched |
| F14 | **Fixture leaks licensed data into git.** | Test fixture `tests/fixtures/edge/markets.slice.json` is **synthetic**: real field shape and status patterns, fabricated values, header `"_synthetic": true`. | Fixture test asserts `_synthetic === true` |

## 10. Testing plan

**Unit (vitest, `tests/unit/`)**
- `edge-loader.test.ts`: happy path on the synthetic fixture (4 markets: one `named`, `indianapolis_south`-style `named_custom`, one `auto` with empty `subs`, one with real `truck`); missing dir; missing file; truncated JSON cold and warm; EBUSY retry; malformed market quarantine; `years.length` mismatch; memo re-parse only on mtime/size change; no-write guarantees (F8).
- `edge-coverage.test.ts`: filled rule; inconsistent cells; `allPlaceholder` for storage/mfgInvest/ios; byYear.
- `edge-freshness.test.ts`: F1 matrix.
- `edge-resolver.test.ts`: F2 + F13 cases; enum-completeness guard; `edge_id_absent`.
- `edge-status-label.test.ts`: all 5 statuses + JSON `null` value with each status.
- `edge-pull-queue.test.ts`: state derivation (open/current/due at cadence boundaries); latest-non-voided ordering (`done_on DESC, id DESC`); scope lists = 21/21/15/13; VA/MI in `automatedCoverage`, not the queue; buy-box derivation equals the frozen list.
- `edge-api.test.ts`: in-process Hono via `edgeApi(getDb)` against a fresh `openWarehouse()` on a `mkdtempSync(tmpdir())` path, all migrations applied (pattern: `tests/unit/acq-api.test.ts`); GET markets without DB; GET/POST/void pull-queue; 400s for bad kind/scope/date/future date/oversize note; 503 when `getDb` throws; F9 key assertion.
- `edge-migration.test.ts`: fresh DB migrates through `033`; CHECKs reject a bad `pull_kind`, a non-date `done_on` (`'2026-02-30'`), and an oversize note.
- `acquisitions-tabs.test.tsx` (**update**): five tabs; Edge lazy; F11 no-fetch assertion.
- `edge-view.test.tsx`: banner STALE text; each availability state; pull-queue write controls hidden when not live; proxy labels (F3/F4).
- `sub-routers-mount-prefix.test.ts` already guards the literal-entry shape. Confirm it covers `/edge`.

**Gate:** `npm run gate` (11 steps, `package.json` `gate`). Two known conditions are recorded rather than rationalized:
- `npm run test` / `gate` exits `0xC0000005` intermittently (~30–50% of runs) with 100% correct content. The response is to rerun and report the attempt count.
- The `reconcile` step has been red on clean `main` since 2026-09-25 because of snapshot data drift, not code. If it is still red, the PR states that `reconcile` fails identically on `main` @ base and runs the later steps (`reconcile:noi-crosscheck`, `warehouse:verify`, `warehouse:drift`) individually with their output quoted. The gate is never reported as "green" when it was not.

**Refute gate:** `scripts/check-refute-required.ts` is default-deny for `server/**`, so every Phase 1 commit touching `server/edge/*`, `sub-routers.ts` or the migration needs a trailer. Phase 1 commits carry `Refute-Skip: Oxford Edge Phase 1 — read-only display ingest + manual-pull log; no scoring, NOI, governor or capital math`. `server/edge/*` is deliberately **not** added to `DELIVERY_ONLY_PATHS`: that would blind the gate to Phase 2 math landing in the same directory.

**Preview verification:**
1. Add worktree-scoped `brain-web`/`brain-server` entries to `.claude/launch.json`, pointing `--prefix` at the worktree. The existing entries target the main checkout. This is a shared file, so claim it in status.json first.
2. Confirm the worktree `.env` has `WAREHOUSE_DB` worktree-local and `OXFORD_EDGE_DIR` unset (default path).
3. Load `/?tab=edge` and verify: STALE banner with 80 days and as-of 2026-07-14; 55 rows under All and 21 under Buy-box; `hvacPermits` picker label shows "[PROXY]"; storage column reads "Pending manual pull"; all 70 queue scopes open.
4. Mark one storage scope done, reload, confirm it persists, void it, and confirm it reverts.
5. Open a deal drawer for a Columbus OH deal (readout) and for a `TBD` deal ("No Edge market").
6. Set `OXFORD_EDGE_DIR` to a bogus path, restart, and confirm the `missing` state.
7. Run `read_console_messages` for errors and confirm no `/edge/` request fires on `?tab=pipeline`.
8. Stop the servers.

## 11. Ownership, coordination, rollout

**Coordination (CLAUDE.md §0/§2/§5)**
1. Create a worktree with `git worktree add .claude/worktrees/oxford-edge-tab -b feat/oxford-edge-tab` from fresh `origin/main`. Copy `worktree-env.example` → `.env`, keeping the worktree-local `WAREHOUSE_DB`.
2. Add an `architecture/status.json` entry `oxford-edge-tab` with `review_needed: true`. Its `review_detail` names the three Architect-owned touches: `src/contracts/edge.ts` (new) + `src/contracts/index.ts` (+1 export line), and `server/warehouse/migrations/033_edge_pull_log.sql`. It also claims the shared single-writer surfaces: `server/warehouse/sub-routers.ts`, `.claude/launch.json`, `env.example`. Commit that declaration on the branch and wait for acknowledgment before editing those files.
3. UX-owned edits: `tabs.ts`, `AcquisitionsModule.tsx`, `RankedCandidateList.tsx`, `src/brain/DealDrawer.tsx` and the new `src/modules/acquisitions/Edge*.tsx`/`edge-hooks.ts`. The new `server/edge/*` files fall to the Integration Agent role.
4. Run `git status` before each edit. Every uncommitted file the session did not create is locked; at spec time that is `data/snapshots/portfolio.json` and `docs/superpowers/plans/2026-10-02-portfolio-trends.md`. Commit explicit paths only, never `git add -A`. Gabriel owns integration to `main`.

**Rollout**
1. PR 1 (one PR, squash-merge): contracts, migration, `server/edge/*`, the sub-router entry, UI, tests, and the `env.example` doc line.
2. After merge, Gabriel restarts the dev server on `main`, which applies `033` to the live warehouse. Then confirm `GET /api/warehouse/edge/pull-queue` returns 70 open scopes.
3. Artifact retirement happens only after step 2 is verified. Republish the artifact with a top banner: "Retired — live in Command Center › Acquisitions › Edge (local). This page is frozen at 2026-07-14." Do not delete it. Gabriel decides (Q1).

**Rollback**
- UI: revert the squash commit (`git revert -m 1` per CLAUDE.md §8). The tab, overlay column and drawer card disappear. `markets.json` is untouched by construction.
- DB: `033` creates one isolated table that no other code reads. After a code revert it stays inert, and the `_migrations` row remains. The table is **not** dropped, which preserves any recorded pulls (never-delete). A re-land reuses it via `CREATE TABLE IF NOT EXISTS`.

## 12. Decisions (resolved by Gabriel, 2026-10-02)

- **Q1. Artifact disposition: retire with banner.** Republish the artifact with a top banner after rollout step 2 is verified; do not delete.
- **Q2. Parcel-screen candidates: deferred.** Unlinked candidates show "no Edge market" in Phase 1. The county→CBSA crosswalk is a follow-up, built together with the Phase 2 Indianapolis South question.
- **Q3. Storage baseline: free-text note only.** No structured $/SF table; values reach `markets.json` through the upstream pipeline, which stays the single source of truth for series data.
- **Q4. Staleness: the 7-day firm rule applies as written.** No cadence-aware freshness in Phase 1; revisit after seeing how the flag reads in practice.

## 13. Phase 2 (stub): Edge → Oxford Acquisition Score

**Scope.** Derive a market-fundamentals adjustment from Edge for a resolved deal and feed it through the **existing, already-ratified** input slot. The slot is `AcquisitionInput.marketFundamentalsAdj ∈ [-1, 1]` + `marketFundamentalsConfidence` + `compSourcedAt` (`src/contracts/acquisition.ts`). The consumer is `server/warehouse/acquisition.ts` (~L472–478), with the ratified scale `ruleset.scoring.cat4.fundamentalsAdjustMax` and the freshness window `marketFundamentalsWindowDays: 90` (`config/acquisition-ruleset.v1.json`). The new and unratified piece is only the **Edge→adj mapping** (which series, transforms, weights, and confidence mapping from Edge status).

**Advisory-only gate.** This mirrors `HURDLE_RATE` in `server/warehouse/intel-config.ts` and the runtime `advisoryOnly` read in `server/warehouse/capital-allocation.ts`. Define an `EDGE_FUNDAMENTALS_MAPPING` constant with `ratification: 'proposed'`. While it is proposed:
- the Edge-derived adj is computed and displayed as a shadow figure ("would move Market sub-score by ±x pts"), labelled "Advisory — not ratified";
- it is **never** written into `AcquisitionInput`;
- it never changes a persisted score, tier or verdict.

Ratification flips the constant, with Gabriel's name and date, and is recorded in `event_log.md`.

**Refute.** All Phase 2 engine and mapping code passes `.claude/workflows/refute-financial-change.js` (default lenses: math, edges, governor, regression). Commits carry the workflow's `Refute-Reviewed: wf_…` trailer, which is the only attestation `check:refute` accepts for this path. Re-evaluate adding `src/contracts/edge.ts` to `FINANCIAL_CONTRACT_PATHS` once its fields feed scoring.

**Weights.** None are proposed here. A mapping proposal requires evidence first: a back-test of Edge series against ORA's closed and passed deal outcomes (`calibration_report`), or against submarket rent/vacancy forward performance. Without that evidence the proposal is not written.

**Phase 2 decisions (Gabriel, 2026-10-02)**
- **Freshness:** the ruleset's 90-day `marketFundamentalsWindowDays` governs zeroing the Edge-derived adj; the 7-day Edge flag remains a display warning only.
- **Proxy series** (`isProxy: true`: `hvacPermits`, `biz`, and `eGrocery`) are excluded from the mapping outright.
- **Confidence:** an input with `estimated` or `nowcast` status caps the adj's Confidence at "medium"; only all-`actual` inputs can reach "high".
- **Still open:** whether `indianapolis_south` or the full CBSA feeds a deal in Johnson/Morgan/Shelby County. This depends on the county crosswalk (Q2 follow-up).

---

### Verification ledger (checked 2026-10-02 against the working tree and `origin/main` @ `f36b995`)
Present and as described: `src/modules/acquisitions/{tabs.ts, AcquisitionsModule.tsx, AcquisitionsIntel.tsx, RankedCandidateList.tsx, hooks.ts}` · `src/brain/{DealDrawer.tsx, EntityDrawer.tsx}` · `src/shell/{modules.tsx, tab-badges.ts, tab-types.ts}` · `src/lib/forceMountPanel.ts` · `src/primitives/{DataTable, Badge, Card, KpiStat, SegmentedControl, Skeleton, Provenance}.tsx` · `src/charts/Sparkline.tsx` · `src/modules/intel/hooks.ts` (`fetchJson`, `fetchParsedOrMirror`, `useWarehouseLive`, `QUERY_OPTS`) · `src/contracts/{client-header.ts, common.ts, deal.ts, acquisition.ts, index.ts}` · `server/warehouse/{sub-routers.ts, api.ts, db.ts, migrate.ts, intel-config.ts, capital-allocation.ts, acquisition.ts}` · `server/host-guard.ts` · `server/config.ts` · `scripts/{governance-check.ts, check-refute-required.ts, check-write-schema-drift.ts, bake-warehouse.ts}` · `.claude/workflows/refute-financial-change.js` · `tests/unit/acquisitions-tabs.test.tsx` · migrations `001`–`032` (highest `032`) · `env.example`, `worktree-env.example`. Not present (to be created): `server/edge/`, `src/contracts/edge.ts`, `033_*.sql`, the `Edge*` UI files, `tests/fixtures/edge/`.
