# ORA Property Financials — Data Dictionary v01

Generated 2026-10-05 · As of 2026-09-30 · Basis: cash · Units: USD · Source: Business/Property Financials
Excluded: 2203-2207 Northwood (financials pending).

## Files

| File | Use |
|---|---|
| 2026-10-05_Property-Financials_Dataset_v01.json | Full normalized dataset (nested). Primary ingest. |
| 2026-10-05_Property-Financials_Monthly-Long_v01.csv | Flat table: entity, period, line_type, category, source_account, amount_usd. Load to a DB or warehouse. |
| Property Financials Review (artifact) | Human view of the same data and insights. |

## JSON top-level keys

| Key | Content |
|---|---|
| meta | title, version, generated, as_of, basis, units, periods (month lists), categories, excluded, noi_definition |
| portfolio.* | Same-store FY, TTM and YTD views: base_rent, reimbursements, revenue, opex, noi, capex, opex_by[category] |
| properties[id] | kind (monthly or annual); periods[period] with base_rent, vacancy_waivers, reimbursements, other_income, revenue, opex, noi, capex, dist, noi_margin, opex_ratio, mgmt_fee_pct, recovery_ratio, pool, opex_by{category}, n_months; yoy[comparison] with pct and dollar change by line and category; base_rent_runrate_q3 (q3_2024, q3_2025, q3_2026, yoy_2025, yoy_2026) |
| monthly[id][YYYY-MM] | base_rent, reimbursements, other_income, vacancy_waivers, revenue, opex, noi, capex, opex_by{category} |
| account_movers[id] | Account-level changes: category, account, prior, current, delta, pct |
| insights[] | id, severity (High/Medium/Low), type (revenue/recovery/expense), property, title, finding, action, annual_impact_usd, impact_basis, tags |
| leases[] | tenant, sf, term, rent schedule, escalator, source, confidence |
| data_quality[] | Known gaps and cautions |

## Periods

FY2024, FY2025, YTD25 and YTD26 (Jan–Sep), TTM25 (Oct 2024–Sep 2025), TTM26 (Oct 2025–Sep 2026). Month lists are in meta.periods.

## Definitions

- **Normalized NOI** = revenue (excluding security-deposit receipts and prepaid rent) minus recurring opex. Prepaid rent has one treatment for every source layout: AppFolio unallocated prepays and the Yardi cash-flow Prepaid Rental Income line are both excluded (v03.2). Excludes capex, leasing commissions, TI, owner distributions, debt service, interest, depreciation and entity income tax. Do not substitute PM-reported NOI.
- **Recovery ratio** = (recoveries + utility reimbursements) / (tax + insurance + utilities + grounds + R&M). Not meaningful for single-tenant NNN assets that pay taxes and insurance directly.
- **Base rent run-rate (Q3)** = average of Jul–Sep base rent × 12; yoy compares Q3 to Q3.
- **Same-store set** (PM monthly, full history): 1100 Rarig, 1900 N Broadway, 29000 Information Ln, 3540 E 5th, 9050 Red Branch, FVC; FY views add 55 New Plant and 1851 South Club Solar. Excluded from trend: 9620 State 350, 3034 Westerville, 3875-3883 Livingston (lease-up or partial history).
- **opex categories**: Real estate & property tax; Insurance; Management fees; Utilities; Grounds / snow / lot; Repairs & maintenance; Turnover / make-ready; Professional / admin.
- **Revenue categories**: Base rent; Vacancy / waivers / bad debt; Recoveries (CAM/tax/ins); Utility reimbursements; Other income; Solar / energy income.
- **Below-line keys**: capex, dist (owner distributions), debt, inctax, noncash, nonop.
- n_months below the period length means partial history: mark n/m, never annualize.

## Source layouts normalized

1. AppFolio-style consolidated P&L (amount column L).
2. 12-month Cash Flow Statements (Broadway, Info Lane, Red Branch).
3. 9620 State 350 12-month recap (expenses positive, nested sections).
4. QuickBooks entity statements (55 New Plant, 1851 South Club Solar). Annual only; 2026 rows run through 2026-06-12 and are labeled 2026-YTD(thru 2026-06-12) in the CSV.

Account-to-category mapping is by keyword on the source account name; the source_account column in the CSV preserves the original label for audit.

## Known gaps

- Cash basis: real estate tax, insurance and snow timing distorts single-period comparisons. Use FY or TTM; opex growth trends exclude real estate tax.
- Missing months: Westerville 2024-01..08 and 10; Livingston 2024-01..2025-05 and 2025-07; 9620 2024-01..08.
- FVC is a multi-property aggregate; property-level exports are needed.
- No square footage in the P&Ls; $/SF requires the Master Workbook.
- 55 New Plant and Solar have no monthly data after 2026-06-12.
- No P&L in the folder for 7658 Fishel or 401 Sunburst Highway (leases only).
- Lease OCR for 3540 E 5th is partial; 55 New Plant renewal clause and Sunburst addenda not read. Lease facts carry a confidence field.
- The Sepich HTML file was not parsed.

