# Lease Market Intelligence — Design (rev 3)

- **Status:** Design approved by Gabriel 2026-09-16 (monthly CoStar export cadence; row-level mirror). Rev 2 folded in the Fable 5.1 pre-mortem (§11). Rev 3 folds in the ChatGPT cross-examination (`2026-09-16-lease-market-crossexam-chatgpt.md`; adoption ids A1–A17 cited inline) and Gabriel's in-turn instruction to implement all adopted improvements.
- **Lane:** L3 `/build` (overlaps L6 `market-monitor` / `acquisition-underwriting`; extends, never duplicates).
- **Surfaces:** `oxford-command-center` (engine + dashboard) · `ora-skills` (one skill, P3) · CC/MCP fleet (two tasks, P3). Operator layer is Claude (Cowork/Code/fleet) — not a second agent platform (cross-exam R1).
- **Models:** design Opus 5 · pre-mortem Fable 5.1 · implementation Sonnet 5 · task review Opus 5 · mandatory Fable REFUTE on normalization / similarity / signals / radar / feed before merge.

## 1. Goals — the five standing questions (A–E, cross-exam §1)

| # | Question | Success test |
|---|---|---|
| A | What's newly available (and what changed)? | Changes tab lists every new / cut / increase / removed / returned space from the latest complete export per market |
| B | What is the market actually asking? | Rent curve + benchmarks per market with n, coverage, confidence on every figure |
| C | How has asking rent changed? | P1: per-space event history; P2: derived monthly series + CoStar Analytics history |
| D | How does Oxford compare? | Every vacant ORA unit shows low/P25/median/P75/high of its comparable set, gap %, confidence, recommendation, and hygiene flags |
| E | Where is there an investment opportunity? | Acquisition Radar ranks eligible properties by a transparent 100-point score with every component and gate visible, plus a decision log |

**Non-goals:** automated outreach or promotion (manual) · sale listings (`deal-flow-triage`) · automated CoStar/LoopNet access or third-party LoopNet data APIs (R4) · NOI claims from asking rents (R5) · emerging-market discovery (R7, `market-monitor`) · photos (R8).

## 2. Data sources (trust-ordered)

| Tier | Source | Mechanism | Cadence | In benchmarks? | Can remove? |
|---|---|---|---|---|---|
| T1 | CoStar Suite lease-listing export, one saved search per market, space-level rows | Human export → `Claude_Workspace/lease-market-intake/costar/` | Monthly | Yes (eligible rows) | Yes (complete exports, two strikes) |
| T1 | CoStar Analytics history · CoStar Lease Comps | Human export | Backfill, then quarterly (P2) | History / executed comps | n/a |
| T2 | Portal alert emails + broker availability emails (A15) | M365 read-only by sender; LLM → schema → validator; Message-ID dedup | Weekdays (P3) | No | No — expire 60 days |
| T3 | Broker quarterly reports | `market-monitor` writes `market_series` | Quarterly (P2) | History overlay | n/a |
| T4 | ORA rent roll, ORA executed leases (TI, free rent), LoopNet Silver activity | Warehouse join; Silver export | Monthly | ORA executed = grade A comps (P2) | n/a |
| T5 | Web sweep | Weekly research, URL-cited | Weekly (P4) | No | No — expire 60 days |

**Validation gate (A17):** Columbus is ingested first; Gabriel reviews rent curve, radar top 10 and positioning, and ratifies the subtype / status / rent-basis maps (the ontology) before other markets are enabled.

## 3. Engine

### 3.1 Pipeline

```
intake → lm_landing (sha256 / Message-ID dedup, immutable file copy)
  → parse [CoStar: header map, deterministic | email/web: LLM JSON → zod]
  → CanonicalListingRow
  → normalize (address, suite, subtype, size band, rent text incl. totals and base+expense, bounds, NNN-eq)
  → resolve identity: PROPERTY (CoStar property id ▸ address_norm) → SPACE (property + suite_norm)   (A1)
  → lm_property + lm_listing + lm_observation + lm_listing_event                                    (A2)
  → completeness → two-strike removal state machine
  → benchmarks (cells) + similarity comp sets (A4) + confidence (A6)
  → space signals + property radar score (A9) → surfaces
```

### 3.2 Storage — migration 029 (additive)

