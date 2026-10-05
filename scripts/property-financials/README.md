# Property Financials refresh pipeline (plan T9a)

Repeatable, tested rebuild of the Property Financials module's data:

```
raw P&L records (parser output, OneDrive)      ── normalize-raw.ts ──►  monthly-long.csv
monthly-long.csv + config/**                   ── build-dataset.ts ──►  dataset.json
dataset.json                                   ── server/property-financials loader ──► module
```

Adding an entity is **data only**: a row in `config/entities.json`, its rows in the CSV (and an entry in
`config/curated/sf.json`). The builder carries it through every block; the architect-owned contract
(`src/contracts/property-financials.ts`) is then the only gate (`tests/unit/property-financials-registry.test.ts`
proves both halves).

All logic is pure and lives in `src/analytics/property-financials/` (`pyfloat.ts`, `normalize.ts`,
`build-dataset.ts`, reusing T3's `aggregate.ts` and T2's `metrics.ts`). This folder holds only the CLIs,
their file IO (`lib/io.ts`) and the versioned configuration.

## Invocations (no npm scripts — `package.json` is architect-owned)

```powershell
# 1. raw records -> CSV   (reads $env:PF_RAW_RECORDS or --in; OneDrive is never written)
$env:PF_RAW_RECORDS = "C:\Users\Owner\OneDrive - Oxford Capital Partners\Business\Property Financials\outputs\_raw_monthly_records.json"
npx tsx scripts/property-financials/normalize-raw.ts                       # -> _out/monthly-long.csv + _out/normalize-report.json
npx tsx scripts/property-financials/normalize-raw.ts --in <raw.json> --out <dir> [--no-annual] [--mapping v1]

# 2. CSV -> dataset.json   (default input: the committed CSV; pass the fresh one to chain)
npx tsx scripts/property-financials/build-dataset.ts                                    # from data/property-financials/monthly-long.csv
npx tsx scripts/property-financials/build-dataset.ts --csv scripts/property-financials/_out/monthly-long.csv --generated 2026-11-03

# 3. tests (the real-raw reproduction test runs only when PF_RAW_RECORDS is set)
npx vitest run tests/unit/property-financials-pyfloat.test.ts tests/unit/property-financials-normalize.test.ts tests/unit/property-financials-build-dataset.test.ts tests/unit/property-financials-registry.test.ts
```

Exit codes: `0` built · `1` usage / IO error · `2` unmapped accounts (report printed, nothing written) ·
`3` built dataset fails the contract (nothing written).

**Nothing in `data/property-financials/` is ever written by a CLI.** Outputs go to `--out` (default
`_out/`, gitignored here) with a diff summary against the committed files; promotion is a reviewed manual
copy followed by the property-financials test files (reconcile / golden / build-dataset).

## Configuration (all versioned; change data, not code)

| File | Purpose |
|---|---|
| `config/account-mapping.v1.json` | account → (line_type, category) rules, first match wins, every hit audited by `id`; `excludedEntities` (Northwood patterns `2203`, `northwood`); the category lists. An account no rule matches **fails the run**. |
| `config/entities.json` | entity registry: id, label, kind (`monthly` / `annual`), source layout (`AF` AppFolio, `CF` Yardi cash-flow, `A12` 12-month recap, `QB` QuickBooks), same-store / FY-same-store / lease-up flags, warehouse `canonicalId` (read-only join hint). |
| `config/derivation.v1.json` | selection thresholds: account movers (`|Δ| ≥ 3,000` FY / `≥ 2,500` YTD), drivers (`|Δ| ≥ 1,500`, top 16). |
| `config/annual-statements.csv` | the 54 hand-normalised QuickBooks rows for 55 New Plant and 1851 South Club Solar, appended as-is (no QuickBooks statement parser exists yet — T9b). |
| `config/curated/*.json` | non-derived blocks carried verbatim: `meta.json` (titles, as_of, notes), `insights.json`, `leases.json`, `data_quality.json`, `sf.json` (Master Workbook square footage; the live 7-day-staleness read is T9b). Seeded from the committed `dataset.json` so nothing was lost. |