## Ingest instructions

1. Load the JSON as the property-financials module keyed by properties[id]; monthly[id][YYYY-MM] is the time series.
2. Surface insights[] as the exception queue sorted by severity then annual_impact_usd; assign an owner and due date to each.
3. Compare tax and insurance on FY or TTM only.
4. When the Master Workbook supplies SF, add sf per property and compute $/SF for rent, opex and NOI.
5. Replace the 2026 entity rows when monthly statements arrive; add Northwood when received.

## v02 addition: history (Dataset_v02.json)

`history[entity]` carries full-history data used by the Property explorer: `yr[year]` and `ytd[year]` (Jan–Sep) with br, rev, opex, noi, `cats` (opex by category), `rc` (revenue by category) and `n` months; `months` {g, br, rv, ox, tx} monthly series back to the first month on file (Broadway and Red Branch from 2015-09); `ev[]` net base-rent steps (persisted three months, at least 2% and $500 a month); `drv[period]` account-level drivers with `nat` = recurring, lumpy, mixed or annual (derived from monthly timing; a hypothesis, not proof). Years with n below 12 are partial and excluded from YoY math. Dataset_v01 is superseded by v02.

## v03 addition: square footage

Dataset_v03.json adds a top-level `sf` block and `sf`, `leased_sf`, `occupancy` on each property. Source: Master Excel Template Company Wide -- Oxford.xlsx, tabs Property NOI (total SF) and Master Tenant Rent Roll (Active tenants = leased SF), as of 2026-10-02.

| Property | SF | Leased SF | Occupancy |
|---|---|---|---|
| 1100 Rarig | 21,000 | 18,000 | 85.7% |
| 1900 N Broadway | 27,671 (500 common area) | 27,171 | 100% of leasable |
| 29000 Information Ln | 48,000 | 45,000 | 93.8% |
| 3034 Westerville | 18,360 | 18,360 | 100% |
| 3540 E 5th | 35,886 | 35,886 | 100% |
| 3875-3883 Livingston | 10,950 | 10,950 | 100% |
| 9050 Red Branch | 90,000 | 85,000 | 94.4% |
| 9620 State 350 | 34,300 | 28,555 | 83.3% |
| FVC (Sepich portfolio, inferred) | 109,657 | 93,697 | 85.4% |
| 55 New Plant | 34,534 | 34,534 | 100% |
| 7658 Fishel / 401 Sunburst | 24,000 / 5,100 | same | no P&L in folder |

Leased SF = rent-roll rows classed "Occupied" (vacant, notice-given and expired space excluded). Occupancy ties to the Property NOI tab for every property listed.

Rules: $/SF = period amount / current total SF (not annualized for 9-month periods). FVC mapping rests on SF-sum and rent reconciliation (rent roll annualized $1.05M vs FVC TTM base rent $1.12M); confirm. Northwood (53,700 SF) is excluded pending financials. Dataset_v03 supersedes v02.

## v03.1 correction: 9620 State 350, 2025-09 (2026-10-05)

Gabriel ruled on 2026-10-05 to promote the re-parsed 2025-09 single-month recap for 9620 State 350. The original export read that recap with no section headers and booked all 11 lines as revenue. The statement parser reads INCOME / EXPENSE / N/O EXPENSE, so CAM grounds, trash and utilities, repairs and maintenance, the management fee, legal fees, bank fees and vacant utilities ($6,537.61 in total) are now opex. The management fee ($2,450) is filed under Management fees, the same as every other 9620 month (mapping v2 rule `A12-EXP-MGMT-ANY-GROUP`).

| 9620 State 350 | Revenue (before → after) | Opex (before → after) | NOI (before → after) |
|---|---|---|---|
| 2025-09 | 23,772.66 → 17,235.05 | 0.00 → 6,537.61 | 23,772.66 → 10,697.44 |
| FY2025 | 191,602.76 → 185,065.15 | 152,163.75 → 158,701.36 | 39,439.01 → 26,363.79 |
| TTM25 (2024-10..2025-09) | 156,667.39 → 150,129.78 | 209,159.57 → 215,697.18 | -52,492.18 → -65,567.40 |
| YTD25 (Jan–Sep) | 132,875.11 → 126,337.50 | 68,391.71 → 74,929.32 | 64,483.40 → 51,408.18 |
| TTM26 (2025-10..2026-09) | 268,388.28 (unchanged) | 148,685.77 (unchanged) | 119,702.51 (unchanged) |

