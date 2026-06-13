# API Contracts — Oxford Command Center

**Status:** Architecture lock file — all new routes must be documented here before implementation. Route prefix ownership is enforced by `scripts/governance-check.ts`.

**Server:** Hono 4 on `127.0.0.1:8911`
**Auth:** Localhost-only CORS (`/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/`). No external origin ever allowed.
**Content-Type:** `application/json` for all routes unless noted.
**Error shape:** `{ error: string }` with appropriate HTTP status.

---

## Core Routes (`server/index.ts`)

### `GET /api/health`

Returns server + brain state, AI availability, brief health.

**Response:**
```typescript
{
  ok: true,
  service: 'oxford-brain-server',
  state: BrainState,          // 'loading' | 'ready' | 'error'
  ai: { configured: boolean, model: string },
  brief: BriefHealth | null
}
```

---

### `GET /api/snapshot`

Returns the full typed portfolio snapshot + brain state.

**Response:**
```typescript
{ snapshot: PortfolioSnapshot, state: BrainState }
// 503: { error: 'no snapshot available', state: BrainState }
```

`PortfolioSnapshot` is the Zod-validated boundary defined in `src/contracts/`. Never bypass this type.

---

### `POST /api/refresh`

Triggers a manual workbook re-read.

**Response:** `{ state: BrainState }`

---

### `GET /api/macro`

Returns FRED macro data (live if `FRED_API_KEY` set, seeded fallback otherwise).

**Response:** `MacroData` (see `src/contracts/`)

---

### `POST /api/ai`

Streaming AI agent endpoint.

**Request body:** `{ message: string, history?: Message[] }`
**Response:** SSE stream of `{ type: 'text' | 'tool_use' | 'tool_result' | 'done', ... }`

---

### `GET /sse`

Server-Sent Events stream for real-time workbook updates.

**Events:** `{ type: 'snapshot-updated' | 'brain-state', payload: ... }`

---

### Write-back Routes (overlay mutations)

All write-backs persist to `data/overlay.json` (gitignored). Workbook stays read-only.

| Method | Path | Body | Description |
|--------|------|------|-------------|
| POST | `/api/deals` | `{ id, stage: DealStage }` | Update deal stage |
| POST | `/api/leases/:id/renewal` | `RenewalStageInput` | Update renewal stage |
| POST | `/api/properties/:id/noi-budget` | `NoiBudgetInput` | Set NOI budget |
| POST | `/api/comps` | `DealCompsActionInput` | Add deal comp |
| POST | `/api/alerts/action` | `AlertActionInput` | Dismiss/snooze alert |

Zod schemas for all body types live in `src/contracts/`.

---

### Document Search Routes

| Method | Path | Query | Description |
|--------|------|-------|-------------|
| GET | `/api/docs/search` | `?q=string` | Semantic search over indexed docs |
| GET | `/api/docs/status` | — | Index health + doc count |

---

## Warehouse Routes (`server/warehouse/api.ts` → `/api/warehouse/*`)

The warehouse router is mounted at `/api/warehouse`. The `getDb()` getter is injected at mount time (lazy singleton in production, temp-db in tests).

**503 fallback:** If `getDb()` throws, every route returns `503 { error: 'warehouse unavailable' }`. The server never crashes on a missing SQLite file.

### Import Management

| Method | Path | Body/Query | Description |
|--------|------|-----------|-------------|
| GET | `/api/warehouse/imports` | — | List all import batches |
| GET | `/api/warehouse/imports/:id` | — | Import detail + ledger entries |
| POST | `/api/warehouse/imports/:id/action` | `{ action: 'approve' \| 'reject' }` | Approve or reject pending import |

### Mapping Management

| Method | Path | Body | Description |
|--------|------|------|-------------|
| POST | `/api/warehouse/mappings` | `AddMappingInput` | Add manual account mapping override |

### Data Quality

| Method | Path | Query | Description |
|--------|------|-------|-------------|
| GET | `/api/warehouse/issues` | `?status=open\|resolved` | List DQ issues |
| POST | `/api/warehouse/issues/:id/resolve` | — | Mark DQ issue resolved |

### Analytics — Read-Only Queries

All analytics routes are GET, read-only, no side effects.

| Path | Query Params | Description |
|------|-------------|-------------|
| `/api/warehouse/noi-matrix` | `?period=YYYY` | NOI by property/period matrix |
| `/api/warehouse/analytics/metrics` | `?propertyId=&period=` | Period metrics for one property |
| `/api/warehouse/analytics/growth` | `?propertyId=&periods=` | Growth series (NOI trend/CAGR) |
| `/api/warehouse/analytics/since-acquisition` | `?propertyId=` | Since-acquisition performance |
| `/api/warehouse/analytics/drivers` | `?from=YYYY&to=YYYY` | ΔNOI driver decomposition |
| `/api/warehouse/analytics/anomalies` | — | Statistical anomalies across portfolio |
| `/api/warehouse/analytics/benchmarks` | `?period=YYYY&metric=` | Cross-property benchmarks + quartiles |
| `/api/warehouse/analytics/rankings` | `?metric=&period=` | Property rankings by metric |
| `/api/warehouse/analytics/pm-scorecards` | `?period=` | Property manager scorecards |
| `/api/warehouse/analytics/scores` | — | Health/attention/capital scores |
| `/api/warehouse/data-quality` | — | Basis coverage + DQ summary |

### Numeric Metric Keys (benchmarkable)

```
revenue | opex | noi | oxfordNoi |
noiMargin | expenseRatio |
revenuePerSf | noiPerSf | expensePerSf |
taxesPerSf | insurancePerSf | repairsPerSf
```

---

## Route Ownership

| Prefix | Owner | Notes |
|--------|-------|-------|
| `/api/health`, `/api/snapshot`, `/api/refresh`, `/api/macro`, `/sse` | Core/Brain | Do not modify without architect review |
| `/api/ai` | Intelligence Agent | Streaming — test carefully |
| `/api/docs/*` | Integration Agent | RAG index |
| `/api/deals`, `/api/leases/*`, `/api/properties/*`, `/api/comps`, `/api/alerts/*` | Core/Analytics Agent | Overlay write-backs |
| `/api/warehouse/*` | Analytics Agent | Warehouse sub-router |

**Duplication rule:** No two files may define a handler for the same route path. `governance-check.ts` scans for this.
