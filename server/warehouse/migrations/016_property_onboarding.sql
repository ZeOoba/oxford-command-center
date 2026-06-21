CREATE TABLE IF NOT EXISTS property_onboarding (
  property_id TEXT PRIMARY KEY REFERENCES property_master(id),
  aliases_json TEXT NOT NULL DEFAULT '[]',
  pm_system TEXT NOT NULL CHECK (pm_system IN ('quickbooks','yardi','appfolio','rent-manager')),
  authoritative_source TEXT NOT NULL CHECK (authoritative_source IN ('pm-exports','internal-quickbooks','workbook-only')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
