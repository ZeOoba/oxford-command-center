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
> $REDACTED-AMT. It tests the schedule **data**; the bug lived in the **formula**.

It also false-fired "13 payments" on 2027-09-30, because `REDACTED-457` rows 45 and 46 both hold
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
- Distinct dates, not row counts (the REDACTED-554 duplicate-date case above).
- Gabriel ruled **warn-severity**, not blocking. An error-severity flag here would block legitimate
  refreshes.

## Known defects the retry is the auto-check for

- **OI-094** — `External Loans Summary!H9`/`I9` sum Banwick over `B11:B70`, but the schedule's
  balloon is row **71** (`2031-06-05`, $3,349,289.87). Audited 2026-08-05: Banwick is the **only**
  truncated range of the six; the other five end exactly on their final payment row.
- **OI-095** — REDACTED-306's balloon rows (36–37) are *inside* the range but carry
  their amount only in column C; `H15`/`I15` sum columns D/E, which are blank there, so the
  $972,551.37 balloon due 2027-02-20 contributes zero. Live now, not deferred.
- **Feb month-end under-capture (OI-096)** — month-end anchoring closed over-capture but not
  under-capture; a February month-end close in the year before a leap year captures 11 payments.
  Latent (no current loan pays month-end) but the same cross-check catches it.

Full context: `memory/reference_workbook_annual_debt_service_366day_overcapture.md` and the OI-092
entry (plus its 2026-08-05 CORRECTION) in `memory/open-items-tracker.md`.