FY2025 revenue now ties to the annual file to the cent. FY2025 opex ties to the annual file except management fees: the monthly recaps sum to $14,400 and the annual file shows $13,150. The dependent blocks move with these figures: yoy, monthly, account_movers, history (yr, ytd, months, drv). 9620 is excluded from same-store, so no portfolio or same-store figure changes, and no other entity changes. `meta.version` stays `v03` because the contract requires two digits; this note records the correction.

## v03.2 prepaid-rent: one treatment for every layout (2026-10-06)

Gabriel ruled on 2026-10-06 that prepaid rent is excluded from revenue and NOI for every source layout, matching the NOI definition. AppFolio `Unallocated Prepays` was already excluded. The Yardi cash-flow line `RENTAL REVENUE › Prepaid Rental Income` had been counted as contra-revenue under "Vacancy / waivers / bad debt"; account mapping v3 (`CF-RENTAL-REVENUE-PREPAID`) now excludes it. Only 1900 Broadway and 9050 Red Branch carry that line: 133 monthly rows each (2015-09 to 2026-09), 266 rows in total, removed from monthly-long.csv (15,493 to 15,227 rows). Over the whole history it nets to +$444.65 (Broadway) and +$373.02 (Red Branch), but single months swing by up to $27.8K, so period figures move. 29000 Info Lane records prepaid rent only as a balance-sheet adjustment (`ADJUSTMENTS › Prepaid Rent`), which was already excluded, so it does not change.

| Entity · period | Revenue (before → after) | NOI (before → after) |
|---|---|---|
| 1900 Broadway · FY2024 | 702,781.99 → 701,442.29 | 360,191.35 → 358,851.65 |
| 1900 Broadway · FY2025 | 649,787.70 → 651,127.40 | 365,562.20 → 366,901.90 |
| 1900 Broadway · YTD25 | 499,226.76 → 500,566.46 | 269,739.74 → 271,079.44 |
| 1900 Broadway · YTD26 | 516,326.45 → 515,881.80 | 286,943.56 → 286,498.91 |
| 1900 Broadway · TTM26 | 666,887.39 → 666,442.74 | 382,766.02 → 382,321.37 |
| 9050 Red Branch · FY2024 | 1,141,704.85 → 1,142,775.80 | 837,125.45 → 838,196.40 |
| 9050 Red Branch · FY2025 | 1,251,546.82 → 1,258,493.71 | 905,389.70 → 912,336.59 |
| 9050 Red Branch · YTD25 | 949,092.31 → 956,407.99 | 684,622.46 → 691,938.14 |
| 9050 Red Branch · YTD26 | 995,822.41 → 996,070.87 | 691,631.56 → 691,880.02 |
| 9050 Red Branch · TTM26 | 1,298,276.92 → 1,298,156.59 | 912,398.80 → 912,278.47 |

Base rent, reimbursements, opex and capex do not change for either property. Revenue and NOI move by the same amount in every period.

| Portfolio view | Revenue prior / current (before → after) | NOI prior / current (before → after) | NOI change |
|---|---|---|---|
| Same-store FY2025 vs FY2024 | 5,175,501.67 / 5,317,079.29 → 5,175,232.92 / 5,325,365.88 | 3,893,486.78 / 3,970,362.29 → 3,893,218.03 / 3,978,648.88 | +1.97% → +2.19% |
| PM-only FY2025 vs FY2024 (Overview NOI KPI) | 4,079,752.71 / 4,312,468.54 → 4,079,483.96 / 4,320,755.13 | 2,858,166.71 / 3,040,402.43 → 2,857,897.96 / 3,048,689.02 | +6.38% → +6.68% |
| Same-store TTM26 vs TTM25 | 4,299,142.34 / 4,417,246.81 → 4,303,396.92 / 4,416,681.83 | 2,928,602.26 / 3,161,129.40 → 2,932,856.84 / 3,160,564.42 | +7.94% → +7.76% |
| Same-store YTD26 vs YTD25 | 3,254,493.61 / 3,359,271.88 → 3,263,148.99 / 3,359,075.69 | 2,288,999.02 / 2,409,725.99 → 2,297,654.40 / 2,409,529.80 | +5.27% → +4.87% |

Same-store base rent (+2.6% Jan–Sep) and opex excluding real estate tax (+6.6%) are unchanged. The FY2024 and FY2025 annual Yardi statements still tie to the monthly CSV to the dollar, because the annual files carry the same line and the same rule excludes it. The dependent blocks move with these figures: yoy, monthly, history (yr, ytd, rc, months, drv). Two curated insights were restated (REV-05 Red Branch contra-revenue: FY2025 $64.0K to $57.0K, TTM $33.7K to $33.8K, annual impact 33,685 to 33,805; REV-04 Broadway waivers: $13.8K / 2.8% to $14.3K / 2.9% TTM). No other entity changes. `meta.version` stays `v03` because the contract requires two digits; this note records the change.
