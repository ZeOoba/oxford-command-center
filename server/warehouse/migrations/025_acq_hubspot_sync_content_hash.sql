-- 025_acq_hubspot_sync_content_hash.sql
-- syncHubSpotPipeline()'s UPDATE previously stamped updated_at=datetime('now') on EVERY
-- HubSpot sync run, whether or not the deal's address/status actually changed (same anti-pattern
-- as migration 024's property_master fix). That makes acq_candidates.updated_at a batch-sync
-- signature for HubSpot-sourced rows, not a real edit-tracking column. content_hash lets the
-- upsert detect whether a deal's synced data actually changed and only then bump updated_at.
ALTER TABLE acq_candidates ADD COLUMN content_hash TEXT;
