# WITHDRAWN — OI-092 debt-service detector, first attempt (2026-08-05)

**This is not live code.** It is preserved as a record of a design that was built, reviewed, and
**withdrawn before shipping**, so the retry does not rebuild the same shape. Nothing here is wired
into `parse.ts`; `tsconfig` (`include: ['src','tests/unit']`) and `vitest` do not pick it up, and
`eslint` passes over it cleanly. Do not import from this directory.

## Why it was withdrawn

The draft detects the OI-092 defect by **counting payment rows in a window**. That cannot work:

> A count-in-window check computes its *own* correct window and counts schedule rows against it, so
> it never observes the formula that carried the bug. Revert the workbook window to `TODAY()+366`
> and this detector still reports 12 / all-clean while annual debt service re-inflates to
> $297,950.51. It tests the schedule **data**; the bug lived in the **formula**.

It also false-fired "13 payments" on 2027-09-30, because `485 S Walnut St` rows 45 and 46 both hold
`2028-09-26` and the draft counted rows rather than distinct dates.

## What the retry should do instead

Independently recompute annual debt service **from the full amortization schedule** and compare it
against the workbook's own `External Loans Summary!J`. Two independent computations cross-checked —
that catches a wrong window, a truncated range, and a wrong column mapping alike, none of which the
count-only shape can see.

Constraints the retry must handle:

- The per-loan `*0.5` Oxford-share multipliers (9050 Red Branch, RCT, 3883 from Oxford).
- The lender-row sign convention (`conditions.ts`).
- `parseLoans()` reads **only** the `Loan Index` sheet — never `External Loans Summary` or any
  amortization schedule — so this needs new sheet access either way.
- Distinct dates, not row counts (the 485 S Walnut duplicate-date case above).
- Gabriel ruled **warn-severity**, not blocking. An error-severity flag here would block legitimate
  refreshes.

## Known defects the retry is the auto-check for

All four are tracked under **OI-092** and **OI-094** — none has its own id. Check the tracker for
current status before acting; the audit below was completed independently by two sessions on
2026-08-05 and the conclusions agree.

- **OI-094 (primary)** — `External Loans Summary!H9`/`I9` sum Banwick over `B11:B70`, but the
  schedule's balloon is row **71** (`2031-06-05`, $3,349,289.87). Audited across all six ranges:
  Banwick is the **only** truncated one; the other five end exactly on their final payment row.
  Bites ~mid-2030.
- **OI-094 finding (a) — 485 S Walnut double-count.** Rows 45 and 46 both carry `2028-09-26`: r45 is
  the final regular payment, r46 the payoff. `H16` sums column `E` over the date predicate and picks
  up **both** rows' $1,365 — the same September interest twice. Bites ~Oct 2027. Small, but it is the
  same over-count shape as OI-092, and it is why the retry must key on **distinct dates, not rows**.
- **OI-094 finding (b) — Restoration Church Trust balloon absent from `I15`.** Rows 35/36/37 all carry
  `2027-02-20`: r35 is the regular payment; r36 holds the full balloon **in column C**
  ($1,945,102.73, D/E empty); r37 holds Oxford's 50% share ($972,551.37, D/E empty). `H15`/`I15` sum
  D/E only, so the balloon contributes **zero** and next-12-month principal return understates
  Oxford's returning capital by $972,551. **Live now** — 2027-02-20 is already inside the window.
  May be intentional (C = total, D/E = the itemized split balloons don't carry); needs Gabriel's read.
- **OI-092 residual — February month-end under-capture.** Month-end anchoring closed the over-capture
  path, not the under-capture one: a February month-end close in the year before a leap year captures
  **11** payments. Simulation over 1,080 cases (120 month-ends × 9 pay-days) found `EDATE(B30,12)`
  leaves **9 deviations** and `EOMONTH(B30,12)` leaves **0** — but `EOMONTH` is catastrophic under a
  manual `B32` override (1,428 deviations). The fix is therefore a **pair**: move the six cells to
  `EOMONTH(Assumptions!$B$30,12)` **and** constrain `B30` to month-end. Latent today (no loan pays
  month-end) but the same cross-check catches it.

Full context: `memory/reference_workbook_annual_debt_service_366day_overcapture.md` and the OI-092
entry (plus its 2026-08-05 CORRECTION) in `memory/open-items-tracker.md`.
