-- 017_ratify_hurdle_rate.sql
-- Stamps the hurdle-rate ratification on the live capital_config row.
-- Migration 015 added hurdle_rate_ratification with DEFAULT 'proposed'.
-- Gabriel ratified the 8% unlevered IRR governor on 2026-06-22; this migration
-- promotes the status to 'ratified' so the engine's advisoryOnly flag clears.
UPDATE capital_config
SET hurdle_rate_ratification  = 'ratified',
    hurdle_rate_ratified_by   = 'Gabriel Goldberg',
    hurdle_rate_ratified_date = '2026-06-22'
WHERE version = (SELECT MAX(version) FROM capital_config);
