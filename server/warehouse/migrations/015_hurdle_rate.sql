ALTER TABLE capital_config ADD COLUMN hurdle_rate_pct REAL NOT NULL DEFAULT 0.08;
ALTER TABLE capital_config ADD COLUMN hurdle_rate_ratification TEXT NOT NULL DEFAULT 'proposed';
ALTER TABLE capital_config ADD COLUMN hurdle_rate_ratified_by TEXT;
ALTER TABLE capital_config ADD COLUMN hurdle_rate_ratified_date TEXT;
