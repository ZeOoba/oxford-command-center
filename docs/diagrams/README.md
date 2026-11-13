# System diagrams

Sequence- and subsystem-level companions to the architecture diagram in the root `README.md`.
Each was verified on 2026-10-06 against `034fdf1` (the CI diagram was re-checked and corrected on 2026-10-28 against `f642175`); `origin/main` at `0d98bfc` differs only in
`tests/` (PR #440). The `file:line` evidence comments are a snapshot; re-verify before relying on a
specific line. Annotations in square brackets (for example "no fetch timeout") mark known gaps
tracked in the 2026-10-06 improvement plan, not intended behavior.

`architecture/system-overview.md` still carries the older ASCII chains; replacing them there is an
architect-owned edit (CLAUDE.md section 4) and is pending.

## Spine A refresh (sequence)

Workbook save -> parse (with Notion/Graph calls inside the parser) -> overlay/QuickBooks merge -> runtime reconcile -> persist gate -> warehouse capture -> SSE notify -> client refetch. Supersedes the ASCII Spine A chain in `architecture/system-overview.md`.

<details><summary>Evidence</summary>

- server/brain.ts:80-187,276-320,403-417; server/workbook/parse.ts:23-24,1662,1671;
- server/index.ts:148-280,360-367,630-655; src/data/sse.ts:13-35; src/data/provider.tsx:19-21; src/data/queries.ts:13,42

</details>

```mermaid
sequenceDiagram
    autonumber
    participant FS as Workbook file (OneDrive)
    participant W as chokidar watcher (brain.ts:410)
    participant B as Brain.refresh (brain.ts:80)
    participant P as parseWorkbook (parse.ts)
    participant N as Notion API
    participant G as MS Graph
    participant OV as data/overlay.json
    participant QB as QuickBooks CSV / disk fallback
    participant RT as reconcile-runtime.checkSnapshot
    participant SF as data/snapshots/portfolio.json (tracked)
    participant IX as index.ts on('snapshot')
    participant WH as SQLite warehouse
    participant C as Browser (sse.ts + TanStack Query)

    FS->>W: change (awaitWriteFinish 1200ms) [no 'error'/'add' handler]
    W->>B: debounce 300ms -> refresh('file-change')
    Note over B: also triggered by POST /api/refresh and startup
    B->>P: parseWorkbook(workbookPath())
    P->>P: ExcelJS read + parse sheets (Zod-validated)
    P->>G: loadM365Tasks() [no fetch timeout]
    P->>N: loadDeals() [no fetch timeout, no 429 retry]
    P-->>B: snapshot + flags + degradation markers
    B->>SF: loadPreviousLeaseIds() -> anomaly floor
    B->>OV: applyOverlay (overlay loaded once at boot)
    B->>QB: resolveQuickbooks (prefer memory, else disk)
    B->>RT: checkSnapshot -> runtime flags
    B->>SF: persist() (declines when deals/M365 degraded or reconcile error)
    B->>IX: emit('snapshot', {reason, flags})
    IX->>WH: captureOccupancy / captureMonthSnapshot / captureInsurance / writeDebtSnapshot (each try/catch, warn-only)
    B-->>C: SSE 'snapshot' event (notification only, no payload used)
    C->>C: invalidateQueries(SNAPSHOT_KEY)
    C->>B: GET /api/snapshot (full payload refetch)
    C->>C: buildAnalytics() in useMemo, once per useAnalytics() consumer
    Note over C: 5-minute refetch backstop (queries.ts:13)

    rect rgb(245,245,245)
    Note over B,OV: User action path (POST /api/actions/*): mutate overlay -> saveOverlay -> re-merge base -> persist -> emit (reason 'action:*', warehouse capture skipped)
    end
```

## Spine B warehouse

Ingest pipeline, table groups, Spine A captures, Notion/HubSpot acquisition syncs, Oxford Edge, FRED into engines, Notion write-back, warehouse bake, and the local-only NOI cross-check.

<details><summary>Evidence</summary>

- system-overview.md:41-56 (pipeline order, verified file presence); server/warehouse/sub-routers.ts:24,65;
- acq-hubspot-sync.ts:141,180,255,275; acq-notion-sync.ts:133,151; notion/capital-writeback.ts:40,125,217;
- api.ts:~904,~923,973-982; server/edge/loader.ts:15,34-35; edge/config.ts:12-17; edge/pull-queue.ts:4,253;
- capital-allocation.ts:50-53; market-intel.ts:2,66; debt-api.ts:26; scripts/bake-warehouse.ts:12-14,89,332,369;
- server/index.ts:148-280; scripts/reconcile-noi-crosscheck.ts; server/warehouse/reconcile-noi.ts

</details>

```mermaid
flowchart LR
    subgraph ingest["Ingest (npm run warehouse:backfill / Data > imports)"]
        PL["32 P&L files<br/>(OneDrive Property Financials)"] --> DET["detect.ts<br/>filename grammar + alias"]
        DET --> PRS["parse/qb-excel.ts<br/>QB / Yardi / AppFolio"]
        PRS --> RAW["RawStatementSchema.parse<br/>+ raw-store.ts SHA-256 copy"]
        RAW --> MAP["mapping.ts<br/>manual > seed > learned"]
        MAP --> ING["ingest.ts<br/>transactional commit"]
    end

    subgraph db["SQLite finance.sqlite (WAL, busy_timeout 15s)"]
        LEDGER[("ledger_entries / import_batches /<br/>account_mappings / data_quality_issues")]
        SNAPS[("property_occupancy / portfolio_month_snapshot /<br/>property_insurance_policies / debt_positions")]
        ACQ[("acq_candidates / acq_scores / ...")]
        CFG[("capital_config (governors, hurdle) /<br/>calibration_* / recommendations")]
        LM[("lm_* lease-market tables")]
        REC[("record spine: entity_xref, documents, lease_facts,<br/>obligations, deal_decisions, agent_runs, audit_log")]
        EPL[("edge_pull_log (append-only triggers)")]
    end

    ING --> LEDGER
    SPA["Spine A refresh<br/>(index.ts on 'snapshot')"] -- "per-refresh capture" --> SNAPS

    NOTION["Notion Acq Pipeline"] -- "POST /acq/sync/notion" --> ACQ
    HUB["HubSpot pipeline"] -- "POST /acq/sync/hubspot" --> ACQ
    COSTAR["Lease-market intake files"] -- "lease-market:ingest" --> LM
    EDGEF["oxford-edge markets.json<br/>(read-only, never stored)"] --> EDGE["server/edge/*"]
    EDGE --> EPL

    subgraph engines["Engines (pure-ish computation, per request)"]
        MET["metrics / growth / drivers /<br/>anomalies / benchmarks / scores"]
        DEBT["debt-scoring"]
        CAP["capital-allocation<br/>(5-way verdict; hurdle from capital_config)"]
        ACQE["acq-engine + acquisition scoring<br/>(config/acquisition-ruleset.v1.json, replacement-cost.v3.json)"]
        INS["insurance / tax analysis"]
        LMC["lease-market compute"]
        CAL["calibration"]
    end
    LEDGER --> MET
    SNAPS --> DEBT
    SNAPS --> INS
    CFG --> CAP
    MET --> CAP
    DEBT --> CAP
    ACQ --> ACQE
    CFG --> ACQE
    LM --> LMC
    CFG --> CAL

    FRED["FRED via getMacro()"] --> CAP
    FRED --> DEBT
    FRED --> MKT["market-intel"]

    CAP -- "POST /capital-allocation/sync-notion" --> NPR["Notion Property Register<br/>(PATCH write-back)"]

    engines --> API["/api/warehouse/* (Hono sub-routers)"]
    EDGE --> API
    API --> UI["Financials / Capital / Obligations / Leasing /<br/>Lease Market / Brain / Data / Acquisitions(Edge)"]
    API -. "HTTP (preferred) or direct DB after WAL checkpoint" .-> BW["scripts/bake-warehouse.ts<br/>-> public/warehouse.json (daily)"]

    XCHK["reconcile:noi-crosscheck (local gate only)"] -. "Spine A Property.noi vs ledger NOI" .- LEDGER
```

## Mirror deploy and daily brief

The off-fleet Windows task: gate-latch check, isolated build root, PRE-deploy Access probe of the live target, `build:mirror` (bake, brief + Outlook COM send, typecheck, vite build, dist roster scan in REDACTED mode), bounded wrangler deploy from the build root, post-deploy Access 302 probe, failure alert, and lockdown containment on a served exposure (audit wf_9bf74429-aaf findings 1/4/30/31, 2026-11-12).

<details><summary>Evidence</summary>

- scripts/register-mirror-task.ps1:53-57; scripts/deploy-mirror.ps1:22,45-63,169,246,280-303,358;
- package.json build:mirror/build/prebuild; scripts/bake-mirror.ts:3,6,196,267-279;
- server/workbook/parse.ts:23-24,1662,1671; server/brief/run.ts:26; server/brief/send.ts:8; server/index.ts:287-298

</details>

```mermaid
flowchart TB
    TASK(["Windows Task 'ORA Command Center - Mirror Deploy'<br/>hourly + daily 06:45 local<br/>register-mirror-task.ps1:53-54"])
    TASK --> DM["scripts/deploy-mirror.ps1"]

    subgraph S1["Step 1 - isolated build root"]
        FETCH["git fetch origin (bounded)"] --> ROOT["build root hard-reset to origin/main<br/>lib/deploy-buildroot.ps1"]
        ROOT --> ENV[".env imported into process env<br/>(never MIRROR_INCLUDE_CONFIDENTIAL / MIRROR_ACCESS_PREPROBE)<br/>+ BRIEF_HEALTH_PATH -> primary checkout data/"]
        ENV --> PRE["Assert-MirrorPreDeployAccessGate<br/>live production target: root, staged JSON, Function routes<br/>pass -> MIRROR_ACCESS_PREPROBE=passed + MIRROR_INCLUDE_CONFIDENTIAL=1"]
    end
    LATCH{"gate latch open?<br/>data/alert-state/mirror-gate-latch.json"}
    DM --> LATCH
    LATCH -- "no" --> FETCH
    LATCH -- "yes: GATE LATCH OPEN, nothing baked" --> ALERTL["suppressible alert"]

    subgraph S2["Step 2 - npm run build:mirror (no change detection: runs every hour)"]
        BAKE["bake-mirror.ts"]
        PW["parseWorkbook()<br/>ExcelJS + loadDeals() Notion + loadM365Tasks() Graph<br/>(network calls INSIDE the parser)"]
        MAC["getMacro() FRED (+ seeded fallback)"]
        RED["confidential-deal redaction<br/>(FULL only with the flag + passed pre-probe, scripts/lib/mirror-mode.ts)<br/>REDACTED removes stale warehouse.json first"]
        BR["runBrief() server/brief/run.ts<br/>daily brief + critical alerts"]
        SEND["send.ts -> _shared/send-via-outlook.ps1<br/>(principal only)"]
        BH[("data/brief-health.json<br/>(primary checkout)")]
        PUB[("public/snapshot.json + macro.json")]
        WHB["bake-warehouse.ts (OFF on hourly; daily, BAKE_WAREHOUSE=1)"] --> PUBW[("public/warehouse.json")]
        TYPES["prebuild: generate confidential-scan types"] --> TSC["tsc --noEmit (full typecheck)"] --> VITE["vite build -> dist/"]
        VITE --> SCAN["scan-mirror-dist.ts<br/>REDACTED: roster-scan every dist/ text file"]
        BAKE --> PW
        BAKE --> MAC
        PW --> RED --> PUB
        BAKE --> BR --> SEND
        BR --> BH
        MAC --> PUB
    end
    PRE --> BAKE
    PUB --> VITE
    PUBW -.-> VITE

    subgraph S3["Step 3-4 - publish + verify"]
        WR["build root's wrangler pages deploy dist<br/>cwd + --cwd = build root (its functions/ only)<br/>bounded timeout (< PT30M task limit)"]
        PAGES["Cloudflare Pages ora-command-center<br/>+ functions/api/{ai,whoami,warehouse/acquisition/score}"]
        PROBE["Invoke-AccessGateProbe<br/>expects 302 to Access login, not 200"]
        ALERT["Send-DeployFailureAlert + deploy beacon"]
        LOCK["served exposure (2xx, or a Function's own 4xx):<br/>latch + lockdown page (no data, no Functions)<br/>+ second CRITICAL alert"]
    end
    SCAN --> WR --> PAGES
    PRE -. "GATE CHECK FAILED" .-> ALERT
    ALERT -.-> LOCK
    WR --> PROBE
    WR -. timeout .-> PROBE
    PROBE -. fail .-> ALERT
    WR -. fail .-> ALERT

    BH -. "read by GET /api/health<br/>(hard-coded relative path, server/index.ts:287)" .-> BRAINSRV["Brain Server (primary checkout)"]
```

## CI and gates

Hooks vs permissions.deny, local `gate` (11 steps) vs `gate:ci` (9 steps), PR-only refute attestation, required checks (`gate`, `refute-required`), and what never runs automatically.

<details><summary>Evidence</summary>

- package.json scripts gate, gate:ci, prepare, hooks:install, check:refute;
- .github/workflows/ci.yml:13-16,49-59,73,80,95; order-fragility.yml:44; full-gate-selfhosted.yml:11-12,24;
- scripts/check-refute-required.ts:4-6,9-12,57-62,220,238,307-345; .claude/settings.json:63-68; .claude/hooks/*;
- vitest.config.ts:76-90 (no thresholds); scripts/*.smoke-test.ps1 (not invoked by any workflow or npm script)

</details>

```mermaid
flowchart TB
    DEV["Agent / Gabriel session"] --> HOOKS["Claude PreToolUse hooks<br/>bash-guard.mjs, file-guard.mjs (fail-open)<br/>+ permissions.deny confidential-terms.json (fail-closed)"]
    DEV --> COMMIT["git commit"]
    COMMIT --> CMSG["commit-msg hook<br/>(trailer guard; installed by npm prepare)"]
    COMMIT --> LGATE["npm run gate (LOCAL, 11 steps, manual)<br/>governance, typecheck, lint, check:dev-css,<br/>check:schema-drift, test, reconcile:snapshot,<br/>reconcile, reconcile:noi-crosscheck,<br/>warehouse:verify, warehouse:drift"]
    LGATE -. needs .-> DATA[("OneDrive workbook + 32 P&L files<br/>+ live finance.sqlite")]
    COMMIT --> PUSH["git push"]
    PUSH --> PREPUSH["pre-push hook<br/>1) confidential scan (blocking) 2) refute-trailer gate (blocking) 3) NOI cross-check (advisory)"]

    PUSH --> TRIG{"event"}
    TRIG -- "PR (any branch)" --> CI
    TRIG -- "push to main" --> CI
    TRIG -- "push to other branch, no PR" --> NONE["no CI"]

    subgraph CI["ci.yml (runner: ubuntu-latest or laptop when CI_RUNNER=self)"]
        G["job gate: npm ci --include=dev -> npm run gate:ci (9 steps)<br/>governance, typecheck, lint, check:dev-css, check:schema-drift,<br/>test, reconcile:snapshot, build, check:bundle"]
        R["job refute-required (PR only):<br/>check:refute --strict base..head<br/>per-commit Refute-Reviewed / Refute-Skip trailer"]
    end
    R -. "attests" .-> WF["refute-financial-change workflow<br/>.claude/workflows/refute-financial-change.js<br/>(run id in trailer; not path-referenced by the check)"]

    CI --> BP["branch protection: required checks 'gate', 'refute-required'"]
    BP --> SQUASH["squash-merge to main<br/>(squash msg must carry UNION of trailers; nothing re-checks on main)"]
    SQUASH --> MIRRORTASK["hourly mirror task builds origin/main<br/>(see "Mirror deploy and daily brief" above)"]

    subgraph notrun["NOT run automatically"]
        E2E["test:e2e (Playwright smoke + a11y)"]
        COV["test:coverage (no thresholds)"]
        FMT["prettier check (no script)"]
        PS["9 scripts/*.smoke-test.ps1 (deploy path)"]
        FULL["full-gate-selfhosted.yml (workflow_dispatch only)"]
    end
    CRON["order-fragility.yml weekly Mon 09:00 UTC<br/>test:shuffle, pinned ubuntu-latest (ignores CI_RUNNER)"]
```