- `lm_landing` — as rev 2 (partial unique sha256 where ok; partial unique Message-ID for emails; `owner_screen_ok`; completeness + reason).
- `lm_property` (A1) — `id, costar_property_id, address_norm UNIQUE, address_display, city, state, zip, lat, lon, market_id, submarket, subtype{warehouse,flex}, building_status, building_sf, year_built, clear_height_ft, docks, drive_ins, office_pct, owner_name, owner_type, ora_property_key, first_seen, last_seen`.
- `lm_listing` (space) — `id, property_id FK, suite_norm, first_seen, last_seen, first_landing_id, costar_date_on_market (earliest seen), status{active,missing_once,removed,expired}, removed_at, origin_tier, broker_name, broker_company, listing_url, description` · UNIQUE(property_id, suite_norm).
- `lm_observation` — rev 2 columns + `rent_is_total`, `opex_quoted_psf`, `source_row`, `rejected_reason`.
- `lm_listing_event` (A2) — `listing_id, landing_id, event_date, kind{new,returned,price_cut,price_increase,sf_change,dom_reset,missing,removed}, prev_value, new_value`.
- `lm_signal` — `property_id NOT NULL, listing_id NULL, kind{new_listing,stale,rent_cut,below_market,withdrawn_after_stale,radar_candidate}, severity, score, confidence, comp_basis{similarity,cell}, cell_key, computed_at, evidence_json` — fully replaced per compute run.
- `lm_market_rent_feed` — rev 2 + `confidence`, `comp_basis`.
- `lm_radar_decision` (A14) — `property_id FK, decided_at, decision{investigate,monitor,pass,pursued,loi,closed}, note` — append-only, never replaced.
- Read-only views for agents (cross-exam §2 small): `lm_v_current_spaces`, `lm_v_listing_metrics` (original / current / min asking, reduction count, cumulative reduction %, first/last seen), `lm_v_radar`.
- History reuses `market_series` (P2).

### 3.3 Normalization

- **Rent text (A3):** single value, range, `/SF/mo` vs `/SF/yr`; **totals** (no `/SF` token and value ≥ 1,000, or explicit `/mo`/`per month` total ≥ 50 without `/SF`) ⇒ `rentIsTotal`, converted with available SF; **base + expenses** (`$7.25/SF + $2.50 NNN|CAM|opex|expenses|nets`) ⇒ base as NNN rent, add-on as `opex_quoted_psf`; `+ expenses` without a number ⇒ NNN with no quoted opex; withheld phrases ⇒ WITHHELD; ambiguous (no `/SF`, 60 ≤ value < 1,000, no period) ⇒ UNKNOWN.
- **Range:** midpoint only if spread ≤ 20%, else UNKNOWN. **Period:** explicit wins; none and value < 3.00 ⇒ monthly, low confidence.
- **Bounds (A3):** asking or NNN-eq outside **$1.00–$60.00/SF/yr** ⇒ UNKNOWN with `rejected_reason`.
- **Basis → NNN-eq:** NNN as-is (high confidence unless period inferred). GROSS/FSG ⇒ asking − opex total. MG/IG ⇒ asking − Σ `mgLandlordPays` components (requires component-level opex). Opex resolution: config `opexDefaults` components ▸ **market quoted-opex median** (NNN observations with `opex_quoted_psf`, same market + subtype, trailing 12 months incl. current file, n ≥ 5; total only — usable for GROSS/FSG, not MG/IG) ▸ null.
- **Benchmark eligibility:** high confidence · NNN · not sublease · T1 · existing · rent present · building SF ≤ 80K or unknown · not ORA-owned.
- **Cells:** market × submarket × subtype{warehouse, flex} × size band (+ office stratum ≥40% for flex); rollup: widen band ▸ market level ▸ null; n ≥ 5; quoted share and low coverage (< 0.5) on every figure.
- **Identity:** property by CoStar property id ▸ address_norm; space by property + suite_norm.

### 3.4 Export completeness and removal — unchanged from rev 2

Complete ⇔ header fingerprint unchanged · rows < cap · rows ≥ 0.7 × prior complete · export date after prior. Partial ⇒ observations and events only. Two consecutive complete exports without a space ⇒ `removed` (outcome unknown).

### 3.5 Events (A2)

Ingest writes: `new` (first sighting) · `returned` (was removed) · `price_cut` / `price_increase` (asking NNN-eq, else rent_low, changed by > $0.005) · `sf_change` (available SF changed ≥ 5%) · `dom_reset` (CoStar DOM decreased) · `missing` · `removed`.

### 3.6 Comparable sets (A4) and confidence (A6)

**Similarity score (0–100), transparent, per candidate space vs. subject** — hard mismatch (different market or subtype) ⇒ excluded. Components (missing data on either side ⇒ half credit, reported as `unknown`):

| Component | Weight | Full credit | Zero credit |
|---|---|---|---|
| Location | 30 | both coords, ≤ 2 mi (linear to 0 at 15 mi); no coords ⇒ same non-null submarket 0.7, else 0.3 | ≥ 15 mi |
| Size | 25 | available-SF ratio ≥ 0.8 | ratio ≤ 0.3 |
| Clear height | 15 | Δ ≤ 2 ft | Δ ≥ 12 ft |
| Age | 10 | Δ ≤ 5 yrs | Δ ≥ 35 yrs |
| Loading | 10 | dock parity 0.5 + drive-in parity 0.5 | — |
| Office share | 10 | Δ ≤ 10 pts | Δ ≥ 50 pts |

