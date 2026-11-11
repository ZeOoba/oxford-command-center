# Property Financials refresh pipeline (plan T9a + T9b)

Repeatable, tested rebuild of the Property Financials module's data:

```
statement files (OneDrive, read-only)           ── parse-sources.ts ──►  _out/raw-records.json (+ parse-report.json)
raw P&L records                                 ── normalize-raw.ts ──►  monthly-long.csv
monthly-long.csv + config/**                    ── build-dataset.ts ──►  dataset.json
dataset.json                                    ── server/property-financials loader ──► module
Spine A snapshot (live Master Workbook parse)   ── server/property-financials/live-sf.ts ──► GET /dataset `liveSf` (SF, leased SF, occupancy)
```

**`monthly-long.csv` is LOCAL-ONLY (Gabriel ruling 2026-10-06).** The GL-level audit layer is gitignored and was
purged from branch history: the repo's pre-push confidential scan blocks CSVs under `data/`. `dataset.json` and
`data-dictionary.md` stay committed. A fresh clone or a hosted CI checkout therefore has no CSV: regenerate it with
steps 1–2 below (`normalize-raw.ts`) and copy `_out/monthly-long.csv` to `data/property-financials/`. Without it the
server still serves the dataset (the data-health panel says "Audit CSV not present on this machine"), every test
that needs the CSV skips with a visible `monthly-long.csv not present (...)` marker, and `build-dataset.ts` exits `2`
with the same instruction unless `--csv` names a file. Mentions of "the committed CSV" below that predate the
ruling mean this local copy.

Adding an entity is **data only**: a row in `config/entities.json`, its folder in `config/sources.json`, its
rows in the CSV (and an entry in `config/curated/sf.json`). The builder carries it through every block; the
architect-owned contract (`src/contracts/property-financials.ts`) is then the only gate
(`tests/unit/property-financials-registry.test.ts` proves both halves).

All logic is pure and lives in `src/analytics/property-financials/` (`parse-statements.ts`, `pyfloat.ts`,
`normalize.ts`, `build-dataset.ts`, `live-sf.ts`, reusing T3's `aggregate.ts` and T2's `metrics.ts`). This folder
holds only the CLIs, their file IO (`lib/io.ts`, `lib/excel.ts`, `lib/sources.ts`) and the versioned configuration.

## Invocations (no npm scripts — `package.json` is architect-owned)

```powershell
# 0. (once per refresh, binary .xls only) convert AppFolio .xls exports to .xlsx — needs desktop Excel; see "Binary .xls exports"
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/property-financials/convert-xls.ps1 `
  -SourceDir "C:\Users\Owner\OneDrive - Oxford Capital Partners\Business\Property Financials\Property Management P&Ls" `
  -OutDir "$env:LOCALAPPDATA\ora\pf-converted"
$env:PF_CONVERTED_DIR = "$env:LOCALAPPDATA\ora\pf-converted"

# 1. statement files -> raw records   (reads $env:PF_SOURCE_DIR or config/sources.json's default; OneDrive is never written)
npx tsx scripts/property-financials/parse-sources.ts                                 # -> _out/raw-records.json + parse-report.json + crosscheck-records.json
npx tsx scripts/property-financials/parse-sources.ts --source <dir> --converted <dir> --out <dir> [--mapping vN]

# 2. raw records -> CSV
npx tsx scripts/property-financials/normalize-raw.ts --in scripts/property-financials/_out/raw-records.json   # -> _out/monthly-long.csv + _out/normalize-report.json
npx tsx scripts/property-financials/normalize-raw.ts --in <raw.json> --out <dir> [--no-annual] [--mapping vN]

# 3. CSV -> dataset.json   (default input: the local data/property-financials/monthly-long.csv; pass the fresh one to chain)
npx tsx scripts/property-financials/build-dataset.ts
npx tsx scripts/property-financials/build-dataset.ts --csv scripts/property-financials/_out/monthly-long.csv --generated 2026-11-03

# 4. tests. The ground-truth parse of the real exports is OPT-IN: it runs only with PF_GROUND_TRUTH=1 (or an
#    explicit PF_SOURCE_DIR); the real-raw normalize test only with PF_RAW_RECORDS. Without the switch each prints a
#    visible SKIPPED placeholder naming it, so a routine gate / CI run never opens the OneDrive tree (60+ workbooks,
#    180 s budget) and a new P&L dropped in the folder cannot turn the gate red. The CSV-backed suites (reconcile,
#    build-dataset, registry 12th-entity, partial-yoy refute repro) need the local-only monthly-long.csv and skip with
#    a visible marker without it. To exercise that skip path on a machine that has the CSV, point
#    PROPERTY_FINANCIALS_DIR at a copy of data/property-financials holding only dataset.json.
$env:PF_GROUND_TRUTH = "1"        # add PF_CONVERTED_DIR (step 0) to cover the binary .xls exports too
npx vitest run tests/unit/property-financials-parse-statements.test.ts tests/unit/property-financials-parse-sources.test.ts tests/unit/property-financials-pyfloat.test.ts tests/unit/property-financials-normalize.test.ts tests/unit/property-financials-build-dataset.test.ts tests/unit/property-financials-registry.test.ts tests/unit/property-financials-live-sf.test.ts
```

