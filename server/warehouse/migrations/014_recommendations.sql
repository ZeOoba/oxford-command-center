CREATE TABLE IF NOT EXISTS recommendations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('buy','hold','sell','refinance','improve')),
  expected_return_pct REAL,
  risk_band TEXT NOT NULL CHECK (risk_band IN ('low','moderate','elevated','high')),
  timeline_months INTEGER,
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  inputs_version TEXT NOT NULL,
  advisory_only INTEGER NOT NULL DEFAULT 1,
  reasons_json TEXT NOT NULL DEFAULT '[]',
  as_of TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS ix_recommendations_property ON recommendations (property_id, as_of);
