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

It also false-fired "13 payments" on 2027-09-30, because `100 Note Party St` rows 45 and 46 both hold
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
- Distinct dates, not row counts (OI-096, resolved — see below — but the pattern recurs).
- Gabriel ruled **warn-severity**, not blocking. An error-severity flag here would block legitimate
  refreshes.
- **Expect balloon-inclusive, forward-looking principal on EVERY lender row** — see OI-095 below. A
  lender row whose principal excludes a contractually-due balloon should be flagged as WRONG, not
  treated as acceptable variance.

## Status as of 2026-08-05 (end of day) — check the tracker before trusting this table

Everything below landed the same day this draft was withdrawn. **`memory/open-items-tracker.md` is
authoritative — this table is a snapshot, not a live source.**

| id | what | status |
|---|---|---|
| OI-092 | window `+366` over-capture | RESOLVED — workbook fixed |
| OI-092 | February month-end under-capture | RESOLVED — `EOMONTH(B30,12)` + `B30` month-end pair applied |
| OI-092 | detector (this draft) | WITHDRAWN, rebuild queued (this doc) |
| OI-094 | Banwick range truncated at row 70, balloon at 71 | RESOLVED — extended to `B11:B71` |
| OI-095 | RCT balloon absent from `I15` | RESOLVED — **INCLUDED**, not excluded. Root cause was not a design choice: `I14`/`I15`/`I16` computed principal on three inconsistent bases (paid-to-date vs. forward-looking); all three fixed to one consistent forward basis. An earlier same-day ruling called the exclusion intentional — that was superseded within the day; do not build against it. |
| OI-096 | 100 Note Party St double-counts $REDACTED-AMT (rows 45/46 both `2028-09-26`) | RESOLVED — r46 corrected to a pure balloon (`D`=252,000, `E`=0); TOTALS reconciled |

Detail on each, including exact formula text and verification numbers, is in the tracker entries and in
`memory/reference_workbook_annual_debt_service_366day_overcapture.md`.

**What this means for the retry:** every known defect this draft was meant to catch has already been
fixed by hand in the workbook. The detector is no longer urgent — it is insurance against a *future*
recurrence of the same shapes (wrong window, truncated range, inconsistent basis, duplicate dates), not
a fix for a currently-live defect. Build it against the corrected workbook as ground truth.