Exit codes: `0` built · `1` usage / IO / parse error (a parse failure names file › sheet › row; nothing written) ·
`2` unmapped accounts (report printed, nothing written), or (build-dataset) the input CSV is not present · `3` built dataset fails the contract (nothing written) ·
`4` (parse-sources) outputs written but one or more files were unreadable / unsupported — the raw records are
incomplete until each named file is converted or ruled out.

**Nothing in `data/property-financials/` is ever written by a CLI.** Outputs go to `--out` (default
`_out/`, gitignored here) with a diff summary against the files in `data/property-financials/` (`dataset.json`
committed, `monthly-long.csv` local-only); promotion is a reviewed manual copy followed by the property-financials test files (reconcile / golden / build-dataset).

## Configuration (all versioned; change data, not code)

| File | Purpose |
|---|---|
| `config/sources.json` | where the statement files live (`sourceDirDefault`, `$PF_SOURCE_DIR`), which PM folder feeds which entity in which layout, the `P&L <year>[ YTD] -- <entity>` file pattern, which extensions are readable and which need conversion. A folder / file whose entity matches an `excludedEntities` pattern (Northwood) is never opened. |
| `config/account-mapping.v3.json` | **current default.** v2 byte-identical (same rules, same order) + `CF-RENTAL-REVENUE-PREPAID`, placed ahead of `CF-RENTAL-REVENUE-CONTRA`: the Yardi cash-flow `RENTAL REVENUE › Prepaid Rental Income` line is EXCLUDED, like AppFolio `Unallocated Prepays` (Gabriel ruling 2026-10-06 — one prepaid-rent treatment for every layout; dataset v03.2). Pinned by `tests/unit/property-financials-mapping-v3.test.ts`. |
| `config/account-mapping.v2.json` | account → (line_type, category) rules, first match wins, every hit audited by `id`; `excludedEntities` (Northwood patterns `2203`, `northwood`); the category lists. v2 = v1 byte-identical for AF / CF / A12 + the `QB-*` QuickBooks rules (reproduce `annual-statements.csv`) + `CF-OWNER-CASH-BALANCE` (cash-balance lines on the annual Yardi export, cross-check files only). Superseded by v3; still loadable with `--mapping v2`. The CLIs default to the highest version present. An account no rule matches **fails the run**. |
| `config/account-mapping.v1.json` | kept verbatim: the version the committed CSV was reproduced with (T9a). |
| `config/entities.json` | entity registry: id, label, kind (`monthly` / `annual`), source layout (`AF` AppFolio, `CF` Yardi cash-flow, `A12` 12-month recap, `QB` QuickBooks), same-store / FY-same-store / lease-up flags, warehouse `canonicalId` (read-only join hint). |
| `config/derivation.v1.json` | selection thresholds: account movers (`|Δ| ≥ 3,000` FY / `≥ 2,500` YTD), drivers (`|Δ| ≥ 1,500`, top 16). |
| `config/annual-statements.csv` | the 54 hand-normalised QuickBooks rows for 55 New Plant and 1851 South Club Solar. Since T9b the QuickBooks statements are PARSED (`QB` layout) and reproduce these rows exactly; `normalize-raw.ts` appends the CSV only for an annual entity absent from the raw records (fallback). |
| `config/curated/*.json` | non-derived blocks carried verbatim: `meta.json` (titles, as_of, notes), `insights.json`, `leases.json`, `data_quality.json`, `sf.json` (the STATIC Master Workbook square footage read of 2026-10-02 — the fallback when the live read is unavailable or stale; see "Live square footage"). |

