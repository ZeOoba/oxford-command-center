-- 023_debt_rate_reset.sql
-- Debt & Maturity module v1 (see server/warehouse/debt-maturity.DESIGN.md): additive
-- rate-structure columns on debt_positions for the maturity/reset timeline.
--   rate_type       — free-form workbook text ("Fixed", "Floating", ...), nullable.
--   next_rate_reset — ISO date of the next scheduled rate reset, when applicable, nullable.
-- Both remain NULL until the workbook Loan Index column mapping for rate structure is
-- confirmed by Gabriel — writeDebtSnapshot() deliberately does not populate them yet
-- (Hard Invariant 7: never guess firm figures). The timeline simply emits no rate-reset
-- events while they are NULL.
-- CONFIDENTIALITY: same posture as 009 — raw terms never cross the route boundary; the
-- timeline emits dates + rate STRUCTURE only (no rate values, balances, or lender names).
ALTER TABLE debt_positions ADD COLUMN rate_type TEXT;
ALTER TABLE debt_positions ADD COLUMN next_rate_reset TEXT;
CREATE INDEX IF NOT EXISTS idx_debt_rate_reset ON debt_positions(next_rate_reset, status);
