# OI-092 family — state of play and remaining work

**Written 2026-08-05, end of session `3d9d97cf`.** Several sessions worked these items in parallel and
the tracker moved three times during the session. **`memory/open-items-tracker.md` (OI-092 … OI-097) is
authoritative — re-verify against it before acting on anything below.**

---

## DONE — do not redo

| item | outcome |
|---|---|
| **OI-092** window defect | Fixed. `[TODAY(), TODAY()+366)` → `(Assumptions!$B$30, EOMONTH(Assumptions!$B$30,12)]` on all six cells. Zero `TODAY()+366` remain. |
| **OI-092** February pair fix | Landed with the above: `B30` = `IF(B31="Auto (current month-end)",EOMONTH(TODAY(),0),IF(ISNUMBER(B32),EOMONTH(B32,0),EOMONTH(TODAY(),0)))`. |
| **OI-094** Banwick truncation | Fixed. Ranges extended `B11:B70` → `B11:B71`, capturing the 2031-06-05 balloon. `J9` (annual) and `Loan Index!F9` (monthly) now match Firm 03 loan 11153's own schedule. |
| Six-range audit | Complete, run independently by two sessions with identical conclusions. Banwick was the only truncated range. |
| Warehouse contamination | None. `debt_positions` was clean — all 8 snapshot dates fell on non-payment days. Nothing backfilled. |
| Snapshot remediation | `61cc346` → `51d4039` → `63992e0` → `f269986`, all pushed. |
| **OI-095** RCT balloon | **CLOSED — no change.** See ruling below. |

### Verification of the landed fix (2026-08-05, against the live workbook)

```
H9 = SUMPRODUCT(('Banwick-Morrison'!B11:B71>Assumptions!$B$30)
               *('Banwick-Morrison'!B11:B71<=EOMONTH(Assumptions!$B$30,12))
               *'Banwick-Morrison'!D11:D71)
```
All of `H6:I9`, `H15:I15`, `H16` use `EOMONTH(Assumptions!$B$30,12)`. `B33` reports
`✅ CURRENT — August 2026 close is live`.

---

## Gabriel's rulings, 2026-08-05 — encode these, don't re-litigate

1. **OI-095 — RCT balloon exclusion is INTENTIONAL. Closed.** `C` is the total payment; `D`/`E` are the
   itemized split that balloon rows legitimately do not carry. "Annual debt service" means recurring
   P&I only.
2. **The 3540-vs-RCT asymmetry is principled, not accidental.** 3540 is a **borrower** loan — its
   balloon is cash Oxford must pay, so it belongs in debt service. RCT is a **lender** loan — its
   balloon is capital returning to Oxford, so it does not. Both sheets are correct as they stand.
   **Do not "harmonize" them.** (This session initially called it an accidental inconsistency; that
   was wrong.)
3. **OI-096 — correct the schedule rows at source**, not the formula. See below.
4. **OI-093 — create the Northwood journal sheet, but chase the provenance first. Do NOT alias the id.**
5. **Detector rebuild — queued**, not urgent. New session, worktree, warn-severity.
6. **Push policy — standing approval** for commits touching only `data/snapshots/**` and `docs/**`.
   Anything touching server/src code, migrations, hooks, or config still asks first.

---

## OPEN 1 — OI-096, 100 Note Party St duplicate-date over-count  [ruled; needs the edit]

Rows 45 and 46 both carry `2028-09-26` (amounts below are illustrative, not the real amounts):

```
r45  2028-09-26   D=1,250      E=1,250   F=200,000   <- final regular payment
r46  2028-09-26   D=201,250    E=1,250   F=0         <- payoff (200,000 principal + 1,250 interest)
```
(Amounts illustrative; the row shape is the real one.)

`H16` sums column `E` over the date predicate and picks up **both** rows' interest — the same September
interest twice. Bites when 2028-09-26 enters the forward window, ~Oct 2027. Direction is
over-statement, so it is the safe side of the 1.25x DSCR floor; magnitude one month's interest.

**Ruling: fix at source.** r46's payoff already contains the September interest that r45 also reports,
so one of the two must stop reporting it in column `E`. Verify the payoff total and the remaining
balance still reconcile after the edit. Workbook edit → **Hard Invariant 4 → confirm before touching.**

This also clears the duplicate-date landmine that made the withdrawn detector false-fire "13 payments"
dated 2027-09-30.

## OPEN 2 — OI-093, Northwood journal sheet  [ruled; needs provenance work first]

The parser emits `⚠ NO JOURNAL SHEET` for the internal 2203-2207 Northwood loan, changing its snapshot
id and splitting its `debt_positions` history (`ON CONFLICT(id, snapshot_date)`).

A full 50-sheet enumeration confirms **the sheet does not exist in any spelling**. The parser marker is
**correct and reporting a real accounting gap** — aliasing the id would hide a missing accounting
record. An earlier decision to alias was reversed on exactly this point.

