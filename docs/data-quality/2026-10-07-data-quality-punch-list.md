# Data Quality Punch List — 2026-10-07

Source: `data/snapshots/portfolio.json` `dataQuality[]` (14 flags) + System Health › Data Feeds (3 need attention).
Every item is a **source-data gap** the Command Center is correctly reporting. Fixes go in the Master Workbook / QuickBooks, not in code (no values are guessed here). Tick a box when the workbook is corrected; the next snapshot refresh clears the flag.

## A. Insurance — Renewals rows not rolled (4 × warn)

Rolling the Renewals row to the current term also clears the matching "no 2025 Premium History row" info flag for that policy, because the join key moves to the new policy year (a 2026 history row is then what is needed).

- [ ] **ETC POA** — Airport Road, Easton MD (Erie): term ended 2026-04-05. Roll Renewals row; add 2026 Premium History row.
- [ ] **1100 Rarig Ave**, Columbus OH (Erie): term ended 2026-03-19. Roll Renewals row; add 2026 Premium History row.
- [ ] **9050 Red Branch Rd**, Columbia MD (Erie): term ended 2026-08-31. Roll Renewals row; add 2026 Premium History row.
- [ ] **3034 Westerville Rd**, Columbus OH (Erie): term ended 2026-09-18. Premium History row 12 already carries 2026-27 — only the Renewals row needs rolling.

Need from you: the current dec pages / binders (carrier, effective, expiry, premium, building limit) for the four terms.

## B. Insurance — TIV unavailable (info, current term)

- [ ] **29000 Info** — add 2025 Premium History row with the building limit from the declaration.
- [ ] **2203 Northwood** — add 2025 Premium History row with the building limit.
- [ ] **55 Newplant** — Premium History row 27 exists but its building limit is blank for 2026; fill it.

## C. Insurance — caveat (warn)

- [ ] **FVC package** — the TIV comes from Premium History row 20 whose basis note says "reconstructed (base declaration missing)". Clears only if the base declaration is located and the basis note updated.

## D. Rent roll — stale "Active" rows (2 × warn)

- [ ] **2207 Northwood A8 — Person 017 (Tenant 038 LLC)**: lease ended 2024-09-01, still "Active". Retire the row or record the renewal.
- [ ] **2207 Northwood C4 — Tenant 059 LLC**: lease ended 2024-09-01, still "Active". Retire the row or record the renewal.

Decision needed: vacated, holdover, or renewed? (Affects occupancy and rent roll NOI.)

## E. Debt — affiliate basis gap (1 × warn)

Property NOI sheet affiliate-lender rows exceed the loan schedule's affiliate-borrower loans → a **material gap** (amounts in the live workbook, not repeated here).

- [ ] Either add the missing affiliate loans to the loan schedule, **or** confirm the gap is expected (e.g. affiliate notes carried on property rows but intentionally off the loan schedule) so the check can be made tolerant by a ratified rule. Per the 2026-09-24 ruling affiliate notes are excluded from investment debt/LTV either way.

## F. Data feeds

- [ ] **AR aging (84d, max 35d)** — run the QuickBooks AR export, then `ar-import-headless`. (Needs QB Desktop; not automatable from here.)
- [ ] **Daily brief (87d, max 1.5d)** — status 2026-10-07: producer is the hourly Windows task "ORA Command Center - Mirror Deploy" (runs `runBrief` in the isolated build root and now writes `data/brief-health.json` to the checkout, PR #439). The 14:00 run exited 1 ("build:mirror failed (1)"); bake and build both pass when run by hand, so treat as transient unless the 15:00/16:00 runs also fail.
- [x] **Document index (122d, max 30d)** — `npm run index:docs -- --replan` started 2026-10-07 (a plain run is a no-op once the plan is complete).
- [x] **Weekly snapshot refresh** — `ora-cc-snapshot-refresh` re-enabled 2026-10-07; next fire Mon 2026-10-12 06:15 ET.