Period ids are derived from `meta.as_of` (`FY{Y-2}`, `FY{Y-1}`, `YTD{yy-1}`, `YTD{yy}`, `TTM{yy-1}`,
`TTM{yy}`, annual `YTD{yy}_partial_thru_<date>`); for `2026-09-30` they equal the contract's constants.
Rolling the year is a contract change (architect) plus `as_of` in `curated/meta.json`.

## Source layouts (parse-statements.ts) and what each parser enforces

Every parser emits raw records `[entity, period, layout, section, group, account, amount, isTotal]`, verifies the
statement's own totals (group totals and section totals) against the accounts it read to the cent, and throws a
`StatementParseError` naming file › sheet › row (and month) on anything it cannot classify. Nothing is skipped
silently: unknown layouts, unreadable files, unsupported extensions and excluded entities are all NAMED in
`parse-report.json`.

| Layout | Files | What the parser reads |
|---|---|---|
| `AF` AppFolio consolidated P&L | `Property Management P&Ls/<property>/ProfitLoss_*.xls` (binary — see below), `P&L <year> -- <entity>.xlsx` (annual, cross-check only) | one period from the row-3 dateline (`10/01/23 - 10/31/23` → `2023-10`; whole year → `YYYY-FY`; Jan-1-anchored → `YYYY-YTD(thru …)`), amount from the `Amount` column; labels found per row (AppFolio shifts them between exports); 5-space group / 10-space account by indent, group-level lines with an amount are accounts (Unallocated Prepays, MANAGEMENT FEE EXPENSE); two-row `TOTAL` on the annual export read once; `NET INCOME SUMMARY` block ignored. |
| `CF` Yardi 12-month statement | `12_Month_Statement_*_Cash*.xlsx` (12-month, 11-month, single-month) and `P&L <year> -- <entity>.xlsx` for Broadway / Info Lane / Red Branch (annual "Cash Flow Statement", cross-check only) | month columns from row 5 (Total column ignored; single-month files take the month from the `Period =` line and column B; the annual variant takes the Period-to-Date column); indentation is NOT trusted (accounts sit at 4 or 6 spaces, headers at 1 or 4): a computed label (`TOTAL …`, `NET …`, `CASH FLOW`, `INCOME AFTER …`) is a total, a label with no numbers is a header — ALL-CAPS → group, mixed case → ignored and reported (`TAXES and RESERVES`, which the reference parser also never promoted; the v1/v2 rule `CF-MAINT-RE-TAX` relies on Real Estate Taxes staying under MAINTENANCE EXPENSES) — anything else with numbers is an account; blank month cells are 0; an export reading `No activity for given filter criteria` is an EMPTY statement, reported as such. |
| `A12` AppFolio 12-month recap | `Property Management P&Ls/9620 State 350/ProfitLoss12MonthRecap_*.xls` (binary) | month columns from the row-5 labels (`OCT 25`; column gaps; `TOTAL` skipped; a merged header replicated across two columns read once); sections `INCOME` / `EXPENSE` / `N/O EXPENSE` (normalised to `NON OPERATING EXPENSE`); expenses positive; blank total cells are zero totals. |
| `QB` QuickBooks entity statement | `P&L <year> -- 55 New Plant (EGFLLC).xlsx`, `P&L <year> -- 1851 South Club Solar.xlsm` | a tree by column depth: a label without an amount is a header, `Total X` closes it (and is verified), section = nearest `Income` / `Expense` / `Other Income` / `Other Expense` header, group = a nearer parent account (`Tax`, `Bank Service Charges`); period from `Jan - Dec 24` → `2024-FY`, `Jan 1 - Jun 12, 26` → `2026-YTD(thru 2026-06-12)`. |