**Chase provenance first.** The workbook's `Claude Log` Turn 144 (2026-08-03) states the sheet *was
created* during the EXTERNAL→INTERNAL reclassification. It is not there. Either that step never
completed, or it was created and later removed — and those imply different things about whether the
**rest** of that reclassification landed. Establish which, then create the sheet.

Existing internal-loan journals, for naming reference: `NOTE PARTY 05`, `NOTE PARTY 06`,
`3883 from Oxford & NOTE PARTY 08`, `1100 From Fenton`, `Note Party 04+ NOTEPARTY08`,
`Note Party 07`.

## OPEN 3 — Detector rebuild  [queued, unblocked]

**Read `withdrawn-detector-oi092/README.md` before designing anything.** The first attempt counted
payment rows in a window and was withdrawn because that cannot detect the defect — it computes its own
correct window and never reads the formula that carried the bug.

**Correct design:** independently recompute annual debt service from the FULL amortization schedule and
cross-check against the workbook's own `'External Loans Summary'!J`. Two independent computations
compared — catches a wrong window, a truncated range, and wrong column mapping alike.

Hard constraints:
- Key on **distinct dates, not row counts** (OI-096's duplicate pair is the false-fire case).
- Handle the per-loan `*0.5` Oxford-share multipliers (9050 Red Branch, RCT, 3883 from Oxford).
- Handle the lender-row sign convention (`src/analytics/conditions.ts`).
- **Must not flag balloon-excluded principal on lender rows** — ruling 1 above. Encode the ruling, not
  the raw arithmetic, or it fires permanently on RCT.
- `parseLoans()` reads **only** `Loan Index` — never `External Loans Summary` or any schedule — so this
  needs new sheet access either way.
- Do **not** build test dates with `Date.UTC(y,m,day)`; it overflows instead of clamping, so 29th/30th/
  31st payer cases silently go untested. That defect sank the first draft.
- **Salvageable:** `edateMonths` was differentially verified against Excel EDATE semantics over
  1990–2060, 0 mismatches.

Warn-severity, not blocking.

## OPEN 4 — Morrison 386 (not a code task)

A tenant took only the 388 half (1,800 SF); the remaining 1,800 SF at 386 has **no lease row at
all** in `portfolio.json` — it left the rent roll rather than appearing as vacant. Occupancy math is
unaffected (Sepich Portfolio property SF is the denominator, so the space correctly reads as unleased);
what is missing is unit-level visibility of which space is dark.

Gabriel approved flagging it to the property manager. **Nothing has been drafted or sent** — outbound
counterparty communication (Hard Invariant 1) and there is no PM on record for Morrison/Sepich
(`people.md` lists only Brady Smith, SVN, who covers Northwood and E. Fulton). Awaiting the recipient.

---

## Guardrails

- **Hard Invariant 4** — no financial-model or governor-constant edits without permission. DSCR (1.25x)
  and LTV (40% aggregate / 65% per-property) are governors; this work touches DSCR inputs.
- **Hard Invariant 5** — the workbook is in a non-Claude Oxford OneDrive business folder. Read freely;
  writing needs permission.
- **Done bar** — financial-decision code: TDD, typecheck 0, lint 0, full suite green, independent local
  review, **plus a mandatory adversarial REFUTE pass**, evidence before any "done" claim.
- **Shared checkouts** — claim before editing:
  `python hooks/lib/claim_work.py claim <slug> "<why>" --paths <file>`. Several sessions run
  concurrently; this session collided twice in one afternoon by acting on state that had already moved.
  **Re-read before writing, not just before deciding.**
- **Allocate OI ids** — `python ~/.claude/maintenance/allocate-oi-id.py --session $CLAUDE_CODE_SESSION_ID
  --note "<why>"`. Never hand-compute.
- **Tracker table** — the summary table and the detail sections are separated by a blank line. Inserting
  rows after that blank line splits the table into two and orphans the new rows. Insert **before** it.
- **Excel-lock read recipe** — the live workbook is usually locked (`Errno 13 Permission denied` from
  `mcp__excel__*`). Copy to scratchpad and read the copy. Formulas need
  `openpyxl.load_workbook(data_only=False)`; array formulas are `ArrayFormula` objects, read `.text`.
  Set `PYTHONIOENCODING=utf-8` — the workbook is full of `│ ⚠ ▼ ★` and cp1252 throws.

## Reading

- `memory/open-items-tracker.md` — OI-092 … OI-097. **Authoritative.**
- `memory/reference_workbook_annual_debt_service_366day_overcapture.md` — diagnosis, ground truth.
- `docs/superpowers/plans/withdrawn-detector-oi092/README.md` — why the first detector failed.
- Notion run report: https://app.notion.com/p/3b36ecd89e5981b6b0b4f0e4b125adbd
