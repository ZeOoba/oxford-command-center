# ORA Command Center â€” Synthesis Audit Report (DELTA-ONLY)
**Baseline:** origin/main @ 823574d Â· worktree `oxford-cc-wt-audit-20260613` Â· read-only static analysis
**Scope:** deltas the 2026-06-13 master plan / CHANGELOG did NOT flag. Ordered by (severity, then ORA goal-priority: acquisition velocity > ops optimization > institutional quality > comms/brand > knowledge capture). Each finding carries a riskTierHint to pre-stage the fix phase.

---

## HIGH (7)

### H1 Â· Confidential deal terms hardcoded in git-tracked source â€” `confidential-deal-terms-in-committed-source`
**Goal:** institutional quality / confidentiality Â· **Risk:** RED (confidential + external remote)
`src/data/seed-deals.ts:31-52`. An active LOI/PSA-stage acquisition's full economics (name, location, SF, price, cap, IRR, equity multiple) plus named counsel and env consultant are committed verbatim to an off-machine GitHub remote (`github.com/ZeOoba/oxford-command-center`). The `confidential: true` flag only drives the *runtime bake redaction* â€” it does nothing to keep terms out of source or git history. Directly violates CLAUDE.md hard invariant #3 (active-confidential-deal terms live ONLY in session context / `confidential-terms.json`). The master-plan pre-mortem and AUDIT.md both discuss FUTURE confidentiality blast radius but missed that the terms are ALREADY committed.
**Fix:** drop the confidential row from the committed seed; source it at runtime only from the gitignored overlay / Notion adapter (same pattern as `NOTION_CONFIDENTIAL_NAME_PATTERNS`). Scrub git history unless the remote is a private single-owner repo. *(Report-only â€” gated item.)*

### H2 Â· `/noi` matrix double-counts NOI (no coherent-batch resolution) â€” `noimatrix-no-coherent-batch-double-count`
**Goal:** ops optimization / institutional quality Â· **Risk:** YELLOW (financial mechanism)
`server/warehouse/queries.ts:117-128` (served `api.ts:106 /noi`). Raw `GROUP BY l.property_id, l.period` over all `is_active=1` rows with NO `selectCoherentBatch`. `metrics.ts:34-37` documents â€” and `propertyPeriodMetrics` (metrics.ts:92-114) fixes â€” exactly this: a `(property, period)` group can hold rows from >1 active import when a full-year (period_end 12-31) and a same-year YTD (06-30) coexist; the supersede key is `period_start/period_end` (`actions.ts:64` + ingest mirror), so both stay active under ledger period `'YYYY'`. Latent in the staged corpus (2026 is YTD-only) but fires on the first same-year full-year+YTD coexistence as a silent ~2x NOI overstatement. `scripts/warehouse-verify.ts:163-168` shares the identical un-resolved GROUP BY, so the gate cannot catch it.
**Fix:** derive `noiMatrix` from `propertyPeriodMetrics(db)` (applies `selectCoherentBatch`), and mirror the fix into the gate's step-5 NOI print.

### H3 Â· Approve-path dual-side classification flip mis-signs NOI â€” `approve-path-dual-side-classification-flip`
**Goal:** institutional quality Â· **Risk:** YELLOW (financial mechanism)
`server/warehouse/actions.ts:45-57`. `approveImport` re-resolves rows via `resolveMapping` with NO section hint (`actions.ts:47`), unlike ingest (`ingest.ts:116` passes `a.section`). The side-guard in `mapping.ts:83-96` runs only when section is provided; absent it, the resolver returns `rows[0]` on an undefined `property_id IS NULL` rowid tiebreak. The seed deliberately preserves BOTH sides of dual-side utility accounts (`Gas` recovery/income line 44 AND opex line 236; same for Electric/Water â€” `2026-06-12-pfi-account-mapping-seed.json`). On human approval an expense `Gas` row can re-resolve to the income/recovery mapping, flipping its NOI sign contribution (income adds, opex subtracts). The `actions.ts:27-29` "correct" comment ignores the dual-side entries; `warehouse-verify` exercises ingest only, never approve.
**Fix:** persist `section` on `ledger_entries` and pass it through approve's `resolveMapping`; OR constrain re-resolution to the row's existing `classificationSide`; OR reject dual-side accounts in the approve path when section is unavailable.