Not parsed, by design and named in the report: the AppFolio "Cash Flow" annual variant (`P&L 2025 -- 9620 State
350.xlsx`, `P&L 2026 YTD -- 9620 State 350.xlsx`), the Sepich `ProfitLoss_….html` export, the Northwood PDFs.

### Binary .xls exports — RESOLVED 2026-10-05: keep the Excel-COM conversion step

186 of the 246 statement files (every AppFolio monthly P&L for 1100 Rarig, 3034 Westerville, 3540 E 5th,
3875-3883 Livingston and the Sepich portfolio, and the three 9620 recaps) are TRUE binary `.xls` (OLE2 / BIFF8).
The only spreadsheet reader installed is `exceljs`, which reads `.xlsx` / `.xlsm` only, and `package.json` is
architect-owned, so this pipeline does not read them directly. The AF and A12 parsers are therefore written
against the pure `SheetSource` interface (rows of cells) and fully unit-tested on synthetic sheets; to run them
on the real exports Gabriel chose option 1 on 2026-10-05 (the alternatives are kept for the record):

1. **Conversion step (implemented, needs desktop Excel):** `convert-xls.ps1` opens each `.xls` read-only via
   Excel COM (macros force-disabled, Office File Validation skipped — 21 of the exports fail validation otherwise;
   the Mark-of-the-Web is removed on a staging COPY, never on OneDrive) and writes `<folder leaf>__<basename>.xlsx`
   to `--converted` / `$PF_CONVERTED_DIR`. `parse-sources.ts` reads the twin and records `readFrom:
   converted:<file>` per file. All 186 converted on 2026-10-05; this is how the coverage below was verified.
2. **LibreOffice headless** (`soffice --convert-to xlsx`) — not installed on this machine; same twin naming.
3. **An approved reader dependency** (`xlsx` / SheetJS or `node-xlsx`) in `package.json` — architect approval; the
   `SheetSource` seam means only `lib/excel.ts` would change.

A refresh without the conversion step reports every `.xls` as UNREADABLE and exits 4; it never guesses.

## What the normalizer does (and the documented sort)

1. Drop any record whose entity matches an `excludedEntities` pattern (reported as an excluded **entity**).
2. Skip total / subtotal rows (`isTotal`).
3. Fail if the entity is not in the registry.
4. First matching rule → mapped row (`sign: -1` negates; `-0` becomes `0`) or excluded (by rule id); no match → collected into the unmapped report → exit 2.
5. Rows sharing `(entity, period, line_type, category, source_account)` are summed to cents into one row (the same account label can sit under two statement groups and the CSV has no group column).
6. Zero-amount rows are kept (the cash-flow layouts print the full account grid monthly; the committed CSV carries 7,342 of them).
7. Sort: monthly-kind entities first, then annual-kind; within a block by `entity, period, line_type, category, source_account` in code-point order; ties keep input order.
8. Render: header `entity,period,line_type,category,source_account,amount_usd`, CRLF, RFC 4180 quoting, amounts in Python float repr (`123.0`, `1234.25`).

Rounding everywhere uses Python semantics (`pyfloat.ts`: round-half-to-even on the exact binary value), because the committed files were produced in Python and the tests require a byte-level / deep-equal reproduction.

## Reproduction status

### T9a (2026-10-05, from the reference raw export)

* `monthly-long.csv`: **IDENTICAL** (15,493 rows: 15,439 monthly-entity rows from the raw export + 54 annual passthrough rows), verified by `normalize-raw.ts` and the gated test.
* `dataset.json`: **every block deep-equal** and the output passes the strict contract. The only sanctioned difference is sign of zero: the committed file holds three Python `-0.0` literals that `JSON.stringify` cannot emit (pinned in the test, count = 3).

### T9b parser coverage (2026-10-05, from the statement files themselves; `tests/unit/property-financials-parse-sources.test.ts`)