Comp set = benchmark-eligible spaces, excluding the subject property and ORA-owned properties, score ≥ 60, top 15 by score (ties: higher score, then lower listing id). **Sufficient** ⇔ ≥ 8 comps; otherwise the rev 2 cell is used (`comp_basis='cell'`). Stats: low, P25, median, P75, high (unweighted, auditable).

**Confidence:** HIGH ⇔ similarity basis with ≥ 15 comps and cell not low coverage · MEDIUM ⇔ similarity with 8–14 comps, or cell basis with n ≥ 10, not market-level, not low coverage · LOW otherwise. (P2 adds: HIGH also requires ≥ 1 grade A/B executed comp within 18 months once executed comps exist for the market.)

### 3.7 Space signals

| Kind | Rule |
|---|---|
| `new_listing` | first landing is the market's latest complete export |
| `stale` | existing building · effective DOM ≥ stale threshold (`max(180, 1.5 × completed-DOM baseline)`, fallback 180 / 270 by tier); `effective_dom = max(own clock, earliest CoStar date)`; severity high if the space had a price cut or property vacancy share ≥ 30% |
| `rent_cut` | a `price_cut` event in the latest complete export of the market; evidence: original, previous, current asking, reduction count, cumulative % |
| `below_market` | eligible space · comparable set confidence ≥ MEDIUM · asking ≤ comparable P25 **and** ≤ 0.85 × comparable median |
| `withdrawn_after_stale` (A10) | space removed within the last 90 days whose effective DOM at removal ≥ stale threshold — severity info ("monitor; outcome unknown") |

ORA-owned properties emit no market signals (they appear in positioning).

### 3.8 Acquisition Radar (A9)

**Gates (all required):** owner screen available for the market · owner type ∉ {institutional, never_call, unknown} · not ORA-owned · building SF known and ≤ 50,000 · building existing · ≥ 1 active non-sublease space.

**Score (0–100, every component shown):**

| Component | Max | Rule |
|---|---|---|
| Days on market | 25 | max effective DOM ÷ stale threshold: < 0.75 ⇒ 0 · < 1.0 ⇒ 10 · < 1.5 ⇒ 18 · ≥ 1.5 ⇒ 25 |
| Rent reductions | 20 | max over spaces: ≥ 2 cuts ⇒ 12, 1 cut ⇒ 6; plus cumulative reduction ≥ 10% ⇒ +8, ≥ 5% ⇒ +4; cap 20 |
| Below comparable median | 25 | best space gap vs. its comparable median, confidence ≥ MEDIUM: ≤ −25% ⇒ 25 · ≤ −15% ⇒ 18 · ≤ −10% ⇒ 10 |
| Building vacancy share | 15 | Σ active non-sublease available SF ÷ building SF: ≥ 50% ⇒ 15 · ≥ 30% ⇒ 10 · ≥ 15% ⇒ 5 |
| Buy-box fit | 10 | building 10,000–50,000 SF ⇒ 6 (< 10,000 ⇒ 3) + warehouse 4 / flex 3 |
| Owner | 5 | private ⇒ 5 · verify or affiliated ⇒ 2 |

Candidate ⇔ gates pass and score ≥ `radarMinScore` (50). Evidence: score parts, gates, vacancy share, reductions timeline, owner name/type/listing count, broker, **indicative rent gap** = (comparable median − asking) × available SF for the best space, labeled "gross, vacant space only — not NOI" (R5). Decisions append to `lm_radar_decision`; the latest decision shows beside each candidate. Pursue ⇒ `verified-deal-recon` (manual).

### 3.9 Oxford Rent Position (A7) and listing hygiene (A8)

Per vacant rent-roll unit whose property is configured: subject = config property (+ physicals from its matched `lm_property` when present) at the unit's SF; comparable set per §3.6; output low/P25/median/P75/high, n, basis, confidence, ORA asking (from the matched ORA space), percentile, gap %, band (±10%), estimated market asking range (P25–P75), deterministic recommendation, top comps (address when row-level allowed, SF, asking, score), effective DOM, broker/URL/date listed. Flags: `not_listed` (vacant unit, no ORA space in CoStar) and, separately, `listed_but_leased` (active ORA space in CoStar with no matching vacant unit in the rent roll).

### 3.10 Market-rent feed

Per configured ORA property with `leaseBasis = NNN`: comparable median at `typicalUnitSf` (similarity ▸ cell), written with n, basis, confidence; LOW confidence or low coverage ⇒ no value. Merged under manual `overlay.marketRents` at read time (`derived-asking` provenance).

