# Lease Market Intelligence — Design (rev 2)

- **Status:** Design approved by Gabriel 2026-09-16 (monthly CoStar export cadence; row-level mirror). Rev 2 folds in the Fable 5.1 pre-mortem (§9 adjudication log).
- **Lane:** L3 `/build` (overlaps L6 `market-monitor` / `acquisition-underwriting`; extends, never duplicates).
- **Surfaces:** `oxford-command-center` (engine + dashboard) · `ora-skills` (one skill, P3) · CC/MCP fleet (two tasks, P3).
- **Models:** design Opus 5 · pre-mortem Fable 5.1 · implementation Sonnet 5 (Gabriel's instruction) · task review Opus 5 · mandatory Fable REFUTE on normalization / benchmark / signal / feed modules before merge.

## 1. Goals

| # | Goal | Success test |
|---|---|---|
| G1 | Track for-lease listings matching ORA's portfolio submarkets and buy-box across all target markets | Every in-scope row of a complete CoStar export is ingested, deduplicated, and visible after one ingest run |
| G2 | Historical, current, and new-listing lease rates with charts on real data | Dashboard shows sourced quarterly history, current distribution, and new-vs-active medians per market; every point traces to a source row |
| G3 | Keep ORA's own listings within market | Each vacant ORA suite shows percentile + gap % vs. its cell with n and coverage; ±10% band flagged |
| G4 | Surface acquisition targets from stale / below-market listings | Candidate list where each row carries the evidence to decide in < 2 min |

**Non-goals:** maps (`submarket-spatial-analysis`) · automated promotion into Deal Sourcing Log or outreach · sale listings (`deal-flow-triage`) · any automated access to CoStar Suite or LoopNet pages.

## 2. Data sources (trust-ordered)

| Tier | Source | Mechanism | Cadence | Enters benchmarks? | Can mark removed? |
|---|---|---|---|---|---|
| T1 | CoStar Suite lease-listing export, one saved search per market, **space-level** rows | Human export → `OneDrive…/Claude_Workspace/lease-market-intake/costar/` | Monthly | Yes (NNN / derivable only) | Yes (complete exports only, §3.4) |
| T1 | CoStar Analytics asking-rent history · Lease Comps | Human export, same folder | One-time backfill, then quarterly | History series · signed-rent series | n/a |
| T2 | Alert emails (CoStar, LoopNet, Crexi, brokers) | Weekday task, M365 read-only by sender, LLM → JSON schema → validator; dedup by Message-ID; catch-up window capped 14 days | Weekdays (P3) | **No** | **No** — expire 60 days unless confirmed by an export |
| T3 | Broker quarterly reports | `market-monitor` quarterly pass writes `market_series` points | Quarterly (P2) | History overlay only | n/a |
| T4 | ORA rent roll (Vacant rows) + warehouse opex + LoopNet Silver activity | Warehouse join; Silver export to `lease-market-intake/loopnet-silver/` | Monthly (Silver P3) | No (ORA is the subject, not the comp set) | n/a |
| T5 | Web sweep | Weekly research pass, URL-cited | Weekly (P4) | **No** | **No** — same 60-day expiry as T2 |

CoStar/LoopNet terms prohibit robots/scrapers: data enters only via human exports or their own alert emails. DOM derives from CoStar `date on market` (with the reset guard in §3.5), so monthly cadence keeps DOM accurate; rent-cut detection lags ≤ 1 month.

## 3. Engine

### 3.1 Pipeline

```
intake → lm_landing (sha256 / Message-ID dedup, immutable file copy)
  → parse [CoStar: header-map config, deterministic; email/web: LLM JSON → zod validator]
  → canonical row (CanonicalListingRow — the only shape downstream code sees)
  → normalize (address, suite, subtype, size band, rent range/period/basis → NNN-eq)
  → resolve identity (CoStar property ID + suite ▸ address_norm + suite_norm)
  → lm_listing + lm_observation
  → export completeness → removal state machine
  → benchmarks (cells, coverage, n-gated rollup) → signals → surfaces
```

The CoStar header map (`config/lease-market.costar-headers.json`) is the ONLY component that depends on real CoStar column labels. It is filled from Gabriel-supplied sample exports; all other code and tests run on `CanonicalListingRow` fixtures.

### 3.2 Storage — additive migrations (next free number at write time; 029+ on this branch)

- `lm_landing(id, source[costar_listings|costar_history|costar_lease_comps|alert_email|web|silver], source_ref, sha256, market, received_at, file_path, row_count, header_fingerprint, completeness[complete|partial|n/a], parse_status[ok|failed], parse_error)` — UNIQUE(sha256), UNIQUE(source, source_ref) where source_ref = Message-ID or file name
- `lm_listing(id, costar_property_id, address_norm, suite_norm, address_display, city, state, market, submarket, subtype[warehouse|flex], building_status[existing|proposed|under_construction|unknown], building_sf, year_built, clear_height_ft, docks, drive_ins, office_pct, owner_name, owner_type[institutional|affiliated|private|unknown], is_ora_owned, ora_property_key, first_seen, last_seen, costar_date_on_market, status[active|missing_once|removed|expired], removed_at, origin_tier)` — UNIQUE(address_norm, suite_norm)
- `lm_observation(id, listing_id, landing_id, observed_at, available_sf, min_divisible_sf, rent_low, rent_high, rent_period[yr|mo], rent_basis[NNN|MG|IG|GROSS|FSG|UNKNOWN|WITHHELD], is_sublease, asking_nnn_eq, opex_est_psf, opex_source, costar_dom, confidence[high|low])` — UNIQUE(listing_id, landing_id)
- `lm_signal(id, listing_id, ora_property_key, kind, severity, computed_at, evidence_json, cell_key, dismissed_at)`
- `lm_market_rent_feed(ora_property_key PK, asking_nnn_eq, cell_key, n, quoted_share, computed_at)`
- `lm_ora_listing_activity(ora_property_key, suite_norm, period_month, views, leads, source)` — P3
- **History reuses `market_series`** (migration 013/017): `cluster` = config market id, `metric` ∈ {`asking_nnn_psf`, `signed_nnn_psf`, `vacancy_pct`}, `source` ∈ {`costar-analytics`, `costar-lease-comps`, `broker-<firm>`, `ora-warehouse`}, subtype/submarket in `source_detail`.

### 3.3 Normalization

- **Range:** `rent_low/rent_high`; use midpoint only if (high − low)/low ≤ 20%, else basis → UNKNOWN for benchmark purposes.
- **Period:** explicit `/mo` ⇒ ×12. No explicit period and value < 3.00 with a basis present ⇒ treat as monthly ×12 and set confidence low; otherwise yearly.
- **Basis → NNN-eq:** NNN ⇒ as-is, confidence high. GROSS/FSG ⇒ asking − opex_est (tax+ins+CAM), confidence low. MG/IG ⇒ asking − Σ(components listed in config `mgLandlordPays[market]`, default `['tax','ins']`), confidence low. opex_est resolution: ORA warehouse actual $/SF same market ▸ config `opexDefaults[market][subtype]` ▸ null (⇒ `asking_nnn_eq` null).
- **Benchmark eligibility:** confidence high (NNN) · not sublease · not UNKNOWN/WITHHELD · origin tier T1 · building_status existing. Low-confidence rows render in charts as hollow markers but never enter P25/median or `below_market`.
- **Subtype:** CoStar type/secondary type → {warehouse, flex} via header-map config; unmapped ⇒ hard fail naming the value. Flex cells split by `office_pct ≥ 40` when office_pct present.
- **Size band** on available SF (min_divisible when a row is property-level): `<5K · 5–15K · 15–30K · 30–50K · 50–80K`.
- **Scope config** (`config/lease-market.json`): markets (id, CoStar market name, tier established|entry), building SF ≤ 80K benchmark universe, ≤ 50K candidate eligibility, thresholds (§3.6), `exportRowCap`, `mgLandlordPays`, `opexDefaults`, `mirrorRowLevel`, and **per ORA property** `{propertyKey, market, submarket, subtype, buildingSf, clearHeightFt, leaseBasis[NNN|MG|GROSS|UNKNOWN]}` — ORA's `Property.market` enum is too coarse to cell-key, so positioning is null for a property missing here.
- **Identity:** address normalization (USPS suffix + directional abbreviations, unit designators split into suite); CoStar property ID + suite wins when present.

### 3.4 Export completeness and removal

A CoStar listing export for market M is **complete** iff: header fingerprint equals M's last complete export (or it is the first) · row_count < `exportRowCap` · row_count ≥ 0.7 × last complete row_count. Otherwise **partial**: ingest observations, no state transitions to missing/removed, freshness banner amber with the reason.

State machine per T1 listing on each complete export of its market: present ⇒ `active`; absent once ⇒ `missing_once`; absent on the next complete export ⇒ `removed` (outcome unknown — never "leased"). T2/T5 listings: `expired` after 60 days without export confirmation. A header-fingerprint change hard-fails the ingest with the diff (fix = header-map update, then re-ingest).

### 3.5 Benchmarks

- **Cell:** `market × submarket × subtype × size_band` (+ office stratum for flex).
- **Stats:** median, P25, P75, `n` (eligible rows), `total_n` (all active rows in cell), `quoted_share = n/total_n`.
- **Rollup order** until n ≥ 5: widen size band one step (both sides) ▸ drop submarket (market level) ▸ null. Every figure displays the final cell key, n, and quoted share.
- **Low coverage:** quoted_share < 0.5 ⇒ `LOW-COVERAGE` tag; ORA percentile phrased "among quoted (n of total_n)".
- **DOM:** `effective_dom = max(costar_dom, today − first_seen)`, matched on address_norm+suite_norm across CoStar IDs; a CoStar DOM decrease vs. prior observation sets `dom_reset` and keeps the older clock.
- **Completed-DOM baseline:** median effective_dom at removal of listings removed in trailing 12 months, per market, n ≥ 10; else fixed fallback (established 180, entry 270).

### 3.6 Signals (thresholds in config)

| Kind | Rule |
|---|---|
| `new_listing` | first sighting in the latest complete export (or T2/T5 first sighting in P3+), in scope |
| `stale` | effective_dom ≥ max(180, 1.5 × completed-DOM baseline); building_status existing |
| `rent_cut` | asking_nnn_eq or rent_low decreased vs. prior observation of the same listing |
| `below_market` | eligible row · cell n ≥ 10 · cell not market-level rollup · not LOW-COVERAGE · asking_nnn_eq ≤ P25 **and** ≤ 0.85 × median. Evidence includes clear height, year built, loading vs. cell medians |
| `ora_positioning` | per ORA Vacant rent-roll unit whose property is in config: ORA asking from its matched CoStar listing (is_ora_owned) ▸ null. Percentile + gap %; `above` > +10%, `below` < −10%; carries effective_dom and (P3) Silver views/leads |
| `acq_candidate` | ≥ 2 of {stale, rent_cut, vacancy_share ≥ 30%, below_market} · building_sf ≤ 50K · building_status existing · not sublease · owner_type ≠ institutional · owner not on never-call floor · not ORA-owned. Evidence: vacancy share, `owner_listing_count` (same owner across current exports), building status, DOM source + dom_reset, cell n + coverage. Affiliated owners flagged, not dropped |

Owner screening reads, never writes: `county-parcel-screen/scripts/institutional_owners.py` alias table (ported to a JSON export consumed by TS) and `data/pipeline-guard.local.json` never-call floor (absent file ⇒ candidate list withheld with a banner, fail-closed). Promotion to `verified-deal-recon` / `owner-outreach` is Gabriel's manual action.

### 3.7 Market-rent feed (replaces writing into the overlay)

`lm_market_rent_feed` holds, per ORA propertyKey whose config `leaseBasis = NNN`, the cell median NNN-eq with n and quoted share. `lease-forecast-api.ts` merges `{...feed, ...overlay.marketRents}` at read time — manual overlay values win by construction, the feed never touches `overlay.json`. `MarketRentGap.provenance` gains `'derived-asking'` for feed-sourced values. Properties with MG/GROSS/UNKNOWN basis get no feed value (gap stays `absent`). UI labels feed values "asking".

## 4. Dashboard — "Lease Market" module (group Market, id `lease-market`)

1. **Freshness banner** — last complete export per market; amber if partial or > 35 days; benchmarks behind it tagged STALE.
2. **Current distribution** — per-market strip plot of asking NNN-eq (eligible solid, low-confidence hollow), P25/median/P75 ticks, ORA listings highlighted.
3. **ORA positioning table** — unit, SF, ORA asking, cell median, percentile, gap %, DOM, cell key · n · coverage.
4. **Signals table** — kind/market/severity filters, evidence drawer, dismiss (internal).
5. **DOM histogram** per market (P1) · **Rent history** line (P2) · **New vs. active** medians (P2).

New chart primitives (visx, `src/charts/theme.ts` tokens): `StripPlot`, `Histogram`, `MultiLineChart`. Mirror: routes added explicitly to `scripts/bake-warehouse.ts`; `mirrorRowLevel` (default **true** per Gabriel's approved design) — false bakes aggregates only.

## 5. Automation (P3; registered only via `register-scheduled-task`, CC/MCP fleet)

- `ora-lease-listings-intake` — weekdays: ingest new files in the intake folders; read alert emails by sender (read-only), extract, validate, ingest. Nonzero exit on failure.
- `ora-lease-market-digest` — Mondays: recompute; send digest to `ggoldberg@oxfordra.net` only via `_shared/send-via-outlook.ps1` **only if** a new landing exists since the last digest. On the first business day of each month, and again at day 35 for any market still unexported, send an internal export-reminder email naming the markets.

## 6. Skill — `lease-market-monitor` (ora-skills, P3)

Intake setup (CoStar saved-search spec per market, required export columns, alert senders), signal interpretation, hand-offs (`verified-deal-recon`, `owner-outreach`, `acquisition-underwriting` COMPS mode reads cell benchmarks first), CoStar data-handling rule. Tie-break: market-level narrative stays in `market-monitor`; listing-level tracking lives here.

## 7. Error handling

One transaction per landing (no partial inserts) · unknown header / unmapped subtype ⇒ hard fail naming the value · schema-failing LLM rows rejected and listed in the run log · duplicate sha256 or Message-ID ⇒ no-op · cell null after full rollup ⇒ benchmark null + reason, signals suppressed · missing never-call floor ⇒ candidates withheld · scripts exit nonzero on failure.

## 8. Testing and phasing

Unit tests per normalization rule, stats, rollup, completeness, removal state machine, DOM reset, each signal at its threshold boundaries, feed merge precedence. Integration: temp warehouse, two sequential monthly exports ⇒ DOM, rent cut, missing_once → removed, partial-export no-op, signals, feed. Fixtures: canonical rows; CoStar header-map fixtures only from real sample headers.

| Phase | Scope |
|---|---|
| **P1** | Migrations · config · canonical row + normalization · CoStar listings parser (header map pending samples) · identity · completeness/removal · benchmarks · signals (new, stale, rent_cut, below_market, ora_positioning, acq_candidate) · feed + lease-forecast merge · API · module (banner, distribution, positioning, signals, DOM) · mirror routes |
| **P2** | CoStar Analytics + Lease Comps ingest into `market_series` · broker points from `market-monitor` · ORA signed rents · history + new-vs-active charts |
| **P3** | Alert-email intake · two scheduled tasks · digest + export reminders · Silver activity · `lease-market-monitor` skill |
| **P4** | Web sweep (T5, non-benchmark, 60-day expiry) |

## 9. Pre-mortem adjudication log (Fable 5.1, 2026-09-16)

Accepted: F1 lease-basis gating of the feed · F2 feed table + read-time merge instead of overlay writes · F3 MG/IG excluded from benchmarks · F4 coverage/quoted share · F5 completeness + two-strike removal + header fingerprint · F6 completed-DOM baseline · F7 DOM reset guard · F8 ranges/period/sublease/min-divisible · F9 ≥2-of candidate rule + building status + owner listing count · F10 size-band-first rollup, below_market n ≥ 10, no market-level firing · F11 T2/T5 never benchmark, 60-day expiry, Message-ID dedup · F13 reuse `market_series` · F14 per-ORA-property config.
Modified: F12 — reminder via internal email (pre-authorized routing) rather than Outlook task objects.
Rejected: F15 default `mirrorRowLevel=false` — Gabriel explicitly chose row-level; flag retained, flip is config-only. Cut of web sweep — Gabriel explicitly requested it; kept as P4 with non-benchmark / no-removal constraints.
Cuts accepted: `light_mfg` subtype · 7-day new-listing rule · `lm_rent_series` · unconditional weekly digest.

## 10. Risks

| Risk | Mitigation |
|---|---|
| CoStar column labels unknown | Header map is the sole dependency; filled from Gabriel's sample exports; hard-fail on drift |
| CoStar per-seat license vs. mirror viewers | [SPECULATIVE] Gabriel's call; `mirrorRowLevel` flip is config-only |
| Multi-writer repo | Worktree `feat/lease-market-intel`; claim `lease-market-intel`; `architecture/status.json` entry with review_needed listing architect-owned files (migrations, `src/contracts/lease-market.ts` + `lease-forecast.ts` provenance enum, `package.json` scripts); sub-router registration via `sub-routers.ts`, not `server/index.ts` |
| Asking ≠ achieved | "asking" labels; signed rents plotted separately (P2) |
