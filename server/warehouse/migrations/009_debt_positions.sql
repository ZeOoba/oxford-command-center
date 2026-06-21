-- 009_debt_positions.sql
-- Warehouse snapshot of ORA borrower-side debt positions.
-- Source: Spine A master workbook "Loan Index" / "External Loans Summary" tabs, ingested
-- via a periodic snapshot write (not a live QB feed). Lender-side (Oxford as lender) and
-- internal intercompany rows are EXCLUDED — the scoring engine scores obligations, not assets.
-- CONFIDENTIALITY: loan terms (rate, balance, lender name) are sensitive — the snapshot table
-- is NOT exposed via the public /api/warehouse/* routes directly; the debt-score routes emit
-- derived signals only (signal, headroom, band). Raw loan rows are read-only at the server
-- layer and never reach the client as raw terms.
CREATE TABLE IF NOT EXISTS debt_positions (
  id                   TEXT NOT NULL,
  snapshot_date        TEXT NOT NULL,
  property_id          TEXT REFERENCES property_master(id),
  loan_name            TEXT NOT NULL,
  lender               TEXT,
  original_principal   REAL,
  current_balance      REAL NOT NULL,
  rate                 REAL,
  loan_type            TEXT,
  monthly_pmt          REAL,
  annual_interest      REAL,
  annual_principal     REAL,
  is_demand            INTEGER NOT NULL DEFAULT 0,
  maturity_date        TEXT,
  months_to_maturity   REAL,
  ltv                  REAL,
  balloon              INTEGER NOT NULL DEFAULT 0,
  status               TEXT NOT NULL DEFAULT 'active',
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  PRIMARY KEY (id, snapshot_date)
);
CREATE INDEX IF NOT EXISTS idx_debt_property ON debt_positions(property_id, status);
CREATE INDEX IF NOT EXISTS idx_debt_maturity ON debt_positions(maturity_date, status);
