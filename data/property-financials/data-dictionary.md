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

- **Normalized NOI** = revenue (excluding security-deposit receipts and unallocated prepays) minus recurring opex. Excludes capex, leasing commissions, TI, owner distributions, debt service, interest, depreciation and entity income tax. Do not substitute PM-reported NOI.
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
