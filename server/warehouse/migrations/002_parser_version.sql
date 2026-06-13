-- 002_parser_version.sql
-- Track which parser/derivation version produced each import's derived columns (basis, period,
-- source_system, ledger). Lets a backfill RE-DERIVE an existing (hash-identical) import IN PLACE when
-- the parser improves, instead of skipping it as a 'duplicate' (ingest dedups on file content hash, so
-- a parser fix otherwise never reaches already-imported files — the stale-served-DB defect).
-- Existing rows default to 0 (pre-versioning) ⇒ they are re-derived on the next backfill once
-- PARSER_VERSION (server/warehouse/parse/qb-excel.ts) is >= 1.
ALTER TABLE import_batches ADD COLUMN parser_version INTEGER NOT NULL DEFAULT 0;