### H4 Â· Scenario engine re-derives capped-property value, mixing going-in cap as exit cap â€” `scenario-value-basis-mix`
**Goal:** institutional quality / acquisition velocity Â· **Risk:** YELLOW (financial mechanism)
`src/analytics/engine.ts:44-49`. For a capped property the scenario `oxfordValue` is rebuilt as `noi/capRate` â€” discarding the source-of-record workbook `oxfordValue` AND treating the going-in cap as the exit cap â€” while the null-cap fallback on the SAME line correctly scales `p.oxfordValue * (revenueFactor/exitCapFactor)`. Reproduced with the repo's own fixture (`tests/unit/analytics.test.ts:300`, noi=100/cap=0.07/value=1000): Downside (revenueFactor 0.9, exitCapFactor 1.05) gives `90/0.0735 = 1224` â€” value RISES ~22% in the DOWNSIDE scenario, lowering LTV and `weightedCapRate` (engine.ts:73-74). The `applyScenario` test asserts noi/capRate/occPct but never `oxfordValue`, so it is untested. Corrupts every non-Base portfolio value/LTV/cap KPI â€” the capital-allocation what-if surface â€” understating downside risk.
**Fix:** scale the source value consistently in both branches (`p.oxfordValue * revenueFactor/exitCapFactor`), OR re-derive Base as `noi0/capRate0` to remove the Base-boundary discontinuity. Add an `oxfordValue` assertion to the scenario test.

### H5 Â· noiVariance divides partial-actual sum by full-budget sum (phantom shortfall) â€” `noi-variance-mismatched-totals`
**Goal:** ops optimization / institutional quality Â· **Risk:** YELLOW (financial mechanism)
`src/brain/noi-variance.ts:43-49`. Per-row variance is correctly paired-guarded (`budget!==null && actual!==null`, line 38), but `totalBudget`/`totalActual` reduce over `r.budget ?? 0` / `r.actual ?? 0` across ALL rows. During the realistic partial-QB-rollout state, a property with a budget but no resolved actual contributes full budget and 0 actual â†’ a large phantom negative `totalVariance`. `CloseModule.tsx:36` renders this as the month-end "Portfolio Variance" headline KPI, gated only on `qb` truthy (not per-property pairing) and colored red when <0.
**Fix:** compute totals only over rows where BOTH budget and actual are non-null (mirror the per-row guard); surface the count of budget-only/unpaired properties as a caveat.

### H6 Â· Warehouse read boundary bypasses the Zod contract layer â€” `warehouse-read-boundary-bypasses-contracts`
**Goal:** institutional quality + every roadmap engine Â· **Risk:** YELLOW (financial mechanism)
`src/modules/intel/analytics-hooks.ts:10-30` (decls) + `server/warehouse/api.ts:150-209` (raw `c.json`). Every analytics payload is emitted with NO output schema and consumed via `fetchJson<T>` casts; `analytics-hooks.ts:10-13` openly comments that the interfaces "mirror the engine return types verified against source" and re-declares `HealthBand`/`AttentionBand`/`CapitalAction`. Violates `coding-standards.md:14` ("All server-to-client data must cross through a Zod schemaâ€¦ Never pass raw JSON as an implicit type") and the system-overview "contracts are the ONLY typed boundary." The acquisition engine (`src/contracts/acquisition.ts` + `AcquisitionScore.parse`) proves the house knows the correct pattern â€” making the warehouse half an unenforced boundary where a server-side field rename silently mistypes the client and ships wrong financial numbers to a capital decision with no parse error. This is the structural reason the warehouse half cannot cleanly "absorb the planned engines."
**Fix:** promote engine return types into Zod schemas in the existing `src/contracts/warehouse.ts` (`PeriodMetricsSchema`, `PropertyScoreSchema`, etc.), `.parse` before `c.json` (mirroring acquisition.ts), and have `analytics-hooks.ts` import `z.infer` types + `.parse` responses. Delete the hand-redeclared interfaces.

