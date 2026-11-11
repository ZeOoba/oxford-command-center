# PCA reconciliation — payload vs sources (2026-10-13)

Rule applied: where the payload and the register disagree, the workbook **plus the underlying PCR** wins; where
the PCR was available, it was read. Every divergence is listed. "Applied" = how the command center now behaves.

**Sources read**
- `2026-10-06_PCA-Extraction_Register_v01_2.xlsx` (OneDrive\Business, read-only) — imported into a scratch SQLite
  (`WAREHOUSE_DB` in the session scratchpad) with `scripts/import-pca-register.ts`; the live warehouse was not touched.
- `2026-10-06_PCA-Context_Summary_v01_2.md` (same folder).
- `2026-10-13_PCA_Command_Center_Report_v01.md` (the payload's prose source).
- **Intertek PCR T1643.01** (`PCA-29000 Information Lane-Easton-Maryland.pdf`, 117 pp, text layer): read for the
  29000 Information Ln figures. 117/117 pages carry the DRAFT watermark.
- **All 17 underlying reports (R01-R17, plus the 1900 N Broadway PES photo log "R11b")** were located under
  `OneDrive\Business` (read-only), converted with `pdftotext`, and - for the three scans with no text layer (R01, R02,
  R11b) - OCR'd with `ocrmypdf --rotate-pages` (a first pass without rotation produced garbage and was discarded).
  Each report was extracted by an independent read-only agent against a fixed schema, then QC'd (below).
- Not available: the prompt's `claude/PCA_Context_Summary_2026-10-06.md` and
  `claude/PCA_29000_Information_Lane_Intertek_2025-10-29.md` were not found on disk (the v01_2 Context Summary, the
  2026-10-13 report and its v01_1 revision, and the Intertek PCR itself were used instead). Notion ledgers were not
  queried: no NOTION_TOKEN / ledger data-source ids are configured in this session, so the Notion branch of the
  loader is implemented (read-only, unit-tested with a fake fetch) but **unverified against live Notion**.

## Discrepancies

| # | Item | Payload / 10-13 report | Workbook / Context Summary | PCR (where read) | Applied |
|---|---|---|---|---|---|
| 1 | **29000 Info Ln Immediate / Short-term** | $1,100 / $0 | R08: $REDACTED-AMT / $REDACTED-AMT (note on the row: "Yr1 $REDACTED-AMT includes $1,100 ADA") | Immediate $1,100 (ADA van $275 + signs $225 + aisles $600); Short-term $0.00; Year 1 / Year 2 reserve outlays are $REDACTED-AMT / $REDACTED-AMT | **Payload/PCR.** Overlay correction on `info-lane` R08. Year 1/2 shown only in the reserve schedule. Test: `applyPcaOverlay — … correction`. |
| 2 | 29000 report date | 2025-10-29 | `2025-11` (a 2-page repair sheet dated 11.2025; "final 2025 report NOT in folder") | Report dated October 29, 2025 (117 pp, T1643.01) | **PCR.** The full DRAFT PCR is on hand; the register describes only a repair-cost sheet. |
| 3 | 29000 $/SF/yr | 0.23 uninflated / 0.25 inflated | 0.25 (the inflated figure, shown as the only value) | $0.23 uninflated, $0.25 inflated | **PCR.** Uninflated 0.23 used; computed REDACTED-AMT ÷ 48,000 ÷ 12 = 0.2313 reconciles. |
| 4 | 29000 consultant | Intertek | "Intertek/ATI (name not on page)" | Intertek Project T1643.01 | Intertek. |
| 5 | 29000 reserve schedule, system split, unit costs | Yr1 REDACTED-AMT · Yr2 REDACTED-AMT · Yr6 2,362 · Yr7 33,000 · Yr10 15,000 · Yr11 12,000 (sum REDACTED-AMT); paving 74,500 / exterior REDACTED-AMT / roof 24,000 (sum REDACTED-AMT) | Not in register | Schedule row total $REDACTED-AMT (inflated $REDACTED-AMT); category totals $74,500 / $REDACTED-AMT / $24,000; unit-cost × quantity arithmetic ties (e.g. 10,000 SY × $1.50 = $15,000; 1,350 LF × $3.50 = $4,725) | Verified against the PCR; stored in the overlay with provenance. |
| 6 | 29000 asset facts (metal roofs EUL 40, asphalt RUL 1, landlord Rheem unit 301) | Present | Register has only "Easton Tech Commons — Buildings / metal roofs, 2001, PCI 2016" | Not individually re-verified in the PCR | Overlay rows added; the register's single roof row is superseded to avoid listing a roof twice. |
| 7 | **Raytown reserve (uninflated)** | $292,500 | $REDACTED-AMT (EWI-stated; omits rows) | Not re-read (EWI PCR) | **Payload** — the register's own Flags #4 says year columns sum to $292,500 and inflated $REDACTED-AMT reconciles to it. Overlay correction on `raytown` R06. |
| 8 | Raytown $/SF/yr | `null` | $21.25 "stated", not reproducible | n/a | Computed 292,500 ÷ 34,560 ÷ 12 = **0.705, shown as "derived"**; the printed 21.25 is kept as a tooltip only. |
| 9 | Livingston $/SF/yr | `null`; report computes 0.80 | `–` | n/a | Derived 0.80, tagged "derived". |
| 10 | Northwood reserve / $/SF/yr | uninflated `null`; 0.06 | Reserves blank, inflated $REDACTED-AMT; 0.06 "per unit" | n/a | **n/a, not imputed.** The 0.06 is on the inflated figure; the register warns it is "per unit". |
| 11 | Status of Livingston and 29000 | DRAFT | Register `usability_class` draft for both | 29000: DRAFT watermark verified | DRAFT badge + currency alert for both. |
| 12 | **3540 E Fifth calibration delta** | −59% ($22/SF vs $9.12/SF) | −69.3% on dollars ($792,000 vs $REDACTED-AMT) | n/a | **Workbook** (the view computes dollars first). The scopes differ (26,700 SF vs up to 36,000 SF), so the two bases give different deltas — treat as directional (label shown on the panel). |
| 13 | Banwick calibration | "actual" $10.5–12.5/SF | Pair exists with contractor `(none yet)` | n/a | Shown as **quotes, not actuals**, via an annotation; no delta is computed. |
| 14 | Open issues | 8 consolidated items | 16 register items (9 more detail: e.g. #5 29000 "SY vs SF unit mismatch", #13 Muirkirk HVAC/roof SF conflict) | n/a | The 8 are loaded as the decision queue (Open / unassigned). The 16 register items still show beneath them, unchanged. |
| 15 | Payload `stale_reports` list | Includes 29000 PCI 2016 | Register R09 dated 2016-12-07 | n/a | Consistent. Pre-2024 reports are STALE: excluded from rollup and KPI dollar totals, counted as properties. |
| 16 | Near-term total | ≈ $677K, E Fulton ≈ 87% | With the register's 29000 error the total would be **$746,713 (E Fulton 79%)** | n/a | With correction on live-import data: **$676,950; E Fulton $592,125 = REDACTED-AMT** (test asserts both). |
| 17 | Sunburst | $2,225 immediate, no reserves | Same; SF blank | n/a | Reserves/$/SF n/a. |
| 18 | **Calibration - stale PCA estimates** | Payload seeds New Plant (PCI 2016, -60%) and E Fifth (ASI 2021 budget, -59%) as headline pairs | Same pairs in Est_vs_Actual | n/a | Both are **in the ledger but excluded from every statistic** (rule: a PCA estimate from a pre-2024 report never feeds calibration unit costs). Today: roof_epdm n=3 LIMITED, roof_tpo n=1 THIN. See "Decisions". |
| 19 | Calibration - unit vs total basis | Variances quoted on totals: New Plant -60%, Livingston +2% | Est_vs_Actual: E Fifth -69.3% (totals) | Quantities differ between estimate and contractor scope | Ledger normalizes to **$/unit on the contractor-priced quantity**: New Plant 2.85 vs 7.00 = -59%, E Fifth 9.12 vs 22.00 = -59%, Livingston 12.34 vs 12.00 = +2.8%, E Fulton 12.50 vs 4.00 = 3.13x. |
| 20 | Banwick quotes $10.5-12.5/SF | Present as "quotes" in the payload | Register Quotes_Actuals has **no Banwick quote row**; Est_vs_Actual shows "(none yet)" | n/a | Seeded as two BID rows (the range endpoints); vendors and dates **not located** - doc year inferred; flagged in each row's scope_note. Needs the quote documents. |
| 21 | E Fulton calibration quantity | not stated | Able budget qty 52,500 SF of ~195,000 SF; CBRE priced 150,000 SF | CBRE had no roof access | Ledger qty = contractor scope (52,500 SF); both quantities in scope_note. |
| 22 | R08 source in the register | n/a | Register R08 cites a 2-page *repair-cost sheet* dated 11.2025 | Full Intertek PCR (117 pp, 10/29/2025) exists in Business/29000 Information Lane (Loan Firm 03 10.2025 file), byte-identical to the Downloads copy | R08 extraction uses the full PCR. |
| 23 | 29000 Info Ln, PCI 2016 vs Intertek 2025 (cross-vintage) | n/a | n/a | Reserves: 2016 = $REDACTED-AMT / 10 yrs **incl. $150,000 for 30 heat-pump systems** (narrative RR-3 says 10 systems @ $5,000); 2025 = $REDACTED-AMT / 12 yrs with **no HVAC line** (tenant-owned except landlord Rheem unit 301). Both: 5 buildings, 48,000 SF, no sprinklers, metal roofs (2001 B2-B4, 2007 B1 and B5). Electric service printed single-phase and three-phase within the 2016 report. | Shown in the Building specs cross-vintage diff; **2025 governs**, 2016 kept as history. The disappearance of the heat-pump reserve is an assumption change (ownership), not a condition change - worth confirming in the leases. |
| 24 | 29000 utilities / site conflicts inside the 2025 PCR | "Delmarva vs Town of Easton; generator/transformer location" | n/a | Report names Delmarva Power as electric; the questionnaire says Town of Easton (also gas/water/sewer). Abandoned Generac generator + propane tank placed between B4-B5 in one place and B1-B2 / B3-B4 in another. Only two COs provided ("Unit E" 12/21/2007, "Unit D" 1/18/2008, mapped to B4/B5); none for B1-B3; B4 listed as completed 2001. Fire-department response not received. Rent roll lists a church (303) and a fitness (306) tenant. | Recorded as printed (code_zoning / utilities facts). |
| 25 | Banwick "2518" (open issue #3) | appears in no source | Workbook Flags #3 same | R01 full text searched: **"2518" not found**; address prints "2800 - 2826 Banwick Road, Columbus, Ohio 43232" | Confirms issue #3 can close unless another source exists. |
| 26 | Banwick/Morrison tenant counts | n/a | n/a | R01: 14 tenant spaces (report) vs 10 (questionnaire) vs 16 (2020 Foust excerpt); electric meter east side vs west end; several suite names differ across rent roll / fire records / placards | Recorded as printed with notes; no resolution attempted. |
| 27 | R06 Raytown reserve lines | Reserves $292,500 | Register $REDACTED-AMT stated | Extraction: findings with a printed line total sum to **$256,500**; the other **$36,000** is on HVAC / tenant-sign lines that print no line total (left null, not derived) | Reserve total uses $292,500 (year columns). The findings ledger is therefore $36,000 short of the table for this report, by design. |
| 28 | R13 55 New Plant roof SF | n/a | Register quote uses 28,700 SF; PCI table 28,900 SF | No "28,700" appears in the PCI text; roof area 28,900 from the p.54 table; footprint 28,983 / gross 34,534 / mezzanine 5,551 | Both retained with page refs; calibration qty uses the **contractor's 28,700** (Quotes_Actuals). |
| 29 | R16 6410 Sheriff west-dock roof age | n/a | n/a | "about 14 years" (p.8) vs "about 13 years" (p.29) | 13 recorded (DERIVED install 1994) with the conflict noted. |
| 30 | R15 survey date | 2013-08 | 2013-08-02 | Report prints both 08/01/13 and 8/2/13 | 2013-08-02 used, conflict noted. |
| 31 | R07 F.A. Taylor roof inspection | n/a | Register: "F.A. Taylor roof inspection 2025-11-20, 1988 metal roof FAIR, 37 yrs, budget TPO retrofit" | **Not in the 15-page PCI PDF** (the SDAT printout on p.7 gives year built 1988) | No F.A. Taylor facts extracted; the register note stands unverified. |
| 32 | R12 9050 Red Branch roof area | n/a | Register "Roof 90,000 SF" | Printed only as the RR-4 table quantity ($5.00/SF = $450,000); gross building area 89,609 SF | Roof area 90,000 recorded from the table with the source noted. Roof install 2007 is DERIVED (2015 minus "approximately eight years"). |
| 33 | Cost seg - OCR digit error (Northwood) | Seed: CMU wall per building 19,368 SF | n/a | Fresh rotated OCR: quantity list reads 720 LF / **10,368 SF** (= 720 LF x 14.4 ft exactly) | Corrected to 10,368 in the data with a note; regression test added. |
| 34 | Cost seg - provenance (4 facts) | n/a | n/a | Land allocation (Broadway $1,232,257, Northwood $840,988) and Livingston proposal basis ($649,900) / land ($320,100) are printed in the proposal / contract, not the study the seed cited | `source_file` re-pointed to the proposal / contract; note added. |
| 35 | Broadway GBA (**new - not in D1-D14**) | n/a | PCA register SF 26,609 (PCI 2015, STALE) | Cost seg gross building area 27,671 SF (**+4.0%**) | Shown as "differs" in the quantity cross-check; confirm survey SF. |
| 36 | Livingston paving (**new**) | n/a | AEI PCA 35,200 SF (p.18) | Cost seg asphalt 33,778 SF (**-4.0%**) | Shown as "differs". |
| 37 | Livingston GBA (D1) | n/a | AEI / register 10,950 SF | Cost seg 11,280 SF (**+3.0%**); PCA intensity 0.80 -> 0.78 on 11,280 SF | Confirmed; noted, not applied (no reserve is adjusted). |
| 38 | Livingston roof (D2) | PCA $28,800 / Able $29,313 unscoped | AEI roof sections 3,000 / 6,500 / 2,400 / 100 SF (p.35, cut by building use) | Cost seg: 3883 aluminum panel 6,078 + asphalt shingle 2,962 (= 9,040); 3875 EPDM 2,240 | The two cuts are not the same surfaces, so the roof rows are marked "scope differs - not compared"; no surface is linked to any price. (An earlier cut of the cross-check compared them and produced spurious matches - fixed.) |
| 39 | Northwood GBA / roof | n/a | R05 p.9: 18,000 (A and B each) + 17,700 (C, 2203 Marvel Rd) = 53,700 | Cost seg GBA 53,700 (matches); modeled roof 18,000 x 3 = 54,000 | GBA matches; per-building roof is modeled uniform (DERIVED). The study's address is "2203 Marvel Rd & 2205-2207 Northwood Dr" while the PCA register keys the property as 2203-2207 Northwood. |

## Extraction coverage (R01-R17, plus R11b)

Status per report with fact counts by category. READ = every page with text was read; PARTIAL = sections skipped (boilerplate,
photo-caption pages, appendices) or tables only reconstructable from totals; UNREADABLE = could not be read (**none**).
"Pages (no text)" counts pages with no extractable text layer - mostly photos and maps; scans were OCR'd (see Sources).

| Report | Property | Consultant · date | Status | OCR | Pages (no text) | Facts | Findings | site | struct | roof | paving | envelope | hvac | elec | plumb | fire/LS | ADA | env | code | util | overall |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| R01 | 2800-2826 Banwick Rd, Columbus OH | Intertek / ATI (T6501.01) · 2026-04-07 | READ | yes | 137 (12) | 154 | 18 | 49 | 10 | 13 | 10 | 6 | 6 | 9 | 6 | 15 | 5 | 2 | 5 | 5 | 13 |
| R02 | 384-420 Old Morrison Rd, Columbus OH | Intertek / ATI (T6501.01) · 2026-04-07 | READ | yes | 114 (1) | 115 | 27 | 30 | 9 | 15 | 12 | 7 | 6 | 8 | 3 | 3 | 3 | 1 | 3 | 3 | 12 |
| R03 | 3520 E Fulton St, Columbus OH | CBRE Assessment & Consulting · 2025-04-28 | READ | no | 108 (24) | 165 | 48 | 37 | 11 | 24 | 16 | 10 | 13 | 9 | 7 | 8 | 5 | 3 | 5 | 6 | 11 |
| R04 | 3875-3883 E Livingston Rd, Columbus OH | AEI Consultants (507434) · 2025-04-10 | PARTIAL | no | 139 (12) | 187 | 48 | 33 | 15 | 36 | 12 | 12 | 16 | 16 | 9 | 9 | 3 | 6 | 6 | 6 | 8 |
| R05 | 2203-2207 Northwood Dr | PCI Consultants · 2024-09-16 | READ | no | 52 (2) | 114 | 11 | 22 | 11 | 18 | 11 | 6 | 9 | 5 | 5 | 5 | 5 | 1 | 0 | 7 | 9 |
| R06 | 9620 State Route 350, Raytown MO | Environmental Works Inc (EWI #243812) · 2024-10-07 | READ | no | 62 (13) | 133 | 23 | 42 | 8 | 8 | 7 | 7 | 7 | 5 | 4 | 7 | 3 | 6 | 2 | 6 | 21 |
| R07 | 401 Sunburst Hwy | PCI Consultants (comment letter) · 2025-11-25 | READ | no | 15 (5) | 63 | 6 | 11 | 4 | 4 | 4 | 4 | 9 | 9 | 1 | 3 | 4 | 0 | 0 | 4 | 6 |
| R08 | 29000 Information Ln (Easton Tech Commons), Easton MD | Intertek (T1643.01) · 2025-10-29 | READ | no | 121 (9) | 161 | 26 | 65 | 7 | 14 | 9 | 6 | 5 | 7 | 4 | 7 | 7 | 3 | 7 | 5 | 15 |
| R09 | 29000 Information Ln (Easton Tech Commons), Easton MD | PCI Consultants (16.11.13) · 2016-12-07 | PARTIAL | no | 59 (3) | 105 | 17 | 35 | 6 | 8 | 7 | 8 | 10 | 10 | 3 | 5 | 2 | 3 | 0 | 3 | 5 |
| R10 | 28370 St. Michaels Rd, Easton MD | PCI Consultants (19.11.06) · 2019-12-12 | READ | no | 61 (3) | 101 | 18 | 21 | 10 | 15 | 4 | 7 | 8 | 6 | 5 | 7 | 3 | 2 | 1 | 5 | 7 |
| R11 | 1900 North Broadway, Baltimore MD | PCI Engineering · 2015-08 | READ | no | 61 (3) | 110 | 14 | 28 | 9 | 7 | 6 | 7 | 10 | 8 | 5 | 6 | 4 | 3 | 1 | 5 | 11 |
| R11b | 1900 North Broadway, Baltimore MD | PES Associates / Environmental Engineering Services (photo log #23-14819) · 2023-08-04 | PARTIAL | yes | 26 (0) | 27 | 14 | 5 | 2 | 1 | 4 | 3 | 1 | 3 | 1 | 3 | 1 | 0 | 0 | 0 | 3 |
| R12 | 9050 Red Branch Rd, Columbia MD | PCI Consultants (15.07.07) · 2015-08-12 | READ | no | 75 (0) | 107 | 18 | 23 | 12 | 15 | 5 | 6 | 7 | 6 | 3 | 7 | 4 | 1 | 4 | 5 | 9 |
| R13 | 55 New Plant Ct, Owings Mills MD | PCI Consultants · 2016-10 | READ | no | 75 (8) | 110 | 19 | 32 | 12 | 12 | 6 | 6 | 11 | 6 | 3 | 5 | 4 | 1 | 2 | 3 | 7 |
| R14 | Muirkirk (6850-6872 Distribution Dr + 12201-12225 Distribution Way), Beltsville MD | EMG (111785.14R-001.264) · 2014-10-23 | READ | no | 79 (6) | 176 | 23 | 28 | 6 | 22 | 12 | 13 | 54 | 8 | 5 | 10 | 2 | 2 | 4 | 4 | 6 |
| R15 | Fairground Village Shopping Center, Westminster MD | DECA Real Estate Advisors (1307.2746C20) · 2013-08-12 | READ | no | 72 (2) | 93 | 13 | 29 | 3 | 11 | 5 | 4 | 5 | 4 | 4 | 3 | 3 | 1 | 5 | 4 | 12 |
| R16 | 6410 Sheriff Rd, Landover MD (folder labelled 6300 Sherriff Road) | PCI Consultants · 2007-07-19 | READ | no | 68 (0) | 125 | 18 | 30 | 13 | 21 | 7 | 9 | 12 | 7 | 4 | 6 | 2 | 1 | 3 | 5 | 5 |
| R17 | Sepich Portfolio (8 Columbus property groups) | Foust Engineering (D. Foust PE) · 2020-12-24 | READ | no | 47 (0) | 128 | 45 | 33 | 15 | 12 | 12 | 13 | 11 | 16 | 0 | 0 | 0 | 0 | 0 | 6 | 10 |
| **Total** | | | | | | **2174** | **406** | | | | | | | | | | | | | | |

**Accuracy evidence.** Of 903 numeric facts and findings checked mechanically, **97.3%** have the number on the cited page (+/-1);
the misses are facts the extractor OCR'd itself from pages with no text layer (now flagged `ocr`), derived values, and a few
table-garbled figures (each carries an OCR-uncertain or reconstruction note). Per-report findings were tied to the register's
printed totals - **exact** for R01, R02, R03, R04, R07, R08, R10, R11, R14, R15 (e.g. R03 $26,000 / $REDACTED-AMT / $REDACTED-AMT;
R08 $1,100 / $0 / $REDACTED-AMT; R14 $3,100 / $210,420 / $285,400). QC fixes applied before loading: **9 aggregate rows removed** that
extractors had recorded as "findings" (R09 x4, R12, R13, R16 inflation/contingency, and the R09 narrative reserve lines whose dollars
duplicate the cost table were set to null); R05 reserve lines sum to $29,750 (uninflated; the register only has the inflated $REDACTED-AMT);
R06 as in #27.

Known limits: the extractions are summary-grade for photo pages and appendices; `scope` strings differ between reports, so
"current overrides stale" groups only when property + component + canonical attribute + scope all match, while the cross-vintage diff
compares by attribute across scopes (flags are candidates for review, not corrections). R17 (Foust) covers 8 properties under one key
(`sepich-portfolio`) with `scope` naming the building group, so it has no per-property cross-vintage diff.

## Cost segregation studies (module 10) - coverage and verification

Seed: `2026-10-13_CostSeg_Property_Facts_v01_1.json` (identical in content to v01: 222 facts, 6 studies, 14 discrepancies, 12 QC checks; the v02 / v02_1 prompt and report files are also identical to each other). Loaded as `data/cost-seg/cost-seg.json` on its own price basis (`COST_SEG_MODELED_RSMEANS_M&S`).

| Study | Status | Facts | DERIVED | OCR | site | structure | envelope | roof | doors | dock | hvac | plumbing | electrical | fire_life_safety | paving | elevator | tenants | tenant | acquisition | basis | modeled_cost_allocation | Note |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| CS-RAR | READ | 43 | 1 | 1 | 14 | 4 | 2 | 1 | 3 | 0 | 2 | 5 | 2 | 0 | 2 | 0 | 0 | 0 | 3 | 0 | 0 | 60-pp study; 22 of 94 PDF pages have no text (maps / county record); membrane type not stated |
| CS-BWY | READ | 40 | 2 | 0 | 16 | 4 | 3 | 5 | 0 | 0 | 2 | 0 | 1 | 2 | 1 | 2 | 1 | 0 | 2 | 1 | 0 | 78 pp read; Excel detail (FinalReportDataDetail) present |
| CS-RDB | READ | 39 | 1 | 0 | 14 | 3 | 4 | 5 | 2 | 3 | 2 | 0 | 1 | 2 | 2 | 0 | 1 | 0 | 0 | 0 | 0 | 86 pp read; Excel detail present |
| CS-LIV | READ | 40 | 1 | 0 | 17 | 2 | 5 | 5 | 1 | 0 | 3 | 1 | 0 | 1 | 1 | 0 | 0 | 0 | 3 | 0 | 0 | 79 pp read; Excel detail present; roof is three surfaces |
| CS-NWD | PARTIAL (OCR) | 28 | 5 | 28 | 11 | 2 | 1 | 2 | 2 | 0 | 1 | 1 | 1 | 1 | 1 | 0 | 1 | 0 | 2 | 1 | 0 | scan, 129 pp, no text layer: seed OCR'd pp.1-93; re-OCR'd in full (rotated) for verification; door counts and per-building roof area back-solved (DERIVED) |
| CS-FIS | PARTIAL (dollars only) | 32 | 0 | 0 | 7 | 1 | 0 | 1 | 2 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 1 | 18 | CSSI gives dollars only (18 modeled allocation lines, no quantities); building description is from the owner's property notes, not the study |

**Re-verification against the underlying studies** (all six PDFs under `OneDrive\Business`, converted with `pdftotext`; Northwood re-OCR'd with `ocrmypdf --rotate-pages`; Fishel notes read from the .docx):
- **Allocations:** every study total and every class split (5/7/15/39-yr, ADS 9-yr) appears in its study text - Rarig, Broadway, Red Branch, Northwood (incl. $2,936 ADS 9-yr), Livingston, Fishel. Livingston's 5/15/39-yr splits are printed in the study itself (the report says they come from the tax register; both agree), so the basis note was corrected.
- **Facts:** 174 numeric, non-derived facts were checked for presence in their source text (years excluded); **169 were found as seeded**. The 5 misses were each traced: four cited the study but the value is in the proposal / contract (Broadway land allocation $1,232,257; Northwood $840,988; Livingston $649,900 and $320,100 - each confirmed in the proposal and **re-pointed in the data**), and one was an OCR digit error (Northwood CMU wall, below). After correction all 174 verify (170 in the study text + the 4 in their proposals). Acquisition-price arithmetic ties (e.g. 3,559,012 + 840,988 = 4,400,000).
- **Not independently re-verifiable:** the Fishel generator / HVAC / PIS items (D10), tenant lists (as-of-study history only), and the four tax-register-sourced PIS dates (read from the register, per instruction).


## Decisions / behavior changes for you

1. **KPI dollar totals, the near-term rollup, the reserve-intensity chart and the "Consultant lifecycle" card now exclude STALE (pre-2024) reports.**
   Previously "sum of most recent report per property" included 2007-2016 reports (e.g. Muirkirk's $210,420 short-term). This follows the rule that stale
   reports never feed forecasts or totals. It sits in tension with the 2026-10-07 ruling that "current = most recent report, no age cutoff": the
   register table still shows the newest report per property (stale ones badged STALE); only dollar totals and forecasts changed. Revert is one line in
   `applyPcaOverlay` / `PropertyConditionModule`.
2. **Calibration excludes stale PCA estimates** (New Plant 2016, E Fifth 2021) - the two headline pairs in the payload. They stay visible, greyed, with the
   reason. If you want historical estimator-vs-actual pairs counted regardless of how old the estimate is, that is a one-line change in `exclusionFor`.
3. **No hosted preview deploy was made.** The preview is local (`pca-web` :5293 / `pca-server` :8931, isolated from other sessions). A hosted preview would put
   internal property-condition data on a URL; the deployed mirror also has no live warehouse, so the register / schedule / quotes views would show the offline card
   (calibration, Building specs and the 29000 drill-down are static data and would render). Say the word and which target to use.
4. `package.json` (architect-owned) gained two scripts - `calibration:propose`, `calibration:promote` - flagged in `architecture/status.json`.
5. **Cost seg is its own basis, informational only.** Its quantities can reach `calibration_pending` as a candidate `qty` (flagged `COST_SEG_MODELED`) but never `observations.json` without an explicit promotion; nothing in module 10 touches reserves, the rollup, intensity or calibration statistics. The bridge found nothing to fill today (the one pending proposal already has a stated quantity, and Livingston's roof is ambiguous).
6. Open-issue status/owner are display defaults (Open / unassigned) - no write path (no Notion writes). `resolved_since` on findings is recorded by adding rows to
   `data/building-specs/resolutions.json`.

## Not done / out of scope

- The Notion branch of `calibration:propose` is untested against live Notion (no token in session).
- No migration: curated corrections live in `src/modules/property-condition/pca-overlay.ts` with provenance in the data; persisting them in the warehouse needs an
  architect-reviewed migration.
- Banwick roof quote documents, the E Fulton budget PDF and the PES PCA body for 1900 N Broadway were not located.