## 4. Dashboard — "Lease Market" module

**KPI row (A13):** markets fresh / total · active spaces · new in latest exports · price cuts · stale · radar candidates.
**Tabs:** *Portfolio* (Rent Position table, hygiene flags, expandable comps) · *Market Rents* (RentCurve scatter — log available SF vs. NNN-eq, solid quoted / hollow converted / ORA highlighted (A11); DOM histogram; benchmark table) · *Acquisition Radar* (ranked candidates with score breakdown, gates, decision buttons; withdrawn-after-stale monitor list) · *Changes* (events from latest exports) · *Data Quality* (freshness per market, rows, skipped, quoted share, coordinate coverage, low-confidence share).
**Space history drawer:** observations + events timeline (live server only).
Mirror: summary, positioning, radar, signals, changes baked (optional routes); `mirrorRowLevel=false` strips addresses, owners, brokers, URLs.

## 5. Automation (P3; `register-scheduled-task`, CC/MCP fleet)

- `ora-lease-listings-intake` (weekdays): intake files; portal + broker emails (A15) → T2 rows; nonzero exit on failure.
- `ora-lease-market-digest` (Mondays, only if a new landing exists): one email, three sections — Leasing · Portfolio · Acquisition (A16); immediate push only for a new radar candidate ≥ 70 or an ORA vacancy crossing ±10%; export reminders on the first business day and at day 35.

## 6. Skill — `lease-market-monitor` (P3)

Intake setup, signal and radar interpretation, natural-language query recipes over the `lm_v_*` views, hand-offs (`verified-deal-recon`, `owner-outreach`, COMPS mode), CoStar data rule, tie-breaks (market narrative → `market-monitor`; sale OMs → `deal-flow-triage`).

## 7. Error handling

One transaction per landing · unknown header / unmapped value ⇒ hard fail naming it · out-of-bounds rent ⇒ UNKNOWN + reason (row kept) · schema-failing LLM rows rejected · duplicates no-op · thin comparables ⇒ LOW confidence, signals that need MEDIUM suppressed · missing owner screen ⇒ radar withheld (fail closed) · scripts exit nonzero on failure.

## 8. Testing

Unit tests for every normalization rule (incl. totals, base+expense, bounds), similarity components and selection, confidence, events, radar gates and each score band, positioning recommendation and hygiene flags, feed precedence. Integration: two sequential exports ⇒ events, removal, signals, radar, feed, API. Fixtures use TEST header labels; production header map only from real samples.

## 9. Phasing

| Phase | Scope |
|---|---|
| **P1** | Migration 029 · config · normalization (A3) · property/space identity (A1) · events (A2) · completeness/removal · cells · similarity + confidence (A4, A6) · space signals + withdrawn (A10) · radar score + decisions (A9, A14) · Rent Position + hygiene (A7, A8) · feed · API · module with KPI row, tabs, RentCurve, history drawer (A11, A13) · agent views · Columbus-first gate (A17) |
| **P2** | `lm_lease_comp` executed comps, grades A–D, net effective rent (A5) · derived monthly series incl. same-listing change (A12) · CoStar Analytics history · broker points · leased-vs-withdrawn classification · history charts · map decision (D1) · pricing elasticity once data allows (D2) |
| **P3** | Alert + broker email intake (A15) · digest with three lanes + threshold pushes (A16) · export reminders · Silver activity · skill with NL query recipes |
| **P4** | Web sweep (T5) |
| **P5** | Hedonic rent model once ≥ 200 graded comps per market (D3) |

## 10. Risks

| Risk | Mitigation |
|---|---|
| CoStar column labels unknown | Header map from real samples only; hard fail on drift; Columbus-first review |
| Similarity weights wrong for a submarket | Weights and thresholds in config; comps listed for audit; cell fallback; Fable REFUTE |
| Radar score over-weights one trigger | Gates + component caps + decision log calibration (A14) |
| CoStar per-seat license vs. mirror viewers | `mirrorRowLevel` config flip, strips addresses/owners/brokers/URLs |
| Multi-writer repo | Worktree + claim + `architecture/status.json` declaration; sub-router registration only |
| Asking ≠ achieved | Labels everywhere; executed comps graded separately (P2) |

## 11. Adjudication logs

**Fable 5.1 pre-mortem (rev 2):** accepted F1–F11, F13, F14; modified F12; rejected F15 (Gabriel chose row-level) and the web-sweep cut; cuts accepted: `light_mfg`, 7-day new rule, `lm_rent_series`, unconditional weekly digest.
**ChatGPT cross-examination (rev 3):** adopted A1–A17; rejected R1–R9; deferred D1–D4. Full reasoning: `2026-09-16-lease-market-crossexam-chatgpt.md`.
