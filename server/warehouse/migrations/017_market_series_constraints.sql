-- Migration 017: market_series tuple uniqueness.
-- Deferred from PR #117 CR (migration 013 already applied to live DBs).
-- One observation per (cluster, as_of, source, metric); blocks duplicate market reads.
CREATE UNIQUE INDEX IF NOT EXISTS ux_market_series_tuple
  ON market_series (cluster, as_of, source, metric);
