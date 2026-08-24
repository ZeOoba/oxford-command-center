-- 028_debt_scores_noi_basis.sql
--
-- 2026-08-24 integrity sweep, Finding 8 (LOW). debt_scores is a PERMANENT append-only trend
-- history (see 027's header for the same doctrine). 9cb6169 (2026-08-22) fixed DSCR/debt-yield
-- to read m.oxfordNoi (ownership-adjusted) instead of m.noi (100%-basis) — a correct fix, in the
-- fail-safe direction — but every row persisted BEFORE that commit carries the old 100%-basis
-- figures with nothing in the row distinguishing "basis correction" from "real deleveraging". A
-- trend reader spanning 2026-08-22 for a fractionally-owned property would see an unexplained
-- ~1/ownershipPct overnight step-change with no row-level marker to explain it.
--
-- No such trend reader exists in the repo today (verified: only writers plus warehouse-verify's
-- schema probe touch this table) — this closes the gap before one ships, rather than waiting for
-- the "unmarked basis/provenance discontinuity in a permanent history table" class to recur a
-- third time (it already did once for book_trust — see 027).
--
-- Existing rows default to '100pct': every row written before this migration IS 100%-basis, by
-- construction — 9cb6169 is the only commit that has ever changed how this table's NOI is
-- derived. New rows are stamped 'oxford-share' by debt-scores-persistence.ts going forward.
ALTER TABLE debt_scores
  ADD COLUMN noi_basis TEXT NOT NULL DEFAULT '100pct'
  CHECK (noi_basis IN ('100pct', 'oxford-share'));