### H7 Â· `rankProperties` omits the SF-less exclusion `benchmarkMetric` applies â€” `rankproperties-missing-sfless-exclusion`
**Goal:** institutional quality / capital-allocation context Â· **Risk:** YELLOW (financial mechanism)
`server/warehouse/benchmarks.ts:115-121`. `rankProperties` lacks the `if (!isOperatingRealEstate(m)) continue;` guard present in `metricValues` (line 76) and `cohortBases` (line 90) â€” and `isOperatingRealEstate` is already imported (line 8). `api.ts:197-200` returns `byMetric: benchmarkMetric(...)` AND `rankings: rankProperties(...)` from the SAME request and metric. For dollar/ratio keys (revenue/opex/noi/oxfordNoi, noiMargin/expenseRatio), a SF-less non-operating entity (e.g. solar royalty, `rentableSf` null) carries a finite value, so it appears in `rankings` with a quartile drawn from cutoffs computed WITHOUT it, and shifts every real property's rank by one. Per-SF keys self-exclude, so the scoring path is unaffected â€” but `/analytics/benchmarks` ships inconsistent populations to the UI.
**Fix:** add `if (!isOperatingRealEstate(m)) continue;` to the `rankProperties` loop.

---

## MEDIUM (15)

### M1 Â· Deal-comps sends a confidential deal's identity to external web search â€” `deal-comps-sends-confidential-deal-to-external-web-search`
**Goal:** acquisition velocity / confidentiality Â· **Risk:** RED (confidential + external egress)
`server/ai/comps.ts:28-48` (route `server/index.ts:134-148`). `fetchDealComps` interpolates `deal.name` + location into the prompt and enables Anthropic's `web_search_20250305` (max_uses 6) with NO `deal.confidential` guard before sending. `confidential` is a first-class contract field (`contracts/deal.ts:39`), so the guard is feasible; its absence means an off-market target's name/address can reach external search infrastructure, tipping brokers/competitors. Egress is user-initiated (button), which bounds it.
**Fix:** gate the route on `!deal.confidential` (return "disabled for confidential deals"), or require an explicit per-call external-search acknowledgment. *(Report-only â€” gated item.)*

### M2 Â· LTV alert ceiling 0.65 diverges from the 0.40 governor with no annotation â€” `ltv-alert-ceiling-governor-divergence`
**Goal:** acquisition velocity / ops optimization Â· **Risk:** RED (governor-constant adjacent)
`src/analytics/conditions.ts:17` (`ltvCeiling: 0.65`). Alert fires only above 65% LTV (lines 81-88), so a property between 41% and 65% â€” already past the firm acquisition governor (LTV â‰¤ 40%, CLAUDE.md invariant 4) â€” triggers no signal. The 0.65 is a hardcoded literal with no code-level documentation of its intentional gap to the governor, so a future engineer could "tighten" it toward 0.40 conflating two separate concepts.
**Fix:** REPORT for ratification (not a unilateral change â€” invariant-4 protected). Annotate intent inline ("intentionally above the 40% acquisition governor â€” fires on legacy/non-compliant positions"); optionally add an INFO-tier `ltvGovernorWarnPct: 0.40`. Do NOT change the 0.40 governor. *(Report-only â€” gated item.)*

### M3 Â· `growthSeries`/`detectAnomalies` lack a same-basis guard â€” `growth-no-basis-guard`
**Goal:** institutional quality Â· **Risk:** YELLOW (financial mechanism)
`server/warehouse/growth.ts:59-77`. `comparable` is gated ONLY on `sameGrain` (grainHint equality, line 65); no basis check. Everywhere else cross-basis is treated as non-like-for-like (`scores.ts` basis cohorts, `benchmarks.ts` mixedBasis 26-31, `reconcile-noi.ts` unknown-basis downgrade). A YoY pair with `prev.basis != cur.basis` (e.g. cashâ†’accrual between two ingested years) is labeled `comparable:true`, manufacturing a basis-shift artifact that feeds health/attention scores and anomaly bands.
**Fix:** require `(prev.basis ?? 'unknown') === (cur.basis ?? 'unknown')` in the comparability predicate (growth.ts) and the anomalies skip; mark cross-basis pairs `comparable:false` with null growths.

