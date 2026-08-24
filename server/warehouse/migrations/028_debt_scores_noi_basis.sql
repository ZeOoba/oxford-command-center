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
-- CORRECTED 2026-08-24 (PR #302 review): the ADD COLUMN's DEFAULT stamps EVERY existing row
-- '100pct', which is false for the ~2-day window between 9cb6169 landing (2026-08-22) and this
-- migration running -- rows written in that window already used the oxford-share basis, and the
-- blanket default would mislabel them, inverting the exact discontinuity marker this column exists
-- to provide. The UPDATE below corrects that window explicitly. Verified harmless on this
-- environment's live warehouse: debt_scores has 0 rows total, so both the ADD COLUMN default and
-- the UPDATE below touch nothing here -- this is defensive correctness for any OTHER environment
-- where persistDebtScores ran during that window, not a live fix.
ALTER TABLE debt_scores
  ADD COLUMN noi_basis TEXT NOT NULL DEFAULT '100pct'
  CHECK (noi_basis IN ('100pct', 'oxford-share'));

UPDATE debt_scores SET noi_basis = 'oxford-share' WHERE scored_at >= '2026-08-22';
