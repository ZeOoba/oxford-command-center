-- 026_warehouse_meta.sql
-- Small key-value side table for warehouse-internal state markers. First consumer: the debt
-- snapshot refusal marker (obs-3 / PR #233 residual #2). Both adversarial reviews on PR #233
-- flagged that a shrinkage-guard refusal on the AUTOMATED reload path left only a console.warn:
-- the stale prior debt book kept feeding computePortfolioAggregateLtv, which had no way to tell
-- "a write was refused, this book is frozen" from "healthy" — so a book frozen at a pre-refi
-- state could keep reporting clearedConservatively=true indefinitely. writeDebtSnapshot now
-- persists its refusal here (and clears it on any non-refused write); the aggregate reads it and
-- refuses to issue a verdict while it is set.
CREATE TABLE IF NOT EXISTS warehouse_meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