### M4 Â· `CapitalAction` governor-vocabulary enum hand-duplicated across the server/client boundary â€” `capitalaction-enum-duplicated-cross-boundary`
**Goal:** capital-allocation capstone (F7) Â· **Risk:** YELLOW (financial vocabulary)
`src/modules/intel/analytics-hooks.ts:23` + `server/warehouse/intel-config.ts:9`. The identical 4-value union is declared in two places with no shared import, consumed by exhaustive `Record<CapitalAction,â€¦>` maps (`OwnershipView.tsx:86/93`, `PropertyIntelView.tsx:76/83`, `synthesis.ts:53`). The master plan's planned 4â†’5-way expansion (Buy/Hold/Sell/Refi/Improve) â€” the central output of the highest-value engine â€” must then touch â‰¥2 unsynchronized declarations plus every map, and TS only catches the maps in whichever file imports the updated copy.
**Fix:** define `CapitalAction` once as a Zod enum in `src/contracts/warehouse.ts`, import `z.infer` in both consumers, delete both literal declarations. The 5-way change becomes a single compiler-enforced edit.

### M5 Â· `buildNoiReconcileInputs`/`reconcileNoiABFromDb` (Spine-Aâ†”B join) have zero tests â€” `no-test-buildNoiReconcileInputs`
**Goal:** ops optimization Â· **Risk:** GREEN (additive test coverage)
`server/warehouse/reconcile-noi.ts:224-268`. Grep of `tests/` for `buildNoiReconcileInputs|reconcileNoiABFromDb` returns no matches. The slug-join (`propertyId = slug(name)`), `latestFullYearPeriod` selection (line 241), and `financialMode==='lease-run'` routing (line 250) of the capital-allocation-feeding reconciliation are untested. The F1 classifier itself is on the ALREADY-DONE baseline; only this DB-join/period-selection layer is the gap.
**Fix:** add a DB-driven integration test seeding a lease-run + normal + YTD-only property; assert (a) lease-run skipped, (b) normal joins on correct full-year period, (c) YTD-only â†’ `warehouseOxfordNoi=null`, (d) slug mismatch â†’ no spurious match.

### M6 Â· Untested acquisition-engine floor/gate branches â€” `no-test-acquisition-floor-and-gate-branches`
**Goal:** acquisition velocity / governor discipline Â· **Risk:** GREEN (additive test coverage)
`server/warehouse/acquisition.ts:199-246`. STRONG_BASE fixture hard-codes `yearBuilt:2005` and `underwriteHorizonYrs:5`, so the 10yr IRR bar (line 244), pre-millennium/null vintage basis floor (lines 230-234), YoC exact boundary (0.08), `floorIndeterminate` (null basis â†’ T2 cap, line 238), and child/env/ground-lease kills (line 207) are never exercised. This is the GOVERNOR-SURFACE engine; unverified directional bar-selection risks killing a valid 10yr/vintage underwrite or pursuing a deal that only clears the easier bar.
**Fix:** add the enumerated boundary cases (10yr IRR @0.13 passes vs default-horizon kills; yearBuilt 1998/null vs 2001 at the 30%/25% basis bars; YoC 0.08/0.079/null; childRelatedÂ±reviewed; null basis â†’ cappedAtT2).

### M7 Â· Governor-level alert constants are not pinned as literal invariants â€” `no-test-dscr-ltv-governor-constants-pinned`
**Goal:** institutional quality Â· **Risk:** RED (governor-constant)
`src/analytics/conditions.ts:15-17` (`dscrFloor 1.1`, `dscrWatch 1.25`, `ltvCeiling 0.65`). `conditions.test.ts` tests functional behavior (1.2 fires, 1.25 does not) but the pinning test (lines 211-216) asserts only lease/cash thresholds â€” never dscrWatch/dscrFloor/ltvCeiling. A PR changing `dscrWatch 1.25â†’1.20` passes CI. The 0.40 acquisition LTV governor is intentionally out of the ruleset (`acquisition-contract.test.ts:43`), so it has no runtime pin at all. CLAUDE.md invariant 4 prohibits modifying these without permission.
**Fix:** add a pinning test: `expect(ALERT_THRESHOLDS.dscrWatch).toBe(1.25)` etc.; consider a separate pin on the 0.40 governor wherever encoded.