Period ids are derived from `meta.as_of` (`FY{Y-2}`, `FY{Y-1}`, `YTD{yy-1}`, `YTD{yy}`, `TTM{yy-1}`,
`TTM{yy}`, annual `YTD{yy}_partial_thru_<date>`); for `2026-09-30` they equal the contract's constants.
Rolling the year is a contract change (architect) plus `as_of` in `curated/meta.json`.

## What the normalizer does (and the documented sort)

1. Drop any record whose entity matches an `excludedEntities` pattern (reported as an excluded **entity**).
2. Skip total / subtotal rows (`isTotal`).
3. Fail if the entity is not in the registry.
4. First matching rule → mapped row (`sign: -1` negates; `-0` becomes `0`) or excluded (by rule id); no match → collected into the unmapped report → exit 2.
5. Rows sharing `(entity, period, line_type, category, source_account)` are summed to cents into one row (the same account label can sit under two statement groups and the CSV has no group column).
6. Zero-amount rows are kept (the cash-flow layouts print the full account grid monthly; the committed CSV carries 7,342 of them).
7. Sort: monthly-kind entities first, then annual-kind; within a block by `entity, period, line_type, category, source_account` in code-point order; ties keep input order.
8. Render: header `entity,period,line_type,category,source_account,amount_usd`, CRLF, RFC 4180 quoting, amounts in Python float repr (`141.0`, `1508.25`).

Rounding everywhere uses Python semantics (`pyfloat.ts`: round-half-to-even on the exact binary value), because the committed files were produced in Python and the tests require a byte-level / deep-equal reproduction.

## Reproduction status (2026-10-05)

* `monthly-long.csv`: **IDENTICAL** (15,493 rows: 15,439 monthly-entity rows from the raw export + 54 annual passthrough rows), verified by `normalize-raw.ts` and the gated test.
* `dataset.json`: **every block deep-equal** (meta, portfolio, properties, monthly, account_movers, history, sf, insights, leases, data_quality) and the output passes the strict contract. The only sanctioned difference is sign of zero: the committed file holds three Python `-0.0` literals that `JSON.stringify` cannot emit (pinned in the test, count = 3).

## Findings worth a ruling (reproduced for parity, not fixed here)

1. **9620 State 350, 2025-09 recap has no section headers; the reference mapped all 11 rows as revenue** — including `CAM - Grounds/Trash/Utilities`, `REPAIRS & MAINTENANCE`, `MANAGEMENT FEE EXPENSE` (the statement's own EXPENSE line, $REDACTED-AMT) and `Legal Fees`, `Bank Fees`, `Vacant Utilities` (its N/O EXPENSE line, $1,989.68). Rules `A12-NOSECTION-*` reproduce this so the CSV rebuilds exactly; the likely-correct treatment overstates 9620's 2025-09 revenue by $REDACTED-AMT and understates opex by $REDACTED-AMT (NOI overstated ≈ $6.5K — the same magnitude as the "$6.5K" 9620 FY2025 monthly-vs-annual difference already noted in `data_quality`). Fix = `account-mapping.v2.json` + re-promote; no code.
2. **Owner distribution signs differ by layout** (Yardi `ADJUSTMENTS/Owner Distributions` flipped to positive; AppFolio `Distribution to Owner` and Yardi `OWNER ACTIVITY` draws/contributions carried as reported, contributions negative). Already disclosed in `data_quality`; carried as-is.
3. **`history[id].yr[*].partial` is always `false` for monthly entities** even when `n < 12` (only the annual entities' partial statement sets it). Reproduced; consumers derive partial from `n` (the reconcile test pins this).

## Not built here (T9b)

* Source-layout parsers (statement files → raw records): the raw JSON is the output of the Python parsers; this pipeline starts from it. A QuickBooks statement parser would replace `annual-statements.csv`.
* Live Master Workbook SF read with the 7-day staleness label (replaces `curated/sf.json`).
* The monthly scheduled task proposal.
