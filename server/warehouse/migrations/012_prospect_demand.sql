-- 012_prospect_demand.sql — Prospect Demand Intelligence foundation (Direction 3).
--
-- External demand signals on portfolio properties: broker showings, inquiries, LOI
-- activity, tours, and follow-ups. This is the schema foundation; today it is populated
-- by a manual-entry API (source='manual'). When the Outlook ingest pipeline ships it will
-- write the SAME table with source='outlook' — no schema change needed.
--
-- ADDITIVE ONLY: new table + indexes; no DROP/ALTER of any existing table. Safe for the
-- 32-file warehouse:verify ingest (it touches no other table).
CREATE TABLE IF NOT EXISTS prospect_demand_events (
  id          TEXT PRIMARY KEY,                          -- UUID
  property_id TEXT NOT NULL,                              -- matches Property.id slug (e.g. 'my-property-columbus-oh')
  event_type  TEXT NOT NULL                              -- demand signal kind
                CHECK (event_type IN ('showing','inquiry','loi','tour','follow_up')),
  event_date  TEXT NOT NULL,                             -- ISO date YYYY-MM-DD
  contact     TEXT,                                      -- broker/prospect name (nullable)
  company     TEXT,                                      -- company/firm name (nullable)
  sf_interest INTEGER,                                   -- SF they're interested in (nullable)
  notes       TEXT,                                      -- free text (nullable)
  source      TEXT NOT NULL DEFAULT 'manual'             -- 'manual' today; 'outlook' (future pipeline)
                CHECK (source IN ('manual','outlook')),
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pde_property ON prospect_demand_events(property_id);
CREATE INDEX IF NOT EXISTS idx_pde_date ON prospect_demand_events(event_date DESC);