### M8 Â· `scoreAcquisition` determinism untested without injected `now` â€” `scoredAt-wall-clock-not-guarded`
**Goal:** acquisition velocity Â· **Risk:** GREEN (additive test coverage)
`server/warehouse/acquisition.ts:399` (`scoredAt: opts.now ?? new Date().toISOString()`). Every test call passes `{ now: NOW }`; no test calls without `opts.now` to assert the only non-deterministic field is `scoredAt`. If a future regression routed wall-clock into the verdict/freshness path, the existing determinism test would still pass â€” breaking `inputsVersion` stability and memoized capital-allocation records undetected.
**Fix:** add a test calling `scoreAcquisition` twice without `opts.now`, destructure `{ scoredAt, ...rest }`, assert `rest-A` deep-equals `rest-B`.

### M9 Â· N+1 correlated subqueries in `propertyPeriodMetrics` â€” `n1-correlated-subqueries-metrics`
**Goal:** ops optimization Â· **Risk:** GREEN (additive-safe optimization)
`server/warehouse/metrics.ts:93-104`. Three independent correlated subqueries (`period_grain`, `basis`, `period_end`) each re-read `import_batches` for the same `l.import_id` per ledger row, though all three columns come from one batch row. This is the spine of every analytics route â€” ~3600 PK lookups per request vs ~1200 with a JOIN at current scale.
**Fix:** replace the three subqueries with a single `INNER JOIN import_batches b ON b.id = l.import_id`, keeping `l.import_id AS importId` for `selectCoherentBatch`.

### M10 Â· `propertyPeriodMetrics` called 6Ã— per load with no cache â€” `repeated-full-table-scan-per-route`
**Goal:** ops optimization Â· **Risk:** GREEN (additive-safe optimization)
`server/warehouse/api.ts:150-209`. Six route handlers (`/metrics`, `/growth`, `/anomalies`, `/benchmarks`, `/scores`, `/pm`; a 7th at `/drivers`) each call `propertyPeriodMetrics(db)` independently. IntelModule fires all in parallel on load, and every warehouse mutation invalidation repeats all six in rapid succession â€” 6Ã— redundant full-ledger scans creating WAL read contention with concurrent ingest, compounding M9.
**Fix:** add a short-TTL module memo keyed by the `WarehouseDb` instance, OR a single `/analytics/bundle` endpoint computing metrics once.

### M11 Â· Column-def arrays rebuilt every render force full sort recompute on every SSE push â€” `columns-array-inline-not-memoized`
**Goal:** ops optimization / institutional quality Â· **Risk:** GREEN (additive-safe)
`src/modules/portfolio/PortfolioModule.tsx:19-45`. `cols` is a plain const in the render body (no `useMemo`); `DataTable.tsx:46` includes `columns` in `useMemo([rows, sort, columns])`, so a fresh array literal each parent render â€” including every SSE snapshot push and scenario toggle â€” recomputes the sort on every table in the active view. Same pattern across ~9 consumers (Leases, Debt, Cash, Insurance, Imports, DataQuality, Ownership AttentionMatrix, Managers).
**Fix:** wrap each `cols` in `useMemo(() => [...], [deps])` with a stable/empty dep array, or hoist to module scope where there are no runtime deps.

### M12 Â· Pervasive helper duplication; `tenantSlug` is a diverged weaker copy of canonical `slug()` â€” `daysbetween-inline-5x`
**Goal:** ops optimization / institutional quality Â· **Risk:** YELLOW (one path is a correctness risk)
`src/brain/tenants.ts:5-6` (+ `engine.ts:24/28`, `renewals.ts:4-6`, `critical-dates.ts:4-6`, `conditions.ts:6-9`). `DAY_MS`/`daysBetween` are char-identical across 5 source files; `sum()` across 4. The correctness edge: `tenantSlug` (tenants.ts:10-15) is a weaker copy of canonical `slug()` (`common.ts:72-81`) â€” missing `.normalize('NFKD')`, diacritic strip, and 64-char cap â€” so a Unicode tenant name (e.g. "MÃ¼ller") yields different ids and breaks tenant-note lookups. Silent divergence between the alert engine and renewal board would produce different day-counts (different urgency classes) with no compiler error. `fmtSignedPct` is also defined twice (`OwnershipView.tsx:667`, `PropertyIntelView.tsx:470`).
**Fix:** extract `DAY_MS`/`daysBetween`/`sum` to `src/lib/dates.ts`; make `tenantSlug` call canonical `slug()`; export `fmtSignedPct` once from `src/analytics/format.ts`.