246 files parsed (60 `.xlsx`/`.xlsm` natively + 186 `.xls` via the conversion step); 3 excluded (Northwood, never
opened); 5 unsupported (named above); 1 duplicate period (FVC 2023-07 in two files, identical, kept once); 1 empty
export (Info Lane Oct 2019–Sep 2020). Normalised with mapping v2 and compared to the committed `monthly-long.csv`
per entity + period, $0.005 tolerance:

| Entity | Layout | Periods verified | Note |
|---|---|---|---|
| 1100 Rarig | AF (converted .xls) | 36 / 36 (2023-10 .. 2026-09) | |
| 1900 Broadway | CF | 133 / 133 (2015-09 .. 2026-09) | |
| 29000 Info Lane | CF | 72 / 72 (2020-10 .. 2026-09) | |
| 3034 Westerville | AF (converted .xls) | 24 / 24 | |
| 3540 E 5th | AF (converted .xls) | 56 / 56 | |
| 3883 Livingston | AF (converted .xls) | 15 / 15 | |
| 9050 Red Branch | CF | 133 / 133 | |
| 9620 State 350 | A12 (converted .xls) | 25 / 25 | 2025-09 corrected and promoted 2026-10-05 (v03.1, below) |
| FVC | AF (converted .xls) | 51 / 51 | |
| 55 New Plant (EGFLLC) | QB | 3 / 3 (2024-FY, 2025-FY, 2026-YTD thru 2026-06-12) | reproduces `annual-statements.csv` |
| 1851 South Club Solar | QB | 3 / 3 | reproduces `annual-statements.csv` |

Against the reference Python raw export (non-total records, monthly entities): identical for every covered
entity/period except (a) 9620 2025-09 (the reference read it with no sections) and (b) 9620 `Commissions Expense`, where the reference carried the
EXPENSE section's last group into the first N/O EXPENSE account (the parser resets the group at a section header;
no mapping rule keys on that group, so the CSV ties).

Cross-check (annual statements of monthly entities vs the sum of their CSV months, in `parse-report.json`): every
FY2024 and FY2025 annual AppFolio / Yardi statement ties to the dollar for rev / opex / capex / dist / debt (Broadway
2025 opex within $1 rounding). The 2026 files are partial-year exports with mixed cut-offs (the Broadway /
Livingston / FVC ones are labelled Jan–Dec yet hold Jan–Jun data) and are informational only.

### 9620 State 350, 2025-09 — corrected and PROMOTED 2026-10-05 (Gabriel ruling; dataset v03.1)

The single-month recap for 2025-09 prints every label in column C, including the section headers. The reference
parser read sections from column A only, saw none, and the v1 rules `A12-NOSECTION-*` map the 11 rows as revenue
(T9a finding 1). The T9b parser finds the label column per row and reads `INCOME` / `EXPENSE` / `N/O EXPENSE`,
so for 2025-09 those lines move out of revenue (CAM − Grounds / Utilities / Trash, REPAIRS & MAINTENANCE, MANAGEMENT FEE
EXPENSE, Legal Fees, Bank Fees, Vacant Utilities become opex): revenue falls and opex rises by the same amount, and
NOI falls by twice that amount versus the reference's figures. Promoted on 2026-10-05: the rebuild differed from the previous committed files only under
`9620 State 350` (FY2025 / YTD25 / TTM25, yoy, monthly, movers, history; TTM26 unchanged); 9620 is
lease-up-excluded so no portfolio view moved. The recap's MANAGEMENT FEE EXPENSE line sits under the carried
`5500 CAM EXPENSES` group, so mapping v2 gained `A12-EXP-MGMT-ANY-GROUP` to file it as Management fees like
every other month. The committed CSV now ties to the statements everywhere (the gated test has no known
differences); before/after figures are in `data/property-financials/data-dictionary.md` (v03.1 correction).

### Prepaid rent, one treatment for every layout — PROMOTED 2026-10-06 (Gabriel ruling; dataset v03.2, mapping v3)

