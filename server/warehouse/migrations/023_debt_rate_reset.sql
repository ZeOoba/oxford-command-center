-- 023_debt_rate_reset.sql
-- Debt & Maturity module v1 (see server/warehouse/debt-maturity.DESIGN.md): additive
-- rate-structure columns on debt_positions for the maturity/reset timeline.
--   rate_type       — free-form workbook text ("Fixed", "Floating", ...), nullable.
--   next_rate_reset — ISO date of the next scheduled rate reset, when applicable, nullable.
-- CONFIRMED 2026-07-19 (direct workbook inspection, not a guess): NEITHER Loan Index NOR
-- External Loans Summary (its live source -- Loan Index row 2: "All metrics are live from
-- External Loans Summary") has a rate-type or rate-reset-date column. Full header scan of
-- both sheets (Loan Index A:K, External Loans Summary A:AL) found exactly one rate field
-- anywhere: "Annual Rate". No structure/type field, no reset-date field exists in the
-- Master Workbook today. Both columns stay NULL for that reason, not an unresolved mapping
-- -- writeDebtSnapshot() has nothing to map. Populating them requires either a new workbook
-- column (Gabriel-added) or a different source (loan docs/term sheets). The timeline emits
-- no rate-reset events while they are NULL (Hard Invariant 7: never guess firm figures).
-- CONFIDENTIALITY: same posture as 009 — raw terms never cross the route boundary; the
-- timeline emits dates + rate STRUCTURE only (no rate values, balances, or lender names).
ALTER TABLE debt_positions ADD COLUMN rate_type TEXT;
ALTER TABLE debt_positions ADD COLUMN next_rate_reset TEXT;
CREATE INDEX IF NOT EXISTS idx_debt_rate_reset ON debt_positions(next_rate_reset, status);