### M13 Â· Two independent critical-date pipelines diverge silently â€” `dual-critical-date-paths`
**Goal:** ops optimization Â· **Risk:** GREEN (additive-safe consolidation)
`src/analytics/engine.ts:144-183` (`criticalDates`, lease-only, includes notice-deadline rows; feeds Leases + brief) vs `src/brain/critical-dates.ts:39-95` (`portfolioCriticalDates`, leases+loans+insurance, NO notice-deadline logic; feeds Calendar). Both re-derive lease-expiry via the duplicated inline `daysBetween`. The Calendar view silently lacks the notice-deadline rows the Leases view shows, and a future horizon/notice-window change diverges them.
**Fix:** consolidate into one `portfolioCriticalDates` (or extend the AnalyticsBundle's `criticalDates` with loans + insurance); have the brief draw from the same stream.

### M14 Â· `AcquisitionsModule` lacks an answer-first verdict; "Best Active Cap" computed over ALL deals â€” `acquisitions-module-no-verdict`
**Goal:** acquisition velocity Â· **Risk:** GREEN (additive; one cross-section bug)
`src/modules/acquisitions/AcquisitionsModule.tsx:24-82`. `bestCap = Math.max(0, ...deals.map(...))` (line 31) maps over the full `deals` list while the adjacent `pipelineSf` correctly uses `active` â€” so the "Best **Active** Cap" KPI can reflect a Closed/Dead deal. The primary acquisition surface also presents cap/EM/price with no per-field provenance (no `prov` on any KpiStat), though it carries a coarse module-level "seed pipeline / sync pending" disclaimer.
**Fix:** compute `bestCap` over `active`; add per-field provenance to the Deal contract (or mark financial columns as unverified estimates until the Notion/HubSpot sync lands).

### M15 Â· Alert/chart theming hardcodes hex and references undefined CSS variables â€” `alert-module-hardcoded-hex`
**Goal:** institutional quality (brand) Â· **Risk:** GREEN (additive-safe)
`src/modules/alerts/AlertsModule.tsx:7-11` hardcodes three severity hex values that differ from the real tokens (`#e05c5c` vs `--color-neg #e0564f`, etc.; `InsightList.tsx:8-10` uses the token form). `AlertBell.tsx:21` uses `var(--danger, #e05c5c)` where `--danger` is undefined (always falls to hex) plus `color:'#fff'`. `charts/theme.ts:7` (`var(--gold-300, â€¦)`) and `widgets.tsx:37` (`var(--gold-400, â€¦)`) reference non-existent tokens (real ones are `--color-gold-300/400`), permanently locking the 5th chart series and the Equity-Invested KPI accent to fallbacks â€” visibly wrong in the parchment (light) theme.
**Fix:** reference `var(--color-neg/warn/info)`, `var(--color-gold-300/400)`, `var(--text-on-accent)` throughout.

---

## LOW (9)

### L1 Â· `api-contracts.md` lock file documents five routes that don't exist â€” `api-contracts-doc-drift`
**Goal:** knowledge capture Â· **Risk:** GREEN
`architecture/api-contracts.md:136,139,143-144,146` lists `noi-matrix`, `analytics/since-acquisition`, `analytics/rankings`, `analytics/pm-scorecards`, and `data-quality`. The actual router (`api.ts`) registers `/noi`, folds since-acquisition into `/analytics/growth` and rankings into `/analytics/benchmarks`, `/analytics/pm`, and has NO data-quality handler. The "lock file" drifted because `governance-check.ts` enforces only file-existence/staleness/duplicate-route, not documented-path-vs-router reconciliation.
**Fix:** reconcile the doc to the router; tighten `governance-check.ts` to diff documented exact paths against registered Hono routes.

### L2 Â· `database-schema.md` classification enum drift + missing migration 002 â€” `schema-doc-classification-enum-drift`
**Goal:** knowledge capture Â· **Risk:** GREEN
`architecture/database-schema.md:117` lists `'below-line'`/`'unknown'` (neither in the enum) and omits `capex/ti/leasing/debt-service/excluded` â€” the real 9-value `Classification` (`src/contracts/warehouse.ts:4-7`) that `metrics.ts`/`classificationSide` branch on. The Migration History table (lines 14-17) lists only `001_initial.sql`; `002_parser_version.sql` exists on disk.
**Fix:** update the classification bullet to the real enum and add the `002` row.

### L3 Â· `resolveMapping` calls `db.prepare()` per ledger row â€” `resolveMapping-prepare-per-account-row`
**Goal:** acquisition velocity (backfill) Â· **Risk:** GREEN
`server/warehouse/mapping.ts:73-81`. `db.prepare(...)` runs per invocation inside the ingest `for (const a of stmt.accounts)` loop â€” 320â€“960 calls across a 32-file backfill. better-sqlite3 caches statements internally, so the cost is only a cache lookup per call on a one-time backfill (hence low).
**Fix:** hoist the prepared statement outside `resolveMapping` (module-level or caller-held).

### L4 Â· `clamp`/`round1`/pct helpers re-defined across warehouse modules â€” `clamp-round1-pct-warehouse-helpers-duplicated`
**Goal:** knowledge capture Â· **Risk:** GREEN
`server/warehouse/scores.ts:30` + `acquisition.ts:35-36` + `anomalies.ts:43`. `clamp` is private-duplicated in scores/acquisition; `round1` is exported in acquisition but scores inlines the identical `Math.round(v*10)/10` (lines 257/297); two pct formatters (`pct` not null-safe, `pctStr` null-safe). A rounding-convention change must be found in 3+ spots.
**Fix:** extract to `server/warehouse/math.ts` and import.

### L5 Â· Absolute $10k tolerance band can mask a ~100%-relative NOI disagreement â€” `recon-abs-band-hides-warehouse-zero`
**Goal:** ops optimization / institutional quality Â· **Risk:** YELLOW (financial mechanism)
`server/warehouse/reconcile-noi.ts:161-166`. The OR between pctBand (0.05) and absBandUsd ($10k) lets the absolute band alone pass a row. Worked case: workbook $9,000 NOI, warehouse $0 â€” `wh=0` is not null so the missing-from-warehouse branch (line 113) doesn't fire; `signsConflict` is false; `absDelta=$9,000 â‰¤ $10,000` â†’ in-tolerance/info despite 100% relative disagreement. A zeroed-out small property is hidden at the lowest triage level. Low because most ORA properties carry NOI â‰« $10k.
**Fix:** gate the absolute-band pass on a relative ceiling too, OR treat `warehouseOxfordNoi===0` vs non-zero workbook as missing-from-warehouse.

### L6 Â· Restale-abort returns `status:'committed'` after rollback â€” `restale-abort-reports-committed`
**Goal:** ops optimization / knowledge capture Â· **Risk:** GREEN
`server/warehouse/ingest.ts:194-208`. On `RestaleAbort` the transaction rolled back (nothing recommitted, parser_version stays stale), yet the function returns `status:'committed'`. The `IngestResult.status` union already includes `'skipped'`, but `scripts/warehouse-verify.ts:99` tallies this as a fresh commit, masking that a parser-fix derivation was rejected and served data is still old.
**Fix:** return a distinct `'restale-skipped'`/`'skipped'` status and surface it separately in backfill/verify tallies.

### L7 Â· Q3 `confirmedComposite` double-round risks a 0.1pt PURSUEâ†’WATCH boundary flip â€” `acq-confirmed-composite-double-round`
**Goal:** acquisition velocity / governor discipline Â· **Risk:** YELLOW (financial mechanism)
`server/warehouse/acquisition.ts:310-346`. `estimatedAdjPts = round1(cat4 - cat4NoEstimated)` is subtracted from a `composite` built from already-rounded sub-scores (market = `round1(clamp(cat4))`), so `confirmedComposite` subtracts a quantity not identical to the estimated contribution baked into the rounded market sub-score. At the exact `t1PursueMin` (75) boundary a 0.1pt skew can flip whether the cap engages. Ruleset is advisory/un-ratified, so no live capital rides on it today â€” but the mechanism ships with ratification.
**Fix:** difference the rounded market sub-scores (`round1(cat4) âˆ’ round1(cat4NoEstimated)`) so both sides share one rounding regime.

### L8 Â· `criticalDates`/`scores` minor redundancies & dead code (3 grouped) â€” `scores-redundant-property-master-query`, `recon-signflip-dead-warn-note`, `intel-config-mirrors-comment-misleading`
**Goal:** knowledge capture / ops Â· **Risk:** GREEN
(a) `scores.ts:89-91` issues a redundant `SELECT id,name FROM property_master` that the ledger JOIN in `propertyPeriodMetrics` already supplies (`metrics.ts:94`); the `?? levelRow.propertyName` fallback confirms it adds nothing. (b) `reconcile-noi.ts:167-178` carries an unreachable sign-inversion note in the `drift` branch â€” inversions always have `deltaPct â‰¥ 1.0 > 0.20`, so they never land in the warn-level drift branch. (c) `intel-config.ts:3` claims to "mirror" `conditions.ts ALERT_THRESHOLDS` but the two stores share zero keys and no import â€” a stale comment a future editor might "sync."
**Fix:** drop the redundant query (use `levelRow.propertyName`); remove the dead `signNote` (or add an explicit `signsConflict â†’ large-drift` branch); delete/correct the "Mirrors" comment.

### L9 Â· UI/theming & confidentiality-hygiene minor items (3 grouped) â€” `latestfullyear-derivation-in-ui-component`, `button-primary-border-hardcoded-black`, `brief-state-snapshots-confidential-deal-ids-locally`, `cash-module-no-verdict`
**Goal:** institutional quality / knowledge capture Â· **Risk:** mixed (one YELLOW-confidential, rest GREEN)
(a) `OwnershipView.tsx:928-936` â€” pure `latestFullYear` period-selection logic (a load-bearing financial-period choice) lives inline in the 936-line UI component, against `coding-standards.md:33`; un-exported and untestable. (b) `Button.tsx:50` mixes `#000` into the primary CTA border (over-saturated on the parchment light theme). (c) `server/brief/run.ts:79` persists slug-derived confidential deal ids to the gitignored, non-mirrored `data/alert-state.json` during the confidential-included bake â€” local-only, no external surface, but a hygiene gap (YELLOW). (d) `CashModule.tsx:43-63` shows top-concentration % but no in-context verdict Card when concentration exceeds `ALERT_THRESHOLDS.cashConcentrationWarn` (0.30).
**Fix:** move `latestFullYear` to `ownership-intel.ts` as a tested export; use `color-mix(... transparent)` for the button border; hash/omit confidential ids in `AlertState` (or document the file as internal-only); add a conditional concentration Card to CashModule.

---

## AUDIT COVERAGE NOTES (gaps in the audit itself)
- **Read-only / no execution:** nothing was run (WAL-lock + read-only mandate). All numeric refutations are hand-traced from source plus the repo's own test fixtures; no warehouse, build, or typecheck was executed, so type-mismatch claims are by declaration inspection, not compiler output.
- **Unverifiable data semantics:** could NOT confirm from source whether workbook `Property.noi` (col 13) is truly Oxford-share vs 100%-basis. `reconcile-noi.ts` and `property.ts` both ASSERT Oxford-share, and the whole Aâ†”B tie-out depends on it; a 100%-basis value on a 50%-owned property would manufacture a 50% phantom drift. Flagged, not filed (not provable from code).
- **Not deep-read:** every `*Module.tsx` render path (data/logic layers prioritized); the SQLite migration DDL at runtime; `server/workbook/parse.ts` (539 lines, scanned via cross-reference); `src/brain/AiPanel` streaming/render path; `parse/qb-excel.ts` ExcelJS loop (CLI-only); the Cloudflare `functions/` mirror layer beyond ai+whoami; charts/primitives/shell internal duplication; `tests/e2e/*`; the 16 lower-density modules (renewals/tenants/relationships/tasks/documents/insurance/calendar) for analytics density.
- **Confirmed NOT-bugs (analyzed and cleared):** ingest RestaleAbort post-rollback DQ insert (deduped, safe); `resolveMapping` side-filter precedence (correct on the ingest path); SSE bounded-reconnect; renewals unbounded overdue window (documented-intentional holdover); `selectCoherentBatch` total-order (transitive); bake `redactConfidential` scrubs deals AND counterpartyâ†’deal links and runs before overlay so overlay-only fields can't leak to the static mirror; `deploy-mirror.ps1` Access-gate re-verify; CORS locked to localhost; no tracked secrets (only doc/test placeholders); reconcile sign-inversion is dead-code not a mislabel.
- **Confidentiality discipline:** no verbatim active-confidential-deal term appears in this report; the deal identifier in H1 is referenced only by location, not quoted.
