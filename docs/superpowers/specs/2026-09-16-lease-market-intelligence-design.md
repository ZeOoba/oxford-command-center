# Lease Market Intelligence — Design

- **Status:** Approved by Gabriel 2026-09-16 (design + monthly CoStar export cadence). Pre-mortem pending.
- **Lane:** L3 `/build` (overlaps L6 `market-monitor` / `acquisition-underwriting`; extends, never duplicates).
- **Owner surface:** `oxford-command-center` (engine + dashboard), `ora-skills` (one skill), CC/MCP fleet (two tasks).
- **Design model:** Opus 5 · **Pre-mortem:** Fable 5.1 · **Implementation:** Sonnet 5 (Gabriel's in-turn instruction) with Opus 5 review and a mandatory Fable REFUTE pass on normalization / benchmark / signal modules.

## 1. Goals

| # | Goal | Success test |
|---|---|---|
| G1 | Track for-lease listings matching ORA's portfolio submarkets and acquisition buy-box across all target markets | Every CoStar-exported listing in scope is ingested, deduplicated, and visible within one intake run |
| G2 | Historical, current, and new-listing lease rates with charts on real data | Dashboard shows a sourced quarterly history series, current asking-rent distribution, and new-listing medians per market — every point traceable to a source row |
| G3 | Keep ORA's own listings within market | Each vacant/listed ORA suite shows percentile + gap % vs. its comparable cell; ±10% band flagged |
| G4 | Surface acquisition targets from stale or materially below-market listings | Weekly signal list of candidates with the evidence (DOM, rent cuts, vacancy share, NNN-eq gap, physicals, owner) needed to decide in <2 min each |

**Non-goals (YAGNI):** maps/spatial views (`submarket-spatial-analysis` owns that) · automated outreach or promotion into the Deal Sourcing Log (Gabriel promotes manually) · sale listings (deal-flow-triage owns on-market sale flow) · any automated access to CoStar Suite or LoopNet listing pages.

## 2. Data sources (trust-ordered)

| Tier | Source | Content | Mechanism | Cadence |
|---|---|---|---|---|
| T1 | CoStar Suite **lease listings export** (one saved search per market, buy-box filters) | Full census of active availabilities: asking rent + rent basis, available SF, building SF, clear height, year built, loading, date on market, true owner, leasing broker, CoStar property ID | Human export → OneDrive intake folder `…/Claude_Workspace/lease-market-intake/costar/` | **Monthly** (ratified 2026-09-16) |
| T1 | CoStar **Analytics** asking-rent history + **Lease Comps** | Quarterly asking rent by market × subtype (10+ yrs); signed rents | Human export, same intake folder | One-time backfill, then quarterly |
| T2 | Alert emails: CoStar saved-search alerts, LoopNet, Crexi, broker blasts | New listings between exports (additions only) | Daily task reads by sender via M365 MCP; LLM extracts to JSON schema | Weekdays |
| T3 | Broker quarterly reports (Colliers/CBRE/C&W/Lee) | Market-level asking rent, vacancy — cross-check | `market-monitor` quarterly pass writes points to the store | Quarterly |
| T4 | ORA warehouse + LoopNet Silver analytics | ORA achieved rents, vacant suites; views/leads per ORA listing | Warehouse join; Silver report export to intake folder | Monthly |
| T5 | Web sweep | Crexi-only / small-landlord listings CoStar misses | Weekly research pass, URL-cited | Weekly (P4) |

**Constraints.** CoStar/LoopNet data enters only through human-run exports or their own alert emails — CoStar/LoopNet terms prohibit robots/scrapers. Data stays internal (warehouse + access-gated mirror). A monthly export means rent-cut detection lags ≤ 1 month; DOM stays accurate because it derives from CoStar's `date on market`, not from ORA's first sighting.

## 3. Architecture

```
intake (CoStar files · alert emails · broker points · web) 
  → raw_landing (immutable, sha256, source tag, received_at)
  → parse  [CoStar: header-map config, deterministic | email/web: LLM → JSON schema → validator]
  → normalize (address, suite, subtype, size band, rent basis → NNN-equivalent)
  → resolve identity (CoStar property ID ▸ normalized address+suite) 
  → listing (entity) + listing_observation (time series per sighting)
  → benchmarks (per cell, robust stats, n-gated rollup)
  → signals (new · stale · below-market · rent-cut · ORA positioning)
  → surfaces: Lease Market module · weekly digest · marketRents feed · skill reads (COMPS mode)
```

### 3.1 Storage (new warehouse migrations, additive only)

- `lm_raw_landing(id, source, source_ref, sha256 UNIQUE, received_at, payload_path, parse_status, parse_error)`
- `lm_listing(id, costar_property_id NULL, address_norm, suite_norm, city, state, market, submarket, subtype, building_sf, year_built, clear_height_ft, docks, drive_ins, owner_name, owner_type, is_ora_owned, ora_property_key NULL, first_seen, last_seen, date_on_market, status[active|removed], removed_at)` — UNIQUE(costar_property_id, suite_norm) and UNIQUE(address_norm, suite_norm)
- `lm_observation(id, listing_id, landing_id, observed_at, available_sf, asking_rent_raw, rent_basis[NNN|MG|IG|FSG|GROSS|UNKNOWN|WITHHELD], rent_period, asking_nnn_eq NULL, opex_est_psf NULL, opex_source, source_tier, confidence)`
- `lm_rent_series(id, market, submarket NULL, subtype, period_quarter, metric[asking_nnn|signed_nnn|vacancy_pct], value, source, source_ref, confidence)` — UNIQUE(market, submarket, subtype, period_quarter, metric, source)
- `lm_opex_default(market, subtype, opex_psf, source, as_of)`
- `lm_signal(id, listing_id NULL, ora_property_key NULL, kind, severity, computed_at, evidence_json, cell_key, dismissed_at NULL)`
- `lm_ora_listing_activity(ora_property_key, suite_norm, period_month, views, leads, source)`

### 3.2 Normalization rules

- **Rent basis → NNN-equivalent:** NNN = as-is. GROSS/FSG = asking − opex_est. MG/IG = asking − (taxes + insurance share of opex_est). opex_est resolution order: ORA warehouse actual $/SF for same market (taxes + insurance + CAM) ▸ `lm_opex_default` ▸ null. Null opex ⇒ `asking_nnn_eq` null ⇒ excluded from benchmarks. Monthly rents ×12. UNKNOWN/WITHHELD ⇒ excluded from benchmarks, counted in coverage.
- **Cells:** `market × submarket × subtype{warehouse, flex, light_mfg} × size_band{<5K, 5–15K, 15–30K, 30–50K, 50–80K}` on available SF.
- **Stats:** median, P25, P75, n. **n ≥ 5** required; else roll up submarket → market, then widen size band one step; the rolled cell key and n are shown on every derived figure. Never means.
- **Scope config** (`config/lease-market.json`, not hard-coded): markets and CoStar market names; building SF ≤ 80K for benchmark universe (deliberately wider than the buy-box, same reasoning as `county-sales-monitor`); building SF ≤ 50K for acquisition-candidate eligibility; all ORA-owned property submarkets auto-included.
- **Identity:** address normalization (USPS suffix/directional abbreviations, unit designators split to suite) — CoStar property ID wins when present on both sides.
- **Removal:** a listing absent from a *complete* CoStar market export is marked `removed` (only full exports mark removals — alert emails and web rows never do).

### 3.3 Signals (thresholds in config)

| Kind | Rule | Notes |
|---|---|---|
| `new_listing` | first sighting within last 7 days, in scope | digest only |
| `stale` | DOM ≥ max(180, 1.5 × cell median DOM) | severity up if ≥1 rent cut or available_sf ≥ 30% of building_sf |
| `below_market` | asking_nnn_eq ≤ cell P25 **and** ≤ 0.85 × cell median, n ≥ 5 | evidence shows clear height, year built, loading vs. cell medians so inferior-space false positives are visible |
| `rent_cut` | asking_nnn_eq decreased vs. prior observation of same listing | |
| `ora_positioning` | per ORA vacant/listed suite: percentile + gap %; `above` if gap > +10%, `below` if < −10% | joined with DOM and LoopNet Silver views/leads |
| `acq_candidate` | `stale` or `below_market` **and** building_sf ≤ 50K **and** owner not institutional **and** owner not on never-call floor **and** not ORA-owned | owner screening reuses `county-parcel-screen`'s `institutional_owners.py` alias table and `data/pipeline-guard.local.json` never-call floor (read-only). ORA-affiliated owners are FLAGGED, not dropped |

Signals are internal analytics. Promotion to `verified-deal-recon` or the `owner-outreach` queue is Gabriel's manual action; outreach remains draft-only under `outreach-ratification.json`.

### 3.4 marketRents feed

A benchmark job writes the cell median NNN-eq for each ORA property's cell into the existing `marketRents` overlay keyed by `propertyKey` — **only** where no manual value exists (manual overrides win; the source of each value is recorded). This populates `marketRentGaps` in lease-forecast without changing its contract. Values carry `asking` semantics (asking rents overstate achieved); labeled as such in the UI.

### 3.5 Dashboard — "Lease Market" module

1. **Rent history** — line per market (CoStar quarterly asking NNN), broker-report points overlaid, ORA signed rents as scatter.
2. **Current distribution** — per-market strip/box of active asking NNN-eq; ORA listings highlighted.
3. **New vs. active** — monthly median NNN-eq of new listings vs. all active (leading indicator).
4. **DOM** — histogram per market + stale table.
5. **ORA positioning** — suite table: asking, cell median, percentile, gap %, DOM, views/leads, cell key + n.
6. **Signals** — filterable table (kind, market, severity), dismiss action (internal).
7. **Freshness banner** — last CoStar export per market; stale if > 35 days (monthly cadence + 5-day grace). Benchmarks older than the banner threshold render with a STALE tag, never as current.

### 3.6 Automation (CC/MCP fleet, registered only via `register-scheduled-task`)

- `ora-lease-listings-intake` — weekdays: scan intake folder for new CoStar/Silver files → ingest; read alert emails by sender (M365 MCP, read-only) → LLM extract → validated JSON → ingest. Never replies, never clicks links.
- `ora-lease-market-weekly` — Mondays: recompute benchmarks + signals, refresh marketRents feed, email digest to `ggoldberg@oxfordra.net` only via `_shared/send-via-outlook.ps1`; digest leads with export-freshness warnings.

### 3.7 Skill — `lease-market-monitor` (ora-skills)

Procedures only: intake setup (CoStar saved-search spec per market, export column set, alert senders), how to read each signal, hand-offs (`verified-deal-recon`, `owner-outreach`, `acquisition-underwriting` COMPS mode reads benchmarks first), and the CoStar data-handling rule. Tie-break: market-level narrative stays in `market-monitor`; listing-level tracking lives here.

## 4. Error handling

- Parse failures land as `parse_status=failed` with the error; never partial-insert a file (transaction per landing).
- Unknown CoStar header ⇒ hard fail naming the column (header-map config is the fix), never silent skip.
- LLM-extracted rows failing schema ⇒ rejected and listed in the intake run log; they never touch benchmarks.
- Duplicate file (sha256) ⇒ no-op.
- Cell below n threshold after full rollup ⇒ benchmark null, signal suppressed, reason shown.
- Scheduled tasks exit nonzero on ingest failure so `automation-health-monitor` sees it.

## 5. Testing

- Unit: address normalization, rent-basis conversion (every basis × opex source), cell rollup, percentile/median, each signal rule at threshold boundaries, removal logic (full vs. partial export).
- Fixture ingest: CoStar export fixtures built from **real** export headers (Gabriel-supplied samples, values anonymized) — no invented column names.
- Integration: temp warehouse db, ingest two monthly snapshots → assert DOM, rent-cut, removal, signals, marketRents feed.
- Adversarial: Fable REFUTE pass over normalization, benchmarks, and signals before merge.

## 6. Phasing

| Phase | Scope | Unblocks |
|---|---|---|
| P1 | Migrations · CoStar listings ingest · normalization · benchmarks · ORA positioning · marketRents feed · module v1 (distribution, positioning, stale/below-market, freshness) | G1 (census), G3, G4 |
| P2 | Analytics history + Lease Comps ingest · broker points · ORA signed rents · history + new-vs-active charts | G2 |
| P3 | Alert-email intake · both scheduled tasks · digest · rent-cut/new-listing signals · Silver activity | G1 (flow) |
| P4 | Web sweep · `lease-market-monitor` skill · COMPS-mode read path | G1 (gaps) |

## 7. Risks

| Risk | Mitigation |
|---|---|
| Parser built on guessed CoStar columns | **Blocking input:** Gabriel supplies 1 listings export + 1 Analytics rent-series export before P1 parser work |
| Rent-basis mixing ⇒ false below-market flags | Mandatory NNN-eq; UNKNOWN/WITHHELD excluded; physicals shown in evidence |
| Thin samples in entry markets | n-gated rollup; n and cell key always displayed |
| Multi-writer repo collision | Isolated worktree `feat/lease-market-intel`; claim `lease-market-intel`; new files + additive migrations; single route-registration touch in `server/index.ts` |
| CoStar license scope (per-seat) | Internal use only; no automation; [SPECULATIVE] mirror exposure of row-level data to non-seat users is Gabriel's call — config flag `mirrorRowLevel` default **true** per approved design, flip to aggregates-only without code change |
| Asking ≠ achieved | Labeled "asking" everywhere; signed rents (Lease Comps, ORA) plotted separately |
