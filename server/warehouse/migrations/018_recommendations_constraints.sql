-- Migration 018: recommendations integrity constraints.
-- Deferred from PR #117 CR (migration 014 already applied to live DBs).
-- SQLite has no ALTER TABLE ADD CONSTRAINT; recreate the table.
-- NO BEGIN/COMMIT here — migrate.ts wraps every migration in db.transaction(); a
-- nested BEGIN throws "cannot start a transaction within a transaction".
ALTER TABLE recommendations RENAME TO recommendations_old;

CREATE TABLE recommendations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id TEXT NOT NULL REFERENCES property_master(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('buy','hold','sell','refinance','improve')),
  expected_return_pct REAL CHECK (expected_return_pct IS NULL OR (expected_return_pct >= -1.0 AND expected_return_pct <= 5.0)),
  risk_band TEXT NOT NULL CHECK (risk_band IN ('low','moderate','elevated','high')),
  timeline_months INTEGER CHECK (timeline_months IS NULL OR timeline_months > 0),
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  inputs_version TEXT NOT NULL,
  advisory_only INTEGER NOT NULL DEFAULT 1,
  reasons_json TEXT NOT NULL DEFAULT '[]',
  as_of TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

INSERT INTO recommendations SELECT * FROM recommendations_old;
DROP TABLE recommendations_old;

CREATE UNIQUE INDEX IF NOT EXISTS ux_recommendations_versioned
  ON recommendations (property_id, as_of, inputs_version);
CREATE INDEX IF NOT EXISTS ix_recommendations_property
  ON recommendations (property_id, as_of);