Before v3 the AppFolio `Unallocated Prepays` line was excluded (`AF-INC-UNALLOCATED-PREPAYS`) while the Yardi
cash-flow `RENTAL REVENUE › Prepaid Rental Income` line was revenue under "Vacancy / waivers / bad debt"
(`CF-RENTAL-REVENUE-CONTRA`). v3 excludes the Yardi line too. It exists only for 1900 Broadway and 9050 Red Branch
(133 rows each, 2015-09..2026-09; a small net amount over the whole history, but swinging by tens of thousands of
dollars in a month). 29000 Info Lane carries its prepaid rent only as `ADJUSTMENTS › Prepaid Rent`, already excluded by
`CF-ADJ-BALANCE-SHEET`, so it does not move. The rebuild removed exactly those 266 CSV rows (15,493 → 15,227) and
differed from the committed dataset only under Broadway, Red Branch and the four same-store / PM-only portfolio
views (revenue and NOI only; base rent, reimbursements, opex and capex unchanged). The FY2024 / FY2025 Yardi annual
statements still tie to the monthly CSV to the dollar (the annual files carry the same line, excluded by the same
rule). Before/after figures: `data/property-financials/data-dictionary.md` (v03.2).

## Live square footage (T9b part 2; `server/property-financials/live-sf.ts`, `src/analytics/property-financials/live-sf.ts`)

`GET /api/warehouse/property-financials/dataset` now carries an additive `liveSf` block next to the unchanged,
validated dataset. It is built from the Spine A `PortfolioSnapshot` the Brain Server already holds (the live Master
Workbook parse — no second workbook parser, no file read, no write), entity → canonical id via the ratified table in
`mapping.ts`:

| Field | Live source | Fallback |
|---|---|---|
| `sf` | `Property.sf` (Property NOI sheet) | dataset `sf[id].sf` (static read of 2026-10-02) |
| `occupancy` | `Property.occPct` | dataset `occ` |
| `tenants` | count of leased leases (else `Property.tenantCount`) | dataset `tenants` |
| `leasedSf` | Σ `Lease.sf` with status `Active` or `Expiring Soon` for the property | dataset `leased_sf` |

Spine A has no "Occupied" class (the rent roll's status column yields Active / Expiring Soon / Expired / Vacant /
Unknown), so notice-given space counts as leased in the live figure until the roll re-statuses it — the static
dataset excluded Red Branch's 5,000 SF by hand. The block says so in `leasedSfBasis`.

Freshness canon: `stale` when the workbook's as-of date (`snapshot.meta.asOf`) is more than **7 days** behind
today. No snapshot → `source: 'static-dataset'`, label `static dataset (2026-10-02)`. The client applies the ONE
preference rule in `PropertyFinancialsModule` (`applyLiveSf`): live values replace the dataset's SF / leased SF /
occupancy only when the block is present, Spine A and fresh, so every view and `perSf` keep reading `dataset.sf`
unchanged; a stale live read is shown in the data-health panel ("Square footage source") but never divides a
figure. The entity → canonical mapping for FVC is inferred and flagged; the solar entity has no SF (n/a).

## Findings worth a ruling (reproduced for parity, not fixed here)

1. **9620 State 350, 2025-09 recap** — RESOLVED 2026-10-05: corrected figures promoted (see above).
2. **Owner distribution signs differ by layout** (Yardi `ADJUSTMENTS/Owner Distributions` flipped to positive; AppFolio `Distribution to Owner` and Yardi `OWNER ACTIVITY` draws/contributions carried as reported, contributions negative). Already disclosed in `data_quality`; carried as-is.
3. **`history[id].yr[*].partial` is always `false` for monthly entities** even when `n < 12` (only the annual entities' partial statement sets it). Reproduced; consumers derive partial from `n` (the reconcile test pins this).
4. **Binary .xls reader** — RESOLVED 2026-10-05: keep the Excel-COM conversion step.
5. **Live leased SF basis** — RESOLVED 2026-10-05: keep Active + Expiring Soon, labelled (`leasedSfBasis`).

## Scheduled refresh

Proposed, NOT registered: `docs/superpowers/plans/2026-10-05-property-financials-refresh-task-proposal.md`.
