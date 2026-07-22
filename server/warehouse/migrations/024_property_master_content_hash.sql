-- 024_property_master_content_hash.sql
-- seedPropertyMaster() previously stamped updated_at=datetime('now') on EVERY row on EVERY backfill
-- run, whether or not the row's data actually changed (the ON CONFLICT clause always set it). That
-- makes updated_at a batch-sync signature, not a real edit-tracking column: a full reseed with zero
-- real changes produces the exact same flat timestamp across all rows as a genuine "nothing edited"
-- state, and the two are indistinguishable downstream. content_hash lets the upsert detect whether a
-- row's data actually changed and only then bump updated_at (mirrors the inputs_version pattern in
-- 007_acq_candidates.sql / acq_score_inputs and calibration.ts's configHash).
ALTER TABLE property_master ADD COLUMN content_hash TEXT;
